# `@dzupagent/cache` Implementation Analysis and Gap Review

Date: 2026-04-03
Scope: `packages/cache/**`

## 1) Scope and Method

This analysis is based on:
- Static review of source code in:
  - `packages/cache/src/types.ts`
  - `packages/cache/src/key-generator.ts`
  - `packages/cache/src/middleware.ts`
  - `packages/cache/src/backends/in-memory.ts`
  - `packages/cache/src/backends/redis.ts`
- Review of package docs and public API (`README.md`, `index.ts`).
- Test suite review and execution:
  - Command: `yarn workspace @dzupagent/cache test`
  - Result: 69/69 tests passing across 5 files.

Notes:
- The `analyze` skill references a quick-scan script, but no script is present in the installed skill directory. This report therefore uses direct code/test verification only.

## 2) Current Implementation Summary

### Architecture

The package is a compact cache layer with three major components:
- Policy and orchestration:
  - `CacheMiddleware` wraps a backend and enforces cacheability policy and callbacks.
- Key derivation:
  - `generateCacheKey()` computes deterministic SHA-256 keys from selected request fields.
- Storage backends:
  - `InMemoryCacheBackend`: Map-based LRU + TTL.
  - `RedisCacheBackend`: ioredis-compatible backend with key prefixing and SCAN-based clear.

### Public Surface

Exports (`packages/cache/src/index.ts`):
- `CacheMiddleware`
- `generateCacheKey`
- `InMemoryCacheBackend`
- `RedisCacheBackend`
- Core types (`CacheBackend`, `CachePolicy`, `CacheableRequest`, etc.)

### Strengths

- Clear separation of concerns between policy, keying, and persistence.
- Consistent “best-effort” behavior for backend failures in middleware/backends.
- In-memory backend has straightforward LRU semantics and lazy TTL cleanup.
- Redis backend avoids `KEYS` and uses `SCAN` for clear operations.
- Test coverage is broad for basic behavior and happy paths.

## 3) Findings (Severity-Ranked)

## Critical

### C1) `RedisCacheBackend.clear()` can wipe the entire Redis DB when no prefix is configured

Impact:
- If `prefix` is omitted, `clear()` scans with pattern `*` and deletes all matching keys, which can remove unrelated application data.
- This is a high-risk operational safety issue for shared Redis deployments.

Evidence:
- `packages/cache/src/backends/redis.ts:74` sets `pattern = '*'` when no prefix exists.
- `packages/cache/src/backends/redis.ts:81` deletes scanned keys with `DEL`.
- `packages/cache/README.md:31` describes clear behavior as safe key scanning, but safety depends on disciplined prefix usage.

Recommendation:
- Make full-DB clear opt-in and explicit.
- Introduce constructor option: `allowUnsafeClear?: boolean` default `false`.
- If `prefix` is empty and `allowUnsafeClear` is false, `clear()` should no-op with explicit warning callback/log hook or throw a typed error.
- Add tests asserting no deletion occurs without explicit opt-in.

## High

### H1) Cache key is under-specified for modern LLM request variance

Impact:
- Key generation uses only `messages`, `model`, `temperature`, `maxTokens`.
- Requests differing in other output-affecting fields (for example: `topP`, `seed`, tool configuration, response format, penalties, reasoning settings, structured output schema) can collide and produce incorrect cache hits.

Evidence:
- `packages/cache/src/key-generator.ts:14-19` only serializes four fields.
- `packages/cache/src/types.ts:35` allows arbitrary extra fields on request (`[key: string]: unknown`).
- `packages/cache/src/__tests__/key-generator.test.ts:99` explicitly asserts extra fields are ignored.

Recommendation:
- Introduce configurable key schema:
  - `keyFields?: string[]` defaulting to a safe baseline that includes major generation controls.
  - Optional custom normalizer/serializer hook.
- Canonicalize complex fields (stable key ordering) and include versioned key prefix (`v1`, `v2`) to support migration.

### H2) Hook callback exceptions can change cache semantics and leak errors

Impact:
- `onHit` and `onMiss` execute inside middleware flow and are not isolated.
- If a callback throws:
  - hit path can degrade to miss path (or throw),
  - miss callback can be invoked twice in edge paths,
  - observability code can affect correctness.

Evidence:
- `packages/cache/src/middleware.ts:67-80` wraps backend read, parse, and callbacks in a single try/catch.
- `packages/cache/src/middleware.ts:76` invokes `onHit` inside that try block.
- `packages/cache/src/middleware.ts:71` and `packages/cache/src/middleware.ts:79` both call `onMiss` in related miss/error paths.

Recommendation:
- Isolate callbacks with dedicated safe wrapper:
  - `safeNotify('hit'|'miss', ...)` that catches and suppresses callback errors.
- Keep backend/data-path exceptions independent from callback exceptions.
- Add tests where `onHit`/`onMiss` throw to ensure deterministic behavior.

## Medium

### M1) Temperature normalization is inconsistent between cacheability and key generation

Impact:
- Middleware cacheability defaults missing temperature to `1` (usually non-cacheable), while key generation defaults missing temperature to `0`.
- Under custom policy allowing missing temperature, undefined and explicit `0` map to the same key.

Evidence:
- `packages/cache/src/middleware.ts:52` uses `request.temperature ?? 1`.
- `packages/cache/src/key-generator.ts:17` uses `request.temperature ?? 0`.
- `packages/cache/README.md:152-154` documents middleware behavior as undefined=>`1`.

Recommendation:
- Unify normalization in a shared utility used by both cacheability and keying.
- Decide explicit semantics (`undefined` distinct from `0`, or fully normalized) and document clearly.

### M2) Corrupt entries are not self-healed after JSON parse failure

Impact:
- If backend value is invalid JSON, middleware returns miss but leaves bad entry in place, causing repeated parse failures on every read.

Evidence:
- `packages/cache/src/middleware.ts:75` parses JSON.
- `packages/cache/src/middleware.ts:78-80` returns miss on error but does not delete offending key.

Recommendation:
- On parse failure, attempt `backend.delete(key)` (best-effort) before returning miss.
- Emit dedicated callback/hook for corrupt-entry detection.

### M3) Redis client contract is unchecked at runtime; failures are silently absorbed

Impact:
- Constructor accepts `unknown` and casts to `RedisClientLike`.
- Invalid client shape yields runtime exceptions that are swallowed, leading to silent cache disablement.

Evidence:
- `packages/cache/src/backends/redis.ts:26-29` unchecked cast.
- `packages/cache/src/backends/redis.ts:45-47`, `59-61`, `67-69`, `86-88` swallow errors.

Recommendation:
- Validate client methods at construction and fail fast with clear error messages.
- Add optional `onError` callback for visibility when best-effort handling suppresses exceptions.

### M4) Middleware lacks first-class invalidation API

Impact:
- Public middleware only exposes `get`, `set`, `stats`; users must bypass middleware and manually compute keys for deletion/invalidations.

Evidence:
- `packages/cache/src/middleware.ts:60-115` includes no delete/invalidate methods.
- `packages/cache/src/index.ts` exports middleware but not helper methods for request-level invalidation.

Recommendation:
- Add middleware methods:
  - `delete(request)`
  - `deleteByKey(key)`
  - `clearNamespace()` (if supported)

## Low

### L1) In-memory backend relies on lazy expiry; expired keys may occupy memory until accessed/stats

Impact:
- Expired entries remain until reads/stats sweep, which can inflate memory footprint in write-heavy, read-light workloads.

Evidence:
- `packages/cache/src/backends/in-memory.ts:32-35` removes expired entries on `get`.
- `packages/cache/src/backends/in-memory.ts:73-80` sweeps expired entries on `stats`.

Recommendation:
- Optional periodic cleanup interval for long-lived processes.

### L2) Test naming overstates one behavior not directly asserted

Impact:
- Test title says “without hitting backend” but no explicit backend-call assertion exists, reducing confidence in short-circuit guarantee.

Evidence:
- `packages/cache/src/__tests__/middleware-advanced.test.ts:95` title claims no backend hit.
- No spy/assert for backend `get` call count in that test.

Recommendation:
- Add a spy/assertion to verify backend read is not invoked for non-cacheable requests.

## 4) Gap Analysis Matrix

| Capability Area | Current State | Gap | Risk/Cost |
|---|---|---|---|
| Key correctness | Deterministic hash over limited fields | Missing many generation-affecting request fields | Wrong-cache hits, subtle correctness bugs |
| Operational safety | Redis `clear()` uses SCAN | No guard against global delete when prefix empty | Potential catastrophic data loss |
| Reliability under bad data | Parse errors treated as miss | Corrupt entries not cleaned | Repeated misses + repeated parse overhead |
| Observability resilience | Basic hit/miss callbacks | Callback failures can affect control flow | Hard-to-debug production incidents |
| API ergonomics | `get/set/stats` | Missing invalidate/delete at middleware level | Users reimplement invalidation, drift risk |
| Distributed performance | Basic get/set | No stampede protection/single-flight | Increased LLM calls on hot misses |
| Cache freshness strategy | Fixed TTL | No stale-while-revalidate, no soft/hard TTL split | Latency spikes, lower hit quality |
| Security/privacy controls | Namespace + optional Redis prefix | No encryption/redaction guidance for prompt/response bodies | Sensitive payload exposure risks |
| Backpressure/limits | In-memory max entries, Redis unbounded | No response-size limit/compression | Memory/network amplification for large outputs |

## 5) Recommended Feature Roadmap

### P0 (Safety and Correctness)

1. Safe clear semantics
- Add `allowUnsafeClear` (default `false`) and block full-DB clear unless explicitly enabled.
- Require prefix for `clear()` by default.

2. Versioned key schema with configurable key fields
- Add `keyVersion` and `keyFields` options.
- Include common LLM controls by default (`topP`, penalties, seed, response format, tool settings, etc.).

3. Callback isolation
- Wrap `onHit/onMiss` in safe notifier to ensure instrumentation cannot alter cache correctness.

4. Corrupt-entry self-healing
- On parse errors, best-effort delete key and emit diagnostic event.

### P1 (Performance and API)

5. `getOrSet`/single-flight API
- Add method that deduplicates concurrent misses per key.
- Optional lock timeout and jitter.

6. Invalidation primitives
- Add `delete(request)`, `deleteByKey(key)`, and namespace-scoped clear.

7. TTL model enhancements
- Per-call TTL override in `set`.
- Optional jitter to reduce synchronized expirations.

### P2 (Observability and Security)

8. Structured telemetry hooks
- Add unified `onEvent` with event types: `hit`, `miss`, `write_error`, `parse_error`, `evict`, `clear`.

9. Payload controls
- Optional compression for large entries.
- Optional pluggable encrypt/decrypt hooks for sensitive content.

10. Richer stats
- Add optional moving-window hit rate and (for prefixed Redis) approximate key count mode.

## 6) Test Gaps to Close Next

1. Callback-failure tests
- `onHit` throws.
- `onMiss` throws.
- Ensure middleware still returns deterministic hit/miss behavior.

2. Safety tests for Redis clear
- No prefix + default options must not delete all keys.
- Prefix mode should only delete prefixed keys.

3. Key-schema tests
- Ensure output-affecting fields alter keys.
- Ensure key version migration behavior is explicit.

4. Corrupt-entry tests
- Parse failure should trigger delete and recover on next set/get.

## 7) Overall Assessment

The package is cleanly structured and easy to integrate, with solid baseline tests and good composability. The most important gaps are not code-style issues but production-behavior risks: unsafe Redis clear defaults, under-specified cache keys for modern LLM requests, and callback error isolation. Addressing these first will significantly improve correctness and operational safety without changing the package’s core simplicity.
