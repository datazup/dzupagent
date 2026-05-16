# Document Alignment Re-evaluation (2026-05-16)

## Scope

Re-evaluated `dzupagent` documentation against current code for the DSL/orchestration and adapter surface discussed in May 2026.

Primary surfaces checked:
- `docs/flow-orchestration-authoring-surfaces.md`
- `packages/agent/src/orchestration/ARCHITECTURE.md`
- `packages/agent-adapters/ARCHITECTURE.md`
- `packages/agent-adapters/docs/ARCHITECTURE.md`
- `docs/CAPABILITY_MATRIX.md`
- historical internal analysis notes under `packages/agent/docs/`

## Verification Commands (Live)

- `yarn check:capability-matrix` -> pass (matrix is fresh)
- `yarn check:improvements:drift` -> pass (0 findings)
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/architecture-doc.test.ts` -> pass (6 tests)
- `yarn workspace @dzupagent/agent test src/__tests__/planning-agent.test.ts src/__tests__/delegating-supervisor.test.ts` -> pass (52 tests)

All commands were run with `corepack yarn@1.22.22`.

## What Is Aligned

1. Authoring-surface boundary documentation is consistent with live code.
- `docs/flow-orchestration-authoring-surfaces.md` correctly distinguishes:
  - canonical flow surfaces (`FlowDocumentV1`, `dzupflow/v1`)
  - adapter workflow builder
  - orchestration execution plan
  - team runtime
- It correctly marks planning/team lowering as future work, not current behavior.

2. Duplicate-specialist planning identity docs are aligned to implementation.
- `packages/agent/src/orchestration/ARCHITECTURE.md` states node-id-based assignment identity and warn/strict guardrails.
- Code path aligns:
  - `TaskAssignment.id = node.id` on planning path
  - `aggregateSettledResults()` uses `assignment.id ?? specialistId`
  - duplicate-specialist guard event is emitted for legacy direct callers.

3. `agent-adapters` architecture docs are aligned with package export planes.
- Both:
  - `packages/agent-adapters/ARCHITECTURE.md`
  - `packages/agent-adapters/docs/ARCHITECTURE.md`
- match current subpath exports and include `./runs` and `./integration`.
- Guard test enforcing doc/export consistency is green:
  - `packages/agent-adapters/src/__tests__/architecture-doc.test.ts`

## What Still Needs Alignment

1. Capability matrix export extraction still misrepresents some re-export packages.
- `docs/CAPABILITY_MATRIX.md` still reports `_No public exports detected in src/index.ts._` for packages that do export symbols via `export *`:
  - `@dzupagent/flow-dsl`
  - `@dzupagent/runtime-contracts`
- This is a generator/extraction limitation, not a stale timestamp issue.
- Alignment needed:
  - adjust matrix generation logic to resolve re-exported symbols from index barrels.

2. Historical internal analysis note in `packages/agent/docs` is stale vs current implementation.
- `packages/agent/docs/analyze_codex.md` still calls duplicate-specialist result-keying a high-severity live bug.
- Current implementation already includes assignment-id-aware aggregation and direct-caller guardrails.
- Alignment needed:
  - update or archive-mark that note as historical to avoid false “active bug” interpretation.

## Current Reality Snapshot

- Documentation freshness gates are passing.
- Architecture docs for DSL/orchestration boundaries and adapter export planes are currently coherent with code.
- Main remaining doc-quality issue is not freshness, but **semantic extraction accuracy** in capability matrix generation and **historical note staleness**.

## Recommended Next Alignment Steps

1. Fix capability-matrix extractor for re-export barrels, then regenerate and recheck.
2. Add a “historical snapshot” banner or refresh pass for `packages/agent/docs/analyze_codex.md`.
3. Keep the existing architecture-doc guard tests in the CI lane; they are catching real drift for adapter docs.
