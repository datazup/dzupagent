# @dzupagent/cache Architecture

## Scope
`@dzupagent/cache` is a small TypeScript/ESM package that provides reusable cache primitives for request/response LLM flows. The implementation in `packages/cache` currently includes:
- A policy-driven middleware (`CacheMiddleware`) that gates cacheability, generates keys, and delegates to a backend.
- Deterministic request key generation (`generateCacheKey`) based on a normalized subset of request fields.
- Two backend implementations of the same contract:
- `InMemoryCacheBackend` (single-process map with TTL, LRU, and sorted-set helpers).
- `RedisCacheBackend` (ioredis-compatible wrapper with optional key prefixing and scan-based clear).
- Shared types and contracts in `src/types.ts`.

This document is based on the local implementation under `src/`, package metadata in `package.json`, package usage docs in `README.md`, and the package test suite.

## Responsibilities
The package is responsible for:
- Defining the cache backend contract (`CacheBackend`) used by middleware and backend implementations.
- Determining cacheability via policy (`maxTemperature` and optional `isCacheable`).
- Serializing and storing cache entries (`CacheEntry`) with TTL metadata.
- Reading cached entries and returning stored `response` payloads.
- Exposing lightweight cache observability hooks:
- `onHit(key, model)`
- `onMiss(key, model)`
- `onDegraded(operation, reason, key?)`
- Providing optional sorted-set operations (`zadd`, `zrangebyscore`, `zrem`, `zcard`) on the same backend contract.

The package is not responsible for:
- Redis connection lifecycle management.
- Stale-while-revalidate or background refresh.
- Request coalescing/single-flight on concurrent misses.
- A full-fidelity key schema for all possible model/provider request parameters.

## Structure
Current package layout:
- `src/index.ts`
- Public exports for middleware, key generator, backends, and types.
- `src/types.ts`
- Contracts and shared types (`CacheBackend`, `CachePolicy`, `CacheableRequest`, `CacheStats`, `CacheMiddlewareConfig`, `CacheEntry`).
- `src/key-generator.ts`
- `generateCacheKey(request, namespace?)` using `node:crypto` SHA-256.
- `src/middleware.ts`
- `CacheMiddleware` (`isCacheable`, `get`, `set`, `stats`).
- `src/backends/in-memory.ts`
- `InMemoryCacheBackend` with TTL expiration, LRU via `Map` insertion order, and in-memory sorted-set maps.
- `src/backends/redis.ts`
- `RedisCacheBackend` using an ioredis-compatible client interface, optional prefixing, SCAN+DEL clear loop, and sorted-set delegation.
- `src/__tests__/*.test.ts`
- Coverage for exports, keying, middleware behavior, backend behavior, deep edge cases, and sorted-set semantics.
- `package.json`
- Package metadata and optional `ioredis` peer dependency.
- `tsup.config.ts`
- Build config for ESM + declarations.

## Runtime and Control Flow
Standard middleware flow:
1. Caller instantiates a backend and `CacheMiddleware` with `{ backend, policy, callbacks? }`.
2. `get(request)`:
- Returns `null` immediately if request is not cacheable.
- Builds key via `generateCacheKey(request, policy.namespace)`.
- Calls `backend.get(key)`.
- On missing value: fires `onMiss` and returns `null`.
- On value: parses JSON `CacheEntry`, fires `onHit`, returns `entry.response`.
- On any thrown error (backend failure, parse failure, callback throw): fires `onDegraded('get', ...)`, then `onMiss`, then returns `null`.
3. `set(request, response)`:
- No-op if request is not cacheable.
- Creates `CacheEntry` with `response`, `model`, `cachedAt`, and policy TTL.
- Serializes entry and calls `backend.set(key, json, ttl)`.
- On failure, does not throw; fires `onDegraded('set', ...)`.
4. `stats()` delegates directly to `backend.stats()`.

Cacheability logic:
- If `policy.isCacheable` is provided, it overrides default temperature gating.
- Otherwise: `request.temperature ?? 1` must be `<= policy.maxTemperature`.

Key generation details:
- Key hash input includes only:
- `messages` as `"role:content"` pairs
- `model`
- `temperature` (default `0` in key generator)
- `maxTokens`
- Output format:
- without namespace: `llm:<sha256>`
- with namespace: `<namespace>:llm:<sha256>`

Backend runtime behavior:
- `InMemoryCacheBackend`:
- Stores entries in `Map<string, { value, expiresAt }>`.
- TTL is enforced lazily on `get`, and expired items are purged during `stats()`.
- LRU eviction removes the oldest map key when at `maxEntries` capacity.
- Sorted sets are stored separately as `Map<string, Map<string, number>>`.
- `clear()` resets cache entries, sorted sets, and hit/miss counters.
- `RedisCacheBackend`:
- Uses prefix-aware key building (`prefix:key` when configured).
- `set` uses `EX` only when `ttlSeconds > 0`; otherwise plain set.
- `clear()` scans keys with `MATCH <prefix>:*` (or `*` when no prefix) and deletes matched batches.
- Core cache methods (`get/set/delete/clear`) are degraded-safe (catch + callback), while sorted-set methods intentionally propagate client errors.

## Key APIs and Types
Public exports (from `src/index.ts`):
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

`CacheBackend` methods:
- `get(key): Promise<string | null>`
- `set(key, value, ttlSeconds?): Promise<void>`
- `delete(key): Promise<void>`
- `clear(): Promise<void>`
- `stats(): Promise<CacheStats>`
- `zadd(key, score, member): Promise<void>`
- `zrangebyscore(key, min, max): Promise<string[]>`
- `zrem(key, member): Promise<void>`
- `zcard(key): Promise<number>`

`CachePolicy` fields:
- `maxTemperature: number`
- `defaultTtlSeconds: number`
- `namespace?: string`
- `isCacheable?: (request) => boolean`

`CacheStats` fields:
- `hits`
- `misses`
- `size`
- `hitRate`

Implementation note:
- `RedisCacheBackend.stats()` reports `size: -1` by design (unknown without additional Redis-wide counting).

## Dependencies
Runtime dependencies:
- Node built-in `node:crypto` for SHA-256 key hashing.

Peer dependencies:
- `ioredis` (optional peer, `>=5.0.0`) required only when using `RedisCacheBackend`.

Dev/build/test dependencies:
- `typescript`
- `tsup`
- `vitest`

Package scripts (`package.json`):
- `build`, `dev`, `typecheck`, `test`, `lint`

## Integration Points
Typical integration:
1. Choose backend (`InMemoryCacheBackend` for local/single-process, `RedisCacheBackend` for shared cache).
2. Configure policy and callbacks in `CacheMiddleware`.
3. Wrap model calls with cache get/set behavior.

Isolation knobs:
- `policy.namespace` affects generated cache keys.
- Redis `prefix` applies backend-level key namespacing.
- They can be used together when both logical and storage-level partitioning are needed.

Direct backend integration (without middleware):
- Manual key deletion via `delete(key)`.
- Global/prefix clear via `clear()`.
- Sorted-set operations for lightweight ordered indexes.

## Testing and Observability
Current tests under `src/__tests__` cover:
- Public export surface (`index-exports.test.ts`).
- Key generation determinism and namespace effects (`key-generator.test.ts`).
- Middleware behavior, callbacks, cacheability boundaries, stats delegation, and degraded-mode behavior (`cache-middleware*.test.ts`, `middleware-*.test.ts`).
- In-memory backend CRUD, TTL, LRU, size/hit-rate accounting, and edge behavior (`in-memory-*.test.ts`).
- Redis backend prefixing, TTL `EX` semantics, scan clear behavior, degraded handling, and stats behavior (`redis-*.test.ts`).
- Sorted-set contract behavior in both backends (`sorted-set.test.ts`).

Observability mechanisms:
- Event hooks: `onHit`, `onMiss`, `onDegraded`.
- Runtime counters via `stats()` in each backend.

## Risks and TODOs
Current implementation risks:
- Key collisions for requests that differ only in fields not included in `generateCacheKey` input.
- Default temperature mismatch between cacheability and keying:
- cacheability default is `temperature ?? 1`
- keying default is `temperature ?? 0`
- `RedisCacheBackend.clear()` with empty prefix uses `MATCH *`, which can affect all keys visible to that client.
- Middleware provides no first-class request-level invalidation helper (callers must generate key and use backend methods directly).
- `CacheMiddleware.get()` catches broad failures (backend errors, JSON parse errors, callback errors) and normalizes all to cache miss behavior.

Implementation-grounded TODO directions:
- Add optional safety guardrails for unprefixed Redis clear.
- Consider configurable key schema expansion for additional request parameters.
- Consider middleware-level invalidation helpers that accept `CacheableRequest`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

