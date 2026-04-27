# @dzupagent/cache Architecture

## Scope
`@dzupagent/cache` is a small Node.js ESM package that provides cache primitives for request/response-style LLM workflows. The implemented surface in `packages/cache` includes:
- A policy-aware middleware (`CacheMiddleware`) for cacheability checks, keying, and backend delegation.
- Deterministic cache key generation (`generateCacheKey`).
- Two backend implementations:
  - `InMemoryCacheBackend` (process-local Map with TTL + LRU and sorted-set helpers).
  - `RedisCacheBackend` (ioredis-compatible client wrapper with optional prefixing and sorted-set delegation).
- Shared contracts in `src/types.ts`.

This document is grounded in:
- `src/**`
- `package.json`
- `README.md`
- `src/__tests__/**`

## Responsibilities
The package is responsible for:
- Deciding whether a request is cacheable using `CachePolicy`.
- Generating stable, deterministic keys from request data.
- Persisting/retrieving serialized cache entries through a pluggable `CacheBackend`.
- Providing best-effort behavior for core cache operations so backend failures do not break caller flows.
- Exposing basic observability hooks (`onHit`, `onMiss`, `onDegraded`).
- Providing lightweight sorted-set primitives through the same backend abstraction.

The package is not responsible for:
- Request deduplication/single-flight around concurrent misses.
- Automatic refresh/stale-while-revalidate behavior.
- Schema-aware keying of every possible model parameter (current key schema is intentionally narrow).
- Owning Redis client lifecycle/connection management.

## Structure
Current module layout:
- `src/index.ts`
  - Public export hub.
- `src/types.ts`
  - Interfaces and core types: `CacheBackend`, `CachePolicy`, `CacheableRequest`, `CacheStats`, `CacheMiddlewareConfig`, `CacheEntry`.
- `src/key-generator.ts`
  - `generateCacheKey(request, namespace?)` using SHA-256.
- `src/middleware.ts`
  - `CacheMiddleware` orchestration (`isCacheable`, `get`, `set`, `stats`).
- `src/backends/in-memory.ts`
  - `InMemoryCacheBackend` with cache-map + sorted-set map.
- `src/backends/redis.ts`
  - `RedisCacheBackend` with prefixing, SCAN+DEL clear, and sorted-set delegation.
- `src/__tests__/*.test.ts`
  - Unit and deep coverage for middleware, key generation, in-memory backend, Redis backend, sorted-set semantics, and index exports.
- `tsup.config.ts`
  - ESM build (`src/index.ts` -> `dist`, DTS enabled, Node 20 target).

## Runtime and Control Flow
Typical read/write flow:
1. Caller builds a `CacheMiddleware` with backend + policy.
2. `get(request)`:
- Runs `isCacheable(request)`.
- If not cacheable, returns `null` without touching backend.
- If cacheable, computes key via `generateCacheKey(request, policy.namespace)`.
- Reads backend value.
- On `null`: emits `onMiss` (if configured), returns `null`.
- On value: parses JSON as `CacheEntry`, emits `onHit`, returns `entry.response`.
- On backend/parse/callback errors inside the `try`: emits `onDegraded('get', reason, key)`, emits `onMiss`, returns `null`.
3. `set(request, response)`:
- Runs `isCacheable(request)`; no-op when false.
- Builds key and `CacheEntry` (`response`, `model`, `cachedAt`, `ttl`).
- Calls `backend.set(key, serializedEntry, policy.defaultTtlSeconds)`.
- On failure, emits `onDegraded('set', reason, key)` and does not throw.
4. `stats()` delegates to backend.

Cacheability semantics:
- If `policy.isCacheable` exists, it is authoritative.
- Otherwise, uses `temperature <= maxTemperature` with `temperature` defaulted to `1` when missing.

Keying semantics:
- Hash inputs are limited to:
  - `messages` (as `"role:content"` entries)
  - `model`
  - `temperature` (default `0`)
  - `maxTokens`
- Final format:
  - without namespace: `llm:<sha256>`
  - with namespace: `<namespace>:llm:<sha256>`

Backend behavior notes:
- In-memory backend:
  - TTL expiry is checked lazily on `get` and during `stats` sweep.
  - LRU eviction uses Map insertion order.
  - `clear()` resets both cache and sorted sets.
- Redis backend:
  - Optional `prefix` prepends all keys.
  - `clear()` scans with `MATCH <prefix>:*` when prefixed, otherwise `MATCH *`.
  - `clear()` resets hit/miss counters.
  - Core methods (`get/set/delete/clear`) degrade on error; sorted-set ops propagate errors.

## Key APIs and Types
Public exports from `src/index.ts`:
- `CacheMiddleware`
- `generateCacheKey`
- `InMemoryCacheBackend`
- `RedisCacheBackend`
- Types:
  - `CacheBackend`
  - `CachePolicy`
  - `CacheableRequest`
  - `CacheStats`
  - `CacheMiddlewareConfig`
  - `CacheEntry`

`CacheBackend` contract:
- Core cache operations:
  - `get(key)`
  - `set(key, value, ttlSeconds?)`
  - `delete(key)`
  - `clear()`
  - `stats()`
- Sorted-set operations:
  - `zadd(key, score, member)`
  - `zrangebyscore(key, min, max)`
  - `zrem(key, member)`
  - `zcard(key)`

`CacheMiddlewareConfig` callbacks:
- `onHit(key, model)`
- `onMiss(key, model)`
- `onDegraded(operation, reason, key?)` where `operation` is one of `get | set | delete | clear`.

`CacheStats` semantics:
- `hits`
- `misses`
- `size`
- `hitRate`
- For Redis backend, `size` is `-1` (unknown by design).

## Dependencies
Runtime:
- Node.js built-in `node:crypto` for SHA-256 key hashing.
- Optional peer dependency `ioredis >= 5.0.0` (only needed for Redis backend usage).

Build/test/tooling:
- `tsup`
- `typescript`
- `vitest`

Package metadata highlights (`package.json`):
- Package: `@dzupagent/cache`
- Version: `0.2.0`
- Module type: ESM
- Export surface: root export only (`.` -> `dist/index.js`, `dist/index.d.ts`)

## Integration Points
Primary integration path:
- Instantiate a backend (`InMemoryCacheBackend` or `RedisCacheBackend`).
- Construct `CacheMiddleware` with policy and optional callbacks.
- Wrap upstream LLM invocation with:
  - `const hit = await cache.get(request)`
  - if miss: call model and then `await cache.set(request, response)`

Isolation controls:
- `policy.namespace` influences generated request keys.
- Redis `prefix` adds backend-level key partitioning.
- Both can be used together.

Direct backend use cases:
- Manual invalidation through `backend.delete(key)`.
- Full clear through `backend.clear()`.
- Sorted-set operations for lightweight ordered indexing/provenance-like use cases.

## Testing and Observability
Test suite coverage currently includes:
- Key generation determinism and namespace behavior.
- Middleware policy boundaries, callbacks, degraded-path behavior, TTL pass-through, and shared-backend behavior.
- In-memory backend CRUD, TTL edges, LRU behavior, stats, and deep edge cases.
- Redis backend prefixing, clear scan loop behavior, degraded-path callbacks, TTL handling, stats, and constructor options.
- Sorted-set behavior in both backends.
- Public export verification from package index.

Observability mechanisms in implementation:
- `onHit` and `onMiss` for request-level cache event hooks.
- `onDegraded` for non-fatal failures in middleware (`get`, `set`) and Redis backend core operations (`get`, `set`, `delete`, `clear`).
- Backend `stats()` provides local counters and hit rate.

## Risks and TODOs
Implementation-grounded risks:
- `generateCacheKey` intentionally ignores extra request fields; different requests can collide if they vary outside `{messages, model, temperature, maxTokens}`.
- Default temperature normalization differs:
  - `CacheMiddleware.isCacheable`: missing temperature -> `1`.
  - `generateCacheKey`: missing temperature -> `0`.
- `RedisCacheBackend.clear()` with empty prefix scans `*` and can delete all reachable keys for that Redis connection.
- Middleware has no first-class request invalidation helpers (`delete(request)`/`clearNamespace()`), so callers must compose key generation + backend operations.
- Core `get` path catches broad exceptions (including parse and callback exceptions in the same try/catch), so some failure modes are intentionally collapsed into misses.

Current TODO direction implied by code/tests/docs (not yet implemented in this package):
- Optional safer guardrails around unprefixed Redis clear.
- Broader or configurable key schema for modern model request variance.
- Higher-level invalidation helpers on middleware.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

