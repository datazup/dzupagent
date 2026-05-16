# DSL/Orchestration Residual Gap Analysis (2026-05-16)

## Scope

This gap analysis re-checks the May 2–3, 2026 DSL/orchestration + docs/contracts lane against the **current live tree** in `dzupagent`.

Focus:
- flow authoring surfaces (`flow-dsl`, `flow-compiler`, orchestration planning/team contracts)
- docs/contracts guardrails added in May
- neutral script-run primitives and export surfaces

## Confirmed Closed

- Duplicate-specialist collision hardening is live and tested:
  - `DuplicateSpecialistAssignmentIdMode` + warning event guard exists.
  - `aggregateSettledResults()` now keys by `assignment.id ?? specialistId`.
  - Evidence:
    - `packages/agent/src/orchestration/parallel-delegation-aggregator.ts:58`
    - `packages/agent/src/orchestration/assignment-validator.ts:91`
- Authoring-surface matrix exists and is referenced by architecture doc checks:
  - `docs/flow-orchestration-authoring-surfaces.md`
  - `packages/agent-adapters/src/__tests__/architecture-doc.test.ts`
- Neutral run contracts + store + subpath exports are live:
  - `@dzupagent/runtime-contracts` exports `script-runs`.
  - `ScriptRunEventStore` is implemented in `agent-adapters`.
  - `agent-adapters` exports `./runs` and `./integration`.

Focused validations run on 2026-05-16 (Yarn 1.22.22):
- `yarn workspace @dzupagent/agent test src/__tests__/planning-agent.test.ts src/__tests__/delegating-supervisor.test.ts` (52 passed)
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/architecture-doc.test.ts src/__tests__/script-run-event-store.test.ts src/__tests__/agent-adapters-export-map.test.ts` (16 passed)
- `yarn workspace @dzupagent/runtime-contracts test src/__tests__/script-runs-contracts.test.ts` (2 passed)

## Remaining Gaps (Severity-Ranked)

### High

1. No explicit `FlowDocumentV1` -> planning DAG or team-runtime lowering contract is implemented.
- Impact:
  - The matrix still marks this as future-only, so there is no canonical compiler-to-orchestration bridge for planning/team targets.
  - Cross-surface correlation remains manual/ad hoc in consumers.
- Evidence:
  - Matrix marks planning/team lowering as future: `docs/flow-orchestration-authoring-surfaces.md:41-43`
  - Compiler targets are limited to `skill-chain | workflow-builder | pipeline`: `packages/flow-compiler/src/types.ts:56`

### Medium

2. `ExecutionPlan` and `PlanNode` do not carry compile provenance/evidence fields.
- Impact:
  - Even though compiler evidence exists (`sourceKind`, `sourceHash`, `compileId`, `correlationIds`), orchestration plan types cannot preserve it.
  - This blocks an end-to-end audit trail from compiled flow -> delegated node execution without external side channels.
- Evidence:
  - Planning types only include `goal`, `nodes`, execution levels, and diagnostics (no provenance): `packages/agent/src/orchestration/planning-types.ts:18-42`
  - Compiler evidence already defines provenance payloads: `packages/flow-compiler/src/types.ts:134-147`
  - Matrix explicitly calls out `planId` and additional lowered target labels as future: `docs/flow-orchestration-authoring-surfaces.md:77-82`

3. Capability matrix process is currently drift-prone and partially misleading for re-export-only packages.
- Impact:
  - `check:capability-matrix` fails until the generated matrix is refreshed/committed.
  - Generated matrix still reports `_No public exports detected_` for packages that re-export from index (`flow-dsl`, `runtime-contracts`), which can mislead surface audits.
- Evidence:
  - Freshness check failed and required regeneration (`yarn check:capability-matrix`).
  - Current generated matrix lines:
    - `docs/CAPABILITY_MATRIX.md:29`
    - `docs/CAPABILITY_MATRIX.md:35`
    - `docs/CAPABILITY_MATRIX.md:210`
    - `docs/CAPABILITY_MATRIX.md:258`
  - Actual exports exist:
    - `packages/flow-dsl/src/index.ts`
    - `packages/runtime-contracts/src/index.ts`

### Low

4. One internal analysis doc is stale and now contradicts current implementation.
- Impact:
  - Future maintainers can chase an already-fixed “high severity” issue.
- Evidence:
  - Stale claim still says aggregation keys only by specialist ID: `packages/agent/docs/analyze_codex.md:35-41`
  - Live implementation now keys by assignment ID fallback: `packages/agent/src/orchestration/parallel-delegation-aggregator.ts:58-70`

## Recommended Next Implementation Slices

1. Introduce `planning-dag` as an explicit lowered target contract.
- Add target enum + contract shape (do not wire runtime execution in same slice).
- Acceptance:
  - `flow-compiler` type surface exposes `planning-dag`.
  - Evidence payload includes target label.
  - Backward compatibility for existing targets preserved.

2. Add provenance fields to orchestration plan contracts.
- Extend `ExecutionPlan` / `PlanNode` with optional compile provenance block:
  - `sourceKind`, `sourceHash`, `compileId`, `loweredTarget`, `eventCorrelationId`, optional `planId`.
- Acceptance:
  - planning/delegation tests still pass.
  - No product fields added (tenant/workspace/project/task remain app-owned).

3. Fix capability-matrix exporter blind spot for index re-exports.
- Improve generation so packages with `export *` in `src/index.ts` are reflected accurately.
- Acceptance:
  - matrix section for `flow-dsl` / `runtime-contracts` no longer shows false `_none exported_`.
  - `yarn check:capability-matrix` passes after one generation cycle.

4. Remove/update stale internal analyze note.
- Update `packages/agent/docs/analyze_codex.md` to avoid reporting fixed issues as live findings.

## Verification Plan for Next Pass

- Contract-only slice:
  - `yarn workspace @dzupagent/flow-compiler test`
  - `yarn workspace @dzupagent/agent test src/__tests__/planning-agent.test.ts src/__tests__/delegating-supervisor.test.ts`
  - `yarn workspace @dzupagent/agent typecheck`
- Docs/tooling slice:
  - `yarn docs:capability-matrix`
  - `yarn check:capability-matrix`
