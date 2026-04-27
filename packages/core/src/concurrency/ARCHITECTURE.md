# Concurrency Architecture (`packages/core/src/concurrency`)

## Scope
This document covers the concurrency primitives implemented in `packages/core/src/concurrency`:
- `semaphore.ts`
- `pool.ts`
- `index.ts`

It reflects the current local code in `@dzupagent/core` and the package-level integration points that import these primitives.

## Responsibilities
The concurrency module provides two orchestration-level building blocks:
- `Semaphore`: a counting semaphore with FIFO waiter queueing for bounded parallelism.
- `ConcurrencyPool`: a higher-level execution pool that combines global concurrency limits, optional per-key limits, lifecycle statistics, and `drain()` coordination.

The module does not include:
- cancellation-aware acquire APIs (callers implement abort wrappers externally),
- time-slicing or priority scheduling,
- distributed coordination across processes.

## Structure
Files:
- `semaphore.ts`
  - `Semaphore` class with `acquire()`, `release()`, `run()`, `available`, and `queueLength`.
- `pool.ts`
  - `PoolConfig` interface.
  - `PoolStats` interface.
  - `ConcurrencyPool` class with `execute()`, `stats()`, `drain()`, and `trackedKeyCount()`.
- `index.ts`
  - re-exports `Semaphore`, `ConcurrencyPool`, `PoolConfig`, and `PoolStats`.

Package export surfaces:
- Root exports in `packages/core/src/index.ts`.
- Orchestration facade exports in `packages/core/src/facades/orchestration.ts`, consumed as `@dzupagent/core/orchestration`.

## Runtime and Control Flow
`Semaphore` control flow:
1. Constructor stores `maxPermits` and initializes `permits` to that value; it throws only when `maxPermits < 1`.
2. `acquire()` decrements immediately when permits are available; otherwise enqueues a resolver in `waiting`.
3. `release()` either resumes the next waiter (`shift()`) or increments permits; over-release throws when permits are already at `maxPermits`.
4. `run(fn)` wraps `acquire()`/`release()` in `try/finally`.

`ConcurrencyPool.execute(key, fn)` control flow:
1. Resolves an optional per-key semaphore via `getKeySemaphore(key)` when `maxPerKey` is configured.
2. Touches key usage timestamp via `touchKey(key)`.
3. Increments `queued`, then acquires global and optional per-key permits.
4. Decrements `queued`, increments active count for `key`, runs `fn`.
5. On success increments `completed`; on throw increments `failed` and rethrows.
6. In `finally`, decrements active count, releases semaphores, touches key, attempts idle eviction, and checks pending `drain()` resolvers.

`drain()` behavior:
- resolves immediately when `active === 0` and `queued === 0`,
- otherwise stores resolver callbacks in `drainResolvers` until `checkDrain()` sees idle state.

Per-key semaphore lifecycle:
- created lazily when `maxPerKey` is enabled,
- evicted by idle timeout (`maxIdleMsPerKey`) only when key is idle and semaphore is fully available,
- evicted by tracked-key pressure (`maxTrackedKeys`) using oldest `keyLastUsedAt` among evictable keys.

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
- `maxPerKey?: number`
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
Direct module dependencies:
- `pool.ts` depends on local `Semaphore` from `./semaphore.js`.
- No third-party runtime dependency is used by the concurrency module itself.

Package-level dependencies (from `packages/core/package.json`) that contextualize export/use:
- direct: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`
- peer: `@langchain/core`, `@langchain/langgraph`, `zod` (plus optional lancedb/arrow peers)

Concurrency primitives are standalone utility classes and are not coupled to LangChain/LangGraph internals.

## Integration Points
Within `@dzupagent/core`:
- re-exported via `src/index.ts` and `src/facades/orchestration.ts`.
- validated by direct unit tests and facade tests in `src/__tests__`.

Cross-package imports in the current repo:
- `packages/agent/src/orchestration/map-reduce.ts` imports `Semaphore`.
- `packages/agent-adapters/src/orchestration/supervisor.ts` imports `Semaphore`.
- `packages/agent-adapters/src/orchestration/map-reduce.ts` imports `Semaphore`.
- `packages/agent-adapters/src/testing/ab-test-runner.ts` imports `Semaphore`.
- `packages/evals/src/runner/enhanced-runner.ts` imports `Semaphore`.
- `packages/evals/src/prompt-experiment/prompt-experiment.ts` imports `Semaphore`.

Current adoption note:
- `ConcurrencyPool` usage is currently concentrated in `@dzupagent/core` tests/facade exposure; there are no non-core package instantiations in `packages/*`.

## Testing and Observability
Relevant tests in `packages/core/src/__tests__`:
- `concurrency.test.ts`
  - semaphore basics, invalid constructor values (`0`, negative), queueing/unblocking, `run()`, and concurrency cap checks.
  - pool defaults, success/failure counters, global and per-key concurrency limits, active key reporting, `drain()`, and tracked-key eviction behavior.
- `pool-drain.test.ts`
  - idle drain, waiting for active tasks, waiting for queued tasks, and concurrent `drain()` callers.
- `w15-h2-branch-coverage.test.ts`
  - branch-specific checks for `ConcurrencyPool` decrement behavior, `Infinity` idle-window branch, idle eviction triggering, tracked-key limit enforcement, failure path, and behavior when `maxPerKey` is unset.
- facade coverage:
  - `facade-orchestration.test.ts`
  - `w15-b1-facades.test.ts`
  - `facades.test.ts`

Built-in observability surface:
- `ConcurrencyPool.stats()` returns live counters and active key list.
- `trackedKeyCount()` exposes currently tracked per-key semaphores.
- `Semaphore.available` and `Semaphore.queueLength` expose internal permit/queue state.

No event bus or metrics collector integration is implemented in this module; observability is pull-based through the APIs above.

## Risks and TODOs
- `Semaphore` constructor validation only checks `< 1`.
  - `NaN` passes the current guard and can produce invalid semaphore state.
  - `Infinity` is accepted and effectively creates an unbounded semaphore.
- `ConcurrencyPool` does not validate numeric config fields (`maxConcurrent`, `maxPerKey`, `maxIdleMsPerKey`, `maxTrackedKeys`) for finiteness or integer constraints before constructing semaphores/threshold logic.
- `touchKey(key)` runs even when `maxPerKey` is unset.
  - with high-cardinality keys, `keyLastUsedAt` can grow while `keySems` stays empty.
- `stats()` recomputes `active` by iterating `activeCounts` on each call; cost grows with active-key cardinality.
- `drain()` relies on internal counters and completion paths; there is no timeout/cancellation support for waiting callers.
- `ConcurrencyPool` still lacks cross-package production usage, so behavior under non-test workloads is less exercised than `Semaphore`.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.

