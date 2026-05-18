# Concurrency Architecture (`packages/core/src/concurrency`)

## Scope
This document describes the concurrency primitives in `@dzupagent/core` under:
- `src/concurrency/semaphore.ts`
- `src/concurrency/pool.ts`
- `src/concurrency/index.ts`

It also covers how these primitives are surfaced from package entry points (`src/index.ts`, `src/facades/orchestration.ts`, `src/utils.ts`) and how behavior is validated by current tests in `src/__tests__`.

## Responsibilities
The concurrency module provides in-process coordination helpers for async workloads:
- `Semaphore`: counting semaphore with FIFO waiter queueing.
- `ConcurrencyPool`: keyed execution pool with:
  - a global concurrency cap,
  - optional per-key cap,
  - activity and outcome counters,
  - per-key semaphore lifecycle controls (idle eviction and tracked-key cap),
  - `drain()` coordination for "wait until idle" flows.

Out of scope for this module:
- cross-process/distributed coordination,
- scheduling priority classes,
- cancellation-aware permit acquisition,
- built-in timeout policies for `acquire()` or `drain()`.

## Structure
- `semaphore.ts`
  - Declares `Semaphore`.
  - Maintains `permits`, `maxPermits`, and FIFO `waiting` queue.
  - Exposes `acquire()`, `release()`, `run()`, `available`, and `queueLength`.
- `pool.ts`
  - Declares `PoolConfig`, `PoolStats`, and `ConcurrencyPool`.
  - Uses `Semaphore` for global limits and optional per-key limits.
  - Tracks per-key state (`keySems`, `keyLastUsedAt`, `activeCounts`) and global counters (`queued`, `completed`, `failed`).
  - Holds `drainResolvers` for pending `drain()` calls.
- `index.ts`
  - Re-exports `Semaphore`, `ConcurrencyPool`, `PoolConfig`, and `PoolStats` from local module files.

## Runtime and Control Flow
`Semaphore` lifecycle:
1. `new Semaphore(maxPermits)` throws if `maxPermits < 1`, then initializes available permits to `maxPermits`.
2. `acquire()`:
   - decrements immediately when a permit is available,
   - otherwise enqueues a resolver and waits.
3. `release()`:
   - transfers the permit directly to the next queued waiter when present,
   - otherwise increments `permits`,
   - throws on over-release (`permits >= maxPermits` with no queued waiter).
4. `run(fn)` wraps `acquire()`/`release()` in `try/finally`.

`ConcurrencyPool.execute(key, fn)` lifecycle:
1. Resolve per-key semaphore via `getKeySemaphore(key)` when `maxPerKey` is configured.
2. Update key recency with `touchKey(key)`.
3. Increment `queued`.
4. Acquire permits:
   - global semaphore always,
   - key semaphore as well when present.
5. Decrement `queued` once acquisition phase exits.
6. Increment key activity via `incrementActive(key)`.
7. Execute `fn`.
8. Update counters:
   - `completed++` on success,
   - `failed++` on error, then rethrow.
9. In `finally`:
   - decrement active count,
   - release global/key semaphores,
   - retouch key timestamp,
   - run idle and capacity-based key eviction,
   - run `checkDrain()` to resolve waiters when pool becomes idle.

`drain()` lifecycle:
1. If `stats().active === 0` and `queued === 0`, resolve immediately.
2. Otherwise append resolver to `drainResolvers`.
3. `checkDrain()` resolves all stored resolvers once both active and queued work drop to zero.

Per-key semaphore management:
- Lazy creation only when `maxPerKey` is set.
- Eviction is eligible only when `canEvictKey(...)` is true:
  - no active work for key,
  - key semaphore has no queue,
  - all key permits are currently available.
- `evictIdleKeySemaphores()` removes keys idle longer than `maxIdleMsPerKey` (when finite).
- `enforceTrackedKeyLimit()` applies LRU-style eviction among eligible keys when tracked key count exceeds `maxTrackedKeys` (when finite).

## Key APIs and Types
`Semaphore`:
- `constructor(maxPermits: number)`
- `acquire(): Promise<void>`
- `release(): void`
- `run<T>(fn: () => Promise<T>): Promise<T>`
- `available: number`
- `queueLength: number`

`PoolConfig`:
- `maxConcurrent: number` (default `10`)
- `maxPerKey?: number` (optional per-key cap)
- `maxIdleMsPerKey?: number` (default `300_000`)
- `maxTrackedKeys?: number` (default `1000`)

`PoolStats`:
- `active: number`
- `queued: number`
- `completed: number`
- `failed: number`
- `activeKeys: string[]`

`ConcurrencyPool`:
- `constructor(config?: Partial<PoolConfig>)`
- `execute<T>(key: string, fn: () => Promise<T>): Promise<T>`
- `stats(): PoolStats`
- `drain(): Promise<void>`
- `trackedKeyCount(): number`

## Dependencies
Module-level dependencies:
- `pool.ts` imports local `Semaphore` from `./semaphore.js`.
- `semaphore.ts` has no imports.
- No third-party runtime dependency is used directly by `src/concurrency/*`.

Package context (`packages/core/package.json`):
- Package runtime dependencies are `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, and `@dzupagent/security`.
- The concurrency module does not import those dependencies directly.

## Integration Points
Exports and entry-point integration in `@dzupagent/core`:
- Root entry re-exports from `src/index.ts`.
- Orchestration facade re-exports from `src/facades/orchestration.ts`.
- Utility facade re-exports from `src/utils.ts`.
- Local barrel is `src/concurrency/index.ts`.

Package export surface (`package.json`):
- No dedicated `./concurrency` subpath is exported.
- Consumers access these APIs via:
  - `@dzupagent/core`
  - `@dzupagent/core/orchestration`
  - `@dzupagent/core/utils`

Current internal usage:
- In `packages/core/src` runtime code, these primitives are currently exposed as building blocks and not instantiated by other non-test modules.
- Behavior is primarily exercised through direct concurrency tests and facade-level tests.

## Testing and Observability
Test coverage in current tree:
- `src/__tests__/concurrency.test.ts`
  - constructor validation and permit accounting,
  - queue blocking/unblocking behavior,
  - `run()` success/error release guarantees,
  - global and per-key concurrency limit behavior,
  - stats counters and `activeKeys`,
  - key-tracking eviction behavior.
- `src/__tests__/pool-drain.test.ts`
  - immediate drain on idle pool,
  - drain waiting for active and queued tasks,
  - multiple concurrent `drain()` waiters.
- `src/__tests__/w15-h2-branch-coverage.test.ts` (concurrency section)
  - decrement branch behavior with same-key concurrency,
  - idle eviction finite vs `Infinity`,
  - tracked-key cap enforcement,
  - no-`maxPerKey` path,
  - failure counter path,
  - additional `drain()` branch coverage.
- Facade coverage:
  - `src/__tests__/facades.test.ts`
  - `src/__tests__/facade-orchestration.test.ts`
  - `src/__tests__/w15-b1-facades.test.ts`
  - confirms export wiring and basic behavior via facade entry points.

Observability surfaces:
- `Semaphore.available` and `Semaphore.queueLength`.
- `ConcurrencyPool.stats()` and `trackedKeyCount()`.
- No built-in event emission, logging, or metrics instrumentation in this module.

## Risks and TODOs
- `Semaphore` validates only `maxPermits < 1`; non-finite values are not explicitly rejected.
- `ConcurrencyPool` constructor currently applies defaults but does not enforce strict numeric validation for each config field.
- `drain()` has no timeout or cancellation path; it depends on all scheduled work eventually finishing.
- `stats()` recomputes `active` and `activeKeys` by iterating `activeCounts` on each call.
- `touchKey()` runs for every `execute` call, including cases where per-key semaphores are disabled (`maxPerKey` undefined), so `keyLastUsedAt` may accumulate timestamps even with `trackedKeyCount() === 0`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

