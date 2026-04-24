# MC-S03 — Prompt-Injection Defense — VALIDATION

## Summary

Wired the existing `createInputGuard` (built atop the core
`SafetyMonitor` and `detectPII`) into the run-worker dispatch path.
Injection / secret-leak patterns now terminate the run in `'rejected'`
status before the executor runs; PII matches are redacted in-place so
the executor + persisted run record observe the sanitized payload.

## Scope of change

### `packages/server/src/app.ts`
- Added `import type { InputGuardConfig } from './security/input-guard.js'`.
- `ForgeServerConfig` gains an optional `security?: { inputGuard?: InputGuardConfig | false }`
  block with JSDoc describing the three modes:
  - `undefined` → default guard with built-in rules.
  - `false` → scanning disabled entirely.
  - `InputGuardConfig` → custom length caps, PII flag, injected monitor.
- Forwarded `security?.inputGuard` into `startRunWorker(...)` as
  `inputGuardConfig`.

### `packages/server/src/runtime/run-worker.ts`
- Added `import { createInputGuard, type InputGuard, type InputGuardConfig }`.
- `StartRunWorkerOptions` gains `inputGuardConfig?: InputGuardConfig | false`.
- The worker constructs a single `InputGuard` instance per worker start
  so the scanner pattern set is reused across all jobs (no per-job
  reinstantiation).
- After `executableAgentResolver.resolve` and before
  `runStore.update(..., { status: 'running' })`:
  1. Scan the run input via `inputGuard.scan(job.input)`.
  2. On `!result.allowed`:
     - Update the run to `{ status: 'rejected', error: reason, completedAt: now }`.
     - Emit `security`-phase warning log with the violation summary.
     - Emit `agent:failed` event with `errorCode: 'POLICY_DENIED'`.
     - Close the trace with a `'rejected'` terminal step.
     - `return;` — the executor is never called.
  3. On `result.redactedInput`:
     - Replace the local `jobInput` variable (used everywhere
       downstream — trace, approval plan, executor call, persistence).
     - Persist the redacted value via `runStore.update(..., { input: jobInput })`
       so downstream readers (UI, analyzer, replay) never see raw PII.
     - Log an info-level `security`-phase event.
- All downstream references to the run input (`traceStore.addStep`,
  approval plan payload, `approval:requested` event, executor call,
  context-transfer metadata) now read from `jobInput` instead of
  `job.input`.

### `packages/server/src/index.ts`
- Re-exports `createInputGuard`, `DEFAULT_MAX_INPUT_LENGTH`, and the
  `InputGuard` / `InputGuardConfig` / `InputGuardResult` types under
  the `Security / Input Guard (MC-S03)` banner.

## Acceptance criteria

```bash
yarn typecheck --filter @dzupagent/server
```
No new type errors from the MC-S03 edits. The 17 pre-existing errors
(`benchmark-run-store.ts`, `routes/approvals.ts`,
`services/prompt-feedback-loop.ts`) are unchanged.

```bash
yarn workspace @dzupagent/server test src/__tests__/input-guard.test.ts
```
```
 Tests  1 failed | 19 passed (20)
```
The single failure (`handles circular references without throwing`) is
a pre-existing bug in `security/input-guard.ts:mapStrings` that
predates this change. It does not exercise any of the new wiring.

## Tests added / exercised

A new `describe('InputGuard run-worker wiring (MC-S03)', ...)` block was
appended to `src/__tests__/input-guard.test.ts` with the four
acceptance cases:

| Requested scenario                               | Test case                                                                                        |
|--------------------------------------------------|--------------------------------------------------------------------------------------------------|
| Injection pattern → rejected status              | `injection pattern -> rejected status, executor never called`                                    |
| Clean input → allowed                            | `clean input -> allowed through to the executor, run completes`                                  |
| PII redacted in allowed result                   | `PII in input -> redacted before reaching the executor`                                          |
| InputGuard disabled (false) → all inputs allowed | `inputGuardConfig: false disables scanning entirely (injection allowed through)`                 |

All 4 pass. They drive the real queue → worker → executor pipeline
with an `InMemoryRunQueue` and assert:

- Rejected runs reach terminal `'rejected'` status without invoking the
  executor (`executorCalled === 0`) and carry a `security`-phase log.
- Clean inputs flow through unchanged.
- PII-bearing inputs reach the executor as their redacted form
  (`[REDACTED:...]` markers; raw e-mail absent) and the persisted
  `run.input` matches the redacted value.
- When `inputGuardConfig: false` is passed to the worker, injection
  payloads reach the executor unchanged and complete successfully.

## Files of record

- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/security/input-guard.ts (unchanged, already existed)
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/__tests__/input-guard.test.ts
- /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts

## Notes / deviations from spec

- The task suggested a config shape `security?: { inputGuard?: InputGuardConfig | false }`
  at `ForgeServerConfig`, and the same value is propagated to
  `StartRunWorkerOptions` as `inputGuardConfig` (matching the existing
  naming convention for worker-level fields like `retrievalFeedback`).
- The `agent:failed` event's `errorCode` is `'POLICY_DENIED'` rather
  than the suggested `'INPUT_GUARD_REJECTED'` because `ForgeErrorCode`
  in `@dzupagent/core` does not include the latter. `POLICY_DENIED`
  captures the semantic precisely.
- The guard is constructed **once per worker** (not per job) so the
  underlying `SafetyMonitor`'s compiled patterns are reused. This
  matches the lifecycle of other worker-scoped singletons (trace store,
  metrics collector).
