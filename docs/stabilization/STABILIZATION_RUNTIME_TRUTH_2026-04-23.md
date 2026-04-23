# Runtime Truth Stabilization (2026-04-23)

## Goal

Make run lifecycle reporting truthful across queueing, execution, cancellation, persistence, and trace emission so operators and consumers can trust reported state.

Current shared status:
- `partially done`

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md)

Detailed analysis references:
- [`../analyze-full_2026_04_21/07_operability_and_release_readiness.md`](../analyze-full_2026_04_21/07_operability_and_release_readiness.md)
- [`../analyze-full_2026_04_21/11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md)
- [`../analyze-full_2026_04_21/03_architecture_review.md`](../analyze-full_2026_04_21/03_architecture_review.md)

## Scope

Primary paths:
- `packages/server/src/runtime/run-worker.ts`
- `packages/server/src/routes/runs.ts`
- `packages/server/src/routes/run-trace.ts`
- `packages/server/src/persistence/`
- `packages/server/src/queue/`

Secondary paths when required by the same lifecycle contract:
- `packages/agent/src/agent/run-engine.ts`
- `packages/core/src/events/`

## Risks To Remove

1. Terminal state does not reliably reflect worker-side outcome.
2. Cancellation can report success before queue/runtime acknowledgement.
3. Queue wiring and worker availability are not explicit enough for truthful startup behavior.
4. Trace and persistence paths can diverge from emitted lifecycle status.

## Evidence Baseline

Tracked 2026-04-23 proof already recorded in the rebaseline:
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test -- src/__tests__/run-trace-lifecycle.test.ts src/__tests__/runs-resume-semantics.test.ts src/__tests__/session-q-halted-run-status.test.ts`

Open evidence gaps from the analysis pack:
- BullMQ cancellation semantics are still identified as unsafe.
- Execution path can drift if queue/worker wiring is optional or misleading.
- Large concentration of runtime behavior still lives inside `run-worker.ts` and `runs.ts`.

## Required Work

### 1. Pin the execution invariant

Required outcome:
- Run creation must not imply successful execution when no active worker path exists.

What to check:
- startup behavior when `runQueue` is omitted
- comment/config truth in `createForgeApp`
- response semantics when execution is accepted but not yet guaranteed

Exit condition:
- either a real fallback worker path exists and is verified, or startup/creation fails closed in unsupported modes

### 2. Make cancellation truthful end-to-end

Required outcome:
- a run is not reported `cancelled` until queue/runtime acknowledgement exists for the active backend

What to check:
- in-memory queue cancellation
- BullMQ cancellation by `runId`
- cancellation vs terminal completion race
- cancellation vs resume behavior

Exit condition:
- queue backend behavior is explicit, covered, and reflected in route semantics

### 3. Reconcile trace and persistence truth

Required outcome:
- run state, trace headers/steps, and emitted events agree on lifecycle transitions

What to check:
- `startTrace`
- `addStep`
- terminal trace closure
- persistence behavior on retries, resume, and halted paths

Exit condition:
- no reviewed path can emit a terminal state without matching persistence/trace outcome

### 4. Narrow the hotspot surface

Required outcome:
- runtime changes stop spreading across unrelated server modules

What to check:
- whether route/business logic can move behind a small runtime service seam during stabilization
- whether lifecycle helpers can be extracted without widening behavior

Exit condition:
- runtime fixes land through a controlled seam instead of continued route-layer sprawl

## Verification Requirements

Minimum proof before closing this area:

1. `yarn workspace @dzupagent/server typecheck`
2. `yarn workspace @dzupagent/server test -- src/__tests__/run-trace-lifecycle.test.ts src/__tests__/runs-resume-semantics.test.ts src/__tests__/session-q-halted-run-status.test.ts`
3. Focused cancellation coverage for the active queue backend
4. Focused persistence/trace coverage for any touched lifecycle transition

Recommended additional proof when queue semantics change:

1. backend-specific queue tests
2. resume/cancel race tests
3. route tests covering returned status semantics

## Completion Rule

Do not mark this area `done` unless:

1. lifecycle reporting, cancellation semantics, and persistence wiring have been reviewed together
2. reported terminal states are backed by real execution/queue truth
3. exact verification commands and outcomes are recorded in the rebaseline

## Explicit Non-Goals During This Tranche

1. Net-new runtime features
2. Broad server refactors outside lifecycle correctness
3. Consumer-facing contract changes unless they are required to fix runtime truth and are recorded as compatibility changes
