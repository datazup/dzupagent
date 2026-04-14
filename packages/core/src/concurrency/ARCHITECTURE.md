# Concurrency Architecture (`packages/core/src/concurrency`)

## Scope
This document describes the concurrency primitives in `@dzupagent/core`:
- `Semaphore` (`semaphore.ts`)
- `ConcurrencyPool` (`pool.ts`)
- module exports (`index.ts`)

It also maps where these primitives are used in other packages, how they are tested, and what coverage gaps/risk areas currently exist.

Snapshot date: 2026-04-03.

## Public Surface

### Exports
- Local module exports: `packages/core/src/concurrency/index.ts`
  - `Semaphore`
  - `ConcurrencyPool`
  - `PoolConfig`, `PoolStats`
- Root export: `packages/core/src/index.ts` (re-exported under the main package entry)
- Facade export: `packages/core/src/facades/orchestration.ts`
  - consumable as `@dzupagent/core/orchestration`

### Intended import paths
- Core package consumers usually import from:
  - `@dzupagent/core/orchestration` (facade)
  - `@dzupagent/core` (root)
- Internal core tests import directly from source paths.

## Component 1: `Semaphore`

### What it does
A FIFO counting semaphore that caps concurrent work using permits.

Key behaviors:
- `acquire()`:
  - if permit available, decrements immediately
  - otherwise enqueues resolver in `waiting`
- `release()`:
  - if waiters exist, wakes one waiter (hands off permit directly)
  - otherwise increments permits
  - throws on over-release (`released more times than acquired`)
- `run(fn)` convenience wrapper:
  - acquires permit
  - runs async function
  - always releases in `finally`
- Introspection:
  - `available`
  - `queueLength`

### Internal state
- `permits`: current free permits
- `maxPermits`: configured capacity
- `waiting`: FIFO queue of blocked acquisitions

### Execution flow
```text
acquire()
  permits > 0 ? permits-- and continue
  : enqueue waiter and suspend

release()
  waiting not empty ? wake next waiter
  : permits++ (unless already at max => throw)
```

## Component 2: `ConcurrencyPool`

### What it does
A higher-level scheduler for async functions that combines:
- global concurrency limiting
- optional per-key concurrency limiting
- progress/stats accounting
- drain semantics (wait until idle)
- per-key semaphore lifecycle/eviction

### Feature set
- Global throttling via one `Semaphore` (`globalSem`)
- Optional keyed throttling (`maxPerKey`)
- Metrics-like counters:
  - `queued`, `completed`, `failed`
  - `active` (computed from `activeCounts`)
  - `activeKeys`
- `drain()` waiting for idle state (`active===0 && queued===0`)
- Key semaphore memory controls:
  - idle eviction (`maxIdleMsPerKey`)
  - cap on tracked keys (`maxTrackedKeys`)

### Internal structures
- `globalSem`: semaphore for total parallelism
- `keySems: Map<string, Semaphore>`: per-key semaphores when enabled
- `activeCounts: Map<string, number>`: currently active tasks per key
- `keyLastUsedAt: Map<string, number>`: LRU-ish timestamps
- `drainResolvers: Array<() => void>`: pending drain waiters

### `execute(key, fn)` lifecycle
```text
1) Resolve key semaphore (if maxPerKey configured)
2) Mark key as touched
3) queued++
4) Acquire global permit (+ key permit if enabled)
5) queued--
6) activeCounts[key]++
7) Run fn
   - success => completed++
   - error   => failed++, rethrow
8) finally:
   - activeCounts[key]-- (delete at 0)
   - release global permit
   - release key permit (if any)
   - touch key timestamp
   - evict idle key semaphores
   - resolve drain waiters if now idle
```

### Drain semantics
- `drain()` resolves immediately if already idle.
- otherwise it stores a resolver and waits until `checkDrain()` sees no active and no queued operations.
- multiple concurrent `drain()` calls are supported.

## Typical Usage Patterns

### 1) Simple semaphore (global cap)
```ts
import { Semaphore } from '@dzupagent/core/orchestration'

const sem = new Semaphore(4)

await Promise.all(items.map(async (item) => {
  await sem.acquire()
  try {
    await processItem(item)
  } finally {
    sem.release()
  }
}))
```

### 2) Safer wrapper style with `run`
```ts
import { Semaphore } from '@dzupagent/core/orchestration'

const sem = new Semaphore(4)

const result = await sem.run(async () => {
  return await expensiveOperation()
})
```

### 3) Concurrency pool with per-key fairness
```ts
import { ConcurrencyPool } from '@dzupagent/core/orchestration'

const pool = new ConcurrencyPool({
  maxConcurrent: 20,
  maxPerKey: 2,
  maxIdleMsPerKey: 60_000,
  maxTrackedKeys: 500,
})

await Promise.all(tasks.map((t) =>
  pool.execute(t.tenantId, async () => handleTask(t)),
))

await pool.drain()
console.log(pool.stats())
```

### 4) Abort-aware acquisition wrapper (pattern used downstream)
Several packages wrap `semaphore.acquire()` with `Promise.race([acquire, abort])` to support cancellation while waiting.

```ts
async function acquireSemaphore(semaphore: Semaphore, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await semaphore.acquire()
    return true
  }

  if (signal.aborted) return false

  const acquirePromise = semaphore.acquire().then(() => {
    if (signal.aborted) {
      semaphore.release()
      return false
    }
    return true
  })

  const abortPromise = new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false)
    signal.addEventListener('abort', onAbort, { once: true })
    acquirePromise.finally(() => signal.removeEventListener('abort', onAbort))
  })

  return await Promise.race([acquirePromise, abortPromise])
}
```

## Cross-Package Adoption

### Direct `Semaphore` usage from `@dzupagent/core/orchestration`
- `packages/agent/src/orchestration/map-reduce.ts`
  - controls parallel chunk execution in `mapReduce`/`mapReduceMulti`
- `packages/agent-adapters/src/orchestration/supervisor.ts`
  - bounds delegation parallelism (`maxConcurrentDelegations`) with dependency-aware scheduling
- `packages/agent-adapters/src/orchestration/map-reduce.ts`
  - bounds map phase workers (`maxConcurrency`)
- `packages/agent-adapters/src/testing/ab-test-runner.ts`
  - throttles variant x testcase x repetition jobs
- `packages/evals/src/runner/enhanced-runner.ts`
  - throttles dataset entry evaluation
- `packages/evals/src/prompt-experiment/prompt-experiment.ts`
  - throttles prompt-variant evaluation jobs

### `ConcurrencyPool` usage status
Current repository usage is effectively internal to `@dzupagent/core` tests/docs/facade exports.
No non-core package currently instantiates `ConcurrencyPool`.

Implication:
- `Semaphore` is a proven shared primitive across packages.
- `ConcurrencyPool` is available but not yet broadly adopted.

## Behavioral Guarantees and Tradeoffs

### Guarantees
- bounded concurrency when valid finite integer limits are used
- FIFO waiter queue in `Semaphore` (`waiting.shift()`)
- no permit leaks when caller follows acquire/release discipline
- `ConcurrencyPool.execute` always releases permits in `finally`
- `drain()` supports multi-caller coordination

### Tradeoffs
- cancellation is not native in `Semaphore`; callers implement abort-aware wrappers
- `ConcurrencyPool.stats()` recomputes active counts from map each call (linear in active keys)
- `ConcurrencyPool` tracks completion/failure totals cumulatively (not rolling-window)

## Test Coverage

## Direct coverage (`packages/core`)
Executed:
- `yarn workspace @dzupagent/core test -- src/__tests__/concurrency.test.ts src/__tests__/pool-drain.test.ts`

Result:
- 2 test files passed
- 20 tests passed

Covered behaviors:
- Semaphore constructor validation for `0` and negative values
- acquire/release accounting
- over-release error path
- blocking/unblocking behavior when no permits are available
- `run()` success and error release semantics
- observed concurrency cap enforcement
- ConcurrencyPool defaults/stats
- success/failure accounting
- global concurrency limiting
- per-key concurrency limiting
- active key reporting
- `drain()` behavior (empty pool, active tasks, queued tasks, multiple waiters)
- idle/tracked-key eviction basic path

### Downstream integration coverage (Semaphore-consuming packages)
Executed focused suites:
- `@dzupagent/agent`: `src/__tests__/map-reduce.test.ts` -> 37 passed
- `@dzupagent/agent-adapters`:
  - `src/__tests__/supervisor.test.ts`
  - `src/__tests__/map-reduce.test.ts`
  - `src/__tests__/ab-test-runner.test.ts`
  -> 80 passed total
- `@dzupagent/evals`:
  - `src/__tests__/eval-runner-enhanced.test.ts`
  - `src/__tests__/prompt-experiment.test.ts`
  - `src/__tests__/enhanced-runner-coverage.test.ts`
  -> 63 passed total

Covered downstream scenarios:
- max concurrency enforcement in orchestration flows
- invalid concurrency value rejection (`Infinity`, `-Infinity`, `NaN`, `0`, negative, non-integer)
- cancellation/abort handling while waiting and during execution
- queueing and progress behaviors under bounded parallelism

## Coverage Gaps / Risks

### 1) `Semaphore` input validation is incomplete
`Semaphore` currently checks only `maxPermits < 1`.
- `NaN` and `Infinity` are not rejected by that check.
- Several downstream callers protect themselves by normalizing concurrency first, but the primitive itself is public and should be defensive.

Risk:
- invalid permit math and effectively unbounded or broken behavior if instantiated directly with non-finite values.

### 2) `ConcurrencyPool` can retain unbounded `keyLastUsedAt` entries when `maxPerKey` is disabled
`execute()` calls `touchKey(key)` regardless of whether per-key semaphores are enabled.
When `maxPerKey` is undefined (default), keys are timestamped but never evicted from `keyLastUsedAt`.

Risk:
- memory growth with high cardinality key streams even when keyed limits are not in use.

### 3) No direct tests for non-finite constructor values in core primitives
Core tests verify `0` and negative for semaphore, but not `NaN`/`Infinity` at primitive level.
`ConcurrencyPool` constructor-level validation for bad numeric inputs is also not explicitly covered.

### 4) `ConcurrencyPool` adoption gap
The pool is exported and tested, but not yet used outside core tests/docs.

Risk:
- fewer real-world feedback loops on keyed eviction behavior and drain semantics under production workloads.

## Recommendations
- Harden `Semaphore` constructor validation to require finite positive integers.
- In `ConcurrencyPool`, only track `keyLastUsedAt` when keyed control is enabled, or add cleanup path when `maxPerKey` is undefined.
- Add core tests for non-finite numeric config inputs across both primitives.
- Consider migrating selected downstream semaphore wrappers to `ConcurrencyPool` where keyed fairness and drain would reduce duplicated coordination logic.

