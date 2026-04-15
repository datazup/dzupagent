# @dzupagent/cache Architecture

This document describes the **current implementation** of `packages/cache`:
- architecture and module responsibilities
- feature set and behavior semantics
- practical usage patterns and integration guidance

Scope is based on code in `packages/cache/src/**` and tests in `packages/cache/src/__tests__/**`.

## 1) Purpose and Design Goals

`@dzupagent/cache` provides a lightweight, policy-driven cache layer for LLM responses.

Core goals of the current implementation:
- Keep caching decisions explicit via a `CachePolicy`
- Generate deterministic request keys
- Allow pluggable storage backends (in-memory or Redis)
- Make caching best-effort so cache failures do not break LLM execution flows
- Expose basic observability through hit/miss callbacks and stats

## 2) High-Level Architecture

The package is split into three layers:

1. **Orchestration layer** (`CacheMiddleware`)
- Applies cacheability policy
- Computes keys
- Reads/writes `CacheEntry` payloads
- Triggers optional callbacks
- Delegates storage to backend

2. **Key derivation layer** (`generateCacheKey`)
- Produces deterministic SHA-256 keys from normalized request fields
- Supports optional namespace prefixing

3. **Storage layer** (`CacheBackend` implementations)
- `InMemoryCacheBackend`: process-local Map with TTL + LRU
- `RedisCacheBackend`: ioredis-compatible backend with optional key prefixing

Request flow (`get` then `set`) in typical usage:

```text
LLM request
  -> CacheMiddleware.isCacheable(request)
      -> false: bypass cache
      -> true:
          key = generateCacheKey(request, policy.namespace)
          raw = backend.get(key)
          -> miss/error/invalid JSON: return null (onMiss)
          -> hit: parse CacheEntry and return response (onHit)

On miss:
  call LLM
  CacheMiddleware.set(request, response)
    -> isCacheable check
    -> key generation
    -> CacheEntry serialization
    -> backend.set(key, serializedEntry, defaultTtlSeconds)
```

## 3) Module Map

- `src/index.ts`
  - Public exports (types, middleware, key generator, backends)
- `src/types.ts`
  - Core contracts (`CacheBackend`, `CachePolicy`, `CacheableRequest`, etc.)
- `src/key-generator.ts`
  - Deterministic key generation
- `src/middleware.ts`
  - Policy-aware orchestration class
- `src/backends/in-memory.ts`
  - In-memory backend (LRU + TTL)
- `src/backends/redis.ts`
  - Redis backend (prefixing + scan-based clear)

## 4) Public API Surface

### Exports

```ts
export type {
  CacheBackend,
  CachePolicy,
  CacheableRequest,
  CacheStats,
  CacheMiddlewareConfig,
  CacheEntry,
}
export { generateCacheKey }
export { InMemoryCacheBackend }
export { RedisCacheBackend }
export { CacheMiddleware }
```

### Core Types

#### `CacheBackend`
Storage contract every backend must implement:

```ts
interface CacheBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<CacheStats>
}
```

#### `CachePolicy`
Controls cacheability and TTL defaults:
- `maxTemperature: number`
- `defaultTtlSeconds: number`
- `namespace?: string`
- `isCacheable?: (request) => boolean`

#### `CacheableRequest`
Minimum request shape used by middleware and keying:
- `messages: Array<{ role: string; content: string }>`
- `model: string`
- `temperature?: number`
- `maxTokens?: number`
- additional properties allowed (`[key: string]: unknown`)

#### `CacheEntry`
Serialized payload written to backend:
- `response: string`
- `model: string`
- `cachedAt: number` (epoch ms)
- `ttl: number` (seconds)

#### `CacheStats`
- `hits: number`
- `misses: number`
- `size: number`
- `hitRate: number`

## 5) Feature Catalog (Current Behavior)

### 5.1 Policy-Based Cacheability

Implemented in `CacheMiddleware.isCacheable(request)`.

Decision order:
1. If `policy.isCacheable` exists, its return value is authoritative.
2. Otherwise, default behavior is temperature gating:
   - `temperature = request.temperature ?? 1`
   - cacheable iff `temperature <= policy.maxTemperature`

Implication: requests with omitted `temperature` are treated as `1` by default gate.

### 5.2 Deterministic Key Generation

`generateCacheKey(request, namespace?)` hashes this normalized object:

```ts
{
  messages: request.messages.map(m => `${m.role}:${m.content}`),
  model: request.model,
  temperature: request.temperature ?? 0,
  maxTokens: request.maxTokens,
}
```

Then returns:
- `llm:<sha256>` when `namespace` is not provided
- `<namespace>:llm:<sha256>` when provided

Notes:
- Key generation ignores additional request fields beyond the four above.
- Message order and role/content values affect the key.

### 5.3 Namespace Isolation

Two independent isolation mechanisms exist:

1. Middleware-level namespace (`CachePolicy.namespace`)
- Included directly in generated cache keys
- Intended for tenant/environment separation at key level

2. Redis backend prefix (`RedisCacheBackend` option `prefix`)
- Prepended to every key before Redis read/write/delete
- Useful for service-level or deployment-level partitioning

Both can be used together:
- Example final Redis key shape: `<prefix>:<namespace>:llm:<hash>`

### 5.4 Best-Effort Reliability

The package intentionally swallows backend errors in critical paths:
- `CacheMiddleware.get`: backend or parse failures become cache miss
- `CacheMiddleware.set`: write failures are ignored
- `RedisCacheBackend.set/delete/clear`: failures ignored

This ensures cache outages do not block request processing.

### 5.5 Observability Hooks

`CacheMiddlewareConfig` supports:
- `onHit(key, model)`
- `onMiss(key, model)`

Triggered by `get` path:
- `onMiss` when backend returns `null` or when read/parse throws
- `onHit` when a valid cached entry is read and parsed

### 5.6 In-Memory Backend: TTL + LRU

`InMemoryCacheBackend` details:
- Stores entries in `Map<string, { value, expiresAt }>`
- `maxEntries` default: `1000`
- TTL:
  - `set` with `ttlSeconds` sets `expiresAt = now + ttlSeconds * 1000`
  - missing TTL means `expiresAt = 0` (never expire)
- LRU behavior:
  - `get` refreshes key recency by delete+set
  - `set` on existing key refreshes recency
  - when full, evicts oldest key (`Map.keys().next().value`)

### 5.7 Redis Backend: Prefixing + SCAN Clear

`RedisCacheBackend` accepts an ioredis-compatible client with methods:
- `get`, overloaded `set`, `del`, `scan`

Behavior:
- Optional `prefix` applied consistently for get/set/delete
- TTL writes use `SET key value EX <seconds>` when `ttlSeconds > 0`
- `clear` loops with `SCAN cursor MATCH <pattern> COUNT 100` and deletes batches
- `stats().size` is `-1` (unknown by design)

## 6) Middleware Method Semantics

### `isCacheable(request): boolean`
- Fast synchronous policy decision
- Uses custom predicate if defined

### `get(request): Promise<string | null>`
- Returns `null` immediately when request is non-cacheable
- Otherwise:
  - builds key via namespace-aware generator
  - backend lookup
  - parse JSON into `CacheEntry`
  - returns `entry.response` on hit
- Any exception (backend or parse) returns `null`

### `set(request, response): Promise<void>`
- No-op when request is non-cacheable
- Stores JSON-serialized `CacheEntry` with policy TTL

### `stats(): Promise<CacheStats>`
- Directly delegates to backend

## 7) Backend Stats Semantics

### In-memory stats
- `hits` and `misses` increment on `get`
- `stats()` purges expired keys before computing `size`
- `hitRate = hits / (hits + misses)`; `0` when denominator is `0`

### Redis stats
- `hits` and `misses` are internal counters in backend wrapper
- `size = -1` (not computed from Redis)
- `clear()` resets hit/miss counters

## 8) How to Use the Code

### 8.1 Install

```bash
yarn add @dzupagent/cache
# Optional for Redis backend
yarn add ioredis
```

### 8.2 Minimal In-Memory Integration

```ts
import { CacheMiddleware, InMemoryCacheBackend } from '@dzupagent/cache'

const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend({ maxEntries: 1000 }),
  policy: {
    maxTemperature: 0.3,
    defaultTtlSeconds: 3600,
    namespace: 'prod',
  },
})

export async function invokeWithCache(request: {
  messages: Array<{ role: string; content: string }>
  model: string
  temperature?: number
  maxTokens?: number
}) {
  const cached = await cache.get(request)
  if (cached) return cached

  const fresh = await llm.invoke(request)
  await cache.set(request, fresh)
  return fresh
}
```

### 8.3 Custom Cacheability Rules

Use `policy.isCacheable` to override temperature-only gating:

```ts
const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend(),
  policy: {
    maxTemperature: 1,
    defaultTtlSeconds: 900,
    isCacheable: (req) => {
      const text = req.messages.map(m => m.content).join('\n')
      return req.model.startsWith('gpt-') && text.length < 8_000
    },
  },
})
```

### 8.4 Redis for Multi-Instance Deployments

```ts
import Redis from 'ioredis'
import { CacheMiddleware, RedisCacheBackend } from '@dzupagent/cache'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

const cache = new CacheMiddleware({
  backend: new RedisCacheBackend(redis, { prefix: 'dzupagent:cache' }),
  policy: {
    maxTemperature: 0.3,
    defaultTtlSeconds: 3600,
    namespace: 'tenant-a',
  },
})
```

### 8.5 Observability Hooks

```ts
const cache = new CacheMiddleware({
  backend: new InMemoryCacheBackend(),
  policy: { maxTemperature: 0.3, defaultTtlSeconds: 3600 },
  onHit: (key, model) => metrics.increment('cache.hit', { key, model }),
  onMiss: (key, model) => metrics.increment('cache.miss', { key, model }),
})
```

### 8.6 Request-Level Invalidation (Current Pattern)

`CacheMiddleware` currently does not expose `delete(request)`.
Use `generateCacheKey` + backend delete:

```ts
import { generateCacheKey } from '@dzupagent/cache'

const key = generateCacheKey(request, cacheNamespace)
await backend.delete(key)
```

### 8.7 Manual Clear

```ts
await backend.clear()
```

Operational note for Redis backend:
- if `prefix` is set, `clear()` scans/deletes only matching prefixed keys
- if `prefix` is empty, `clear()` scans pattern `*` and can delete all keys reachable by the client

## 9) Choosing the Right Backend

Use `InMemoryCacheBackend` when:
- single process / local dev / tests
- low operational complexity is priority

Use `RedisCacheBackend` when:
- multiple app instances need shared cache
- cache continuity across process restarts is required

## 10) Practical Guidance and Gotchas

- Set `temperature` explicitly on requests when possible for predictable cacheability.
- Remember normalization difference:
  - middleware cacheability default for missing temperature is `1`
  - key generator default for missing temperature is `0`
- Keep namespace strategy consistent across services to avoid accidental misses/hits.
- In Redis, always set a `prefix` when using `clear()` in shared environments.
- Treat cache as optimization: application logic should remain correct on misses.

## 11) Related Tests and Feature Coverage

Latest local verification (2026-04-03):
- Command: `yarn workspace @dzupagent/cache test`
- Result: 5/5 test files passing, 69/69 tests passing

### 11.1 Feature-to-Test Traceability

#### Key generation (deterministic hashing and namespace support)
- `src/__tests__/key-generator.test.ts`
  - `produces a deterministic key for identical requests`
  - `returns different keys for different messages`
  - `returns different keys for different models`
  - `returns different keys for different temperatures`
  - `returns different keys for different maxTokens`
  - `treats undefined temperature as 0`
  - `prefixes with "llm:" when no namespace is given`
  - `prefixes with namespace when provided`
  - `different namespaces yield different keys for same request`
  - `produces a valid SHA-256 hex digest (64 chars)`
  - `is stable across multiple message entries`
  - `differentiates message role from content`
  - `ignores extra properties on the request`
- `src/__tests__/cache-middleware.test.ts`
  - `generateCacheKey is deterministic for equivalent requests`

#### Middleware policy and orchestration
- `src/__tests__/cache-middleware.test.ts`
  - `stores and retrieves cacheable requests`
  - `does not cache requests above maxTemperature`
  - `invokes onHit and onMiss callbacks`
- `src/__tests__/middleware-advanced.test.ts`
  - `isCacheable returns true when temperature <= maxTemperature`
  - `isCacheable returns false when temperature > maxTemperature`
  - `isCacheable treats undefined temperature as 1 (not cacheable by default)`
  - `isCacheable uses custom isCacheable when provided`
  - `set does nothing for non-cacheable requests`
  - `get returns null for non-cacheable requests without hitting backend`
  - `stores a proper CacheEntry JSON with model and cachedAt`
  - `uses policy defaultTtlSeconds when storing entries`
  - `stats delegates to the backend`

#### Namespace isolation behavior
- `src/__tests__/middleware-advanced.test.ts`
  - `namespace isolates cache entries`
- `src/__tests__/key-generator.test.ts`
  - `prefixes with namespace when provided`
  - `different namespaces yield different keys for same request`

#### Observability callbacks (onHit/onMiss)
- `src/__tests__/cache-middleware.test.ts`
  - `invokes onHit and onMiss callbacks`
- `src/__tests__/middleware-advanced.test.ts`
  - `onMiss fires with correct key and model on cache miss`
  - `onHit fires with correct key and model on cache hit`
  - `onMiss fires when backend get returns parse-invalid JSON`

#### Best-effort error handling
- `src/__tests__/middleware-advanced.test.ts`
  - `get returns null when backend throws`
  - `set does not throw when backend throws`
- `src/__tests__/redis-backend.test.ts`
  - `get returns null and counts miss on client error`
  - `set does not throw on client error`
  - `delete does not throw on client error`
  - `clear does not throw on client error`

#### In-memory backend (TTL, LRU, CRUD, stats)
- `src/__tests__/in-memory-backend.test.ts`
  - CRUD:
    - `returns null for a missing key`
    - `stores and retrieves a value`
    - `overwrites an existing key`
    - `deletes a key`
    - `delete on nonexistent key does not throw`
    - `clear removes all entries and resets stats`
  - TTL:
    - `returns value before TTL expires`
    - `returns null after TTL expires`
    - `items without TTL never expire`
    - `expired entries count as misses`
    - `stats purges expired entries from size count`
  - LRU:
    - `evicts the oldest entry when maxEntries is reached`
    - `accessing a key refreshes its LRU position`
    - `overwriting a key refreshes its LRU position`
    - `defaults maxEntries to 1000`
  - Stats:
    - `tracks hits and misses`
    - `reports size correctly`
    - `returns hitRate 0 when no operations have occurred`

#### Redis backend (prefixing, TTL writes, clear, stats)
- `src/__tests__/redis-backend.test.ts`
  - CRUD and TTL:
    - `returns null for a missing key`
    - `stores and retrieves a value without TTL`
    - `stores a value with TTL using EX flag`
    - `does not use EX when ttlSeconds is 0`
    - `deletes a key`
  - Prefix support:
    - `prepends prefix on get`
    - `prepends prefix on set`
    - `prepends prefix on set with TTL`
    - `prepends prefix on delete`
    - `round-trips a value through prefix`
  - Clear and stats:
    - `clear uses SCAN to delete all keys`
    - `clear resets internal stats`
    - `tracks hits and misses`
    - `returns hitRate 0 when no operations occurred`
    - `reports size as -1 (unknown for Redis)`

### 11.2 Coverage Notes

- The suite strongly validates current behavior and error-tolerant semantics.
- A naming caveat: test `get returns null for non-cacheable requests without hitting backend` verifies return behavior but does not currently assert backend call count explicitly.
