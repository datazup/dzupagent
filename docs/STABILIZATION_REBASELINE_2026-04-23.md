# Stabilization Rebaseline (2026-04-23)

## Why This Exists

The earlier `CORE_AGENT_ADAPTERS_IMPLEMENTATION_PLAN` completed its original wave, but the live workspace has moved well beyond that scope. On 2026-04-23, the active change surface is concentrated in:

- `packages/server`: 77 paths
- `packages/agent`: 51 paths
- `packages/agent-adapters`: 42 paths
- `packages/core`: 30 paths

That means the repo needs a fresh, tracked execution plan focused on trust restoration and drift control rather than continuing to rely on a historical "all done" narrative.

## Companion Stabilization Docs

Use this file as the shared session-level source of truth, then use the tracked companion docs under [`docs/stabilization/`](./stabilization/README.md) for area-specific execution:

- [`docs/stabilization/STABILIZATION_MATRIX_2026-04-23.md`](./stabilization/STABILIZATION_MATRIX_2026-04-23.md)
- [`docs/stabilization/STABILIZATION_RUNTIME_TRUTH_2026-04-23.md`](./stabilization/STABILIZATION_RUNTIME_TRUTH_2026-04-23.md)
- [`docs/stabilization/STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md`](./stabilization/STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md)
- [`docs/stabilization/STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md`](./stabilization/STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md)
- [`docs/stabilization/STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md`](./stabilization/STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md)
- [`docs/stabilization/STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md`](./stabilization/STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md)

Rule:
- area documents can expand the work, but they must not weaken the exit rules in this tracked rebaseline

## Current Findings

### What Is Green In The Current Session

- `yarn check:improvements:drift`
- `yarn test:inventory:runtime`
- `yarn check:domain-boundaries`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test -- src/__tests__/run-trace-lifecycle.test.ts src/__tests__/runs-resume-semantics.test.ts src/__tests__/session-q-halted-run-status.test.ts`
- `yarn workspace @dzupagent/server test -- src/__tests__/api-key-wiring.test.ts src/routes/__tests__/api-keys.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`

### What Is Still Open

- `verify` and `verify:strict` have not been re-run in this session.
- The broad `server` change set is only partially revalidated.
- Producer/consumer contract drift is still a risk across `server`, `playground`, scaffolding, and docs.
- Release/docs truth is not yet aligned with the live workspace.

## Drift Diagnosis

The main drift is process drift, not just code drift:

1. Historical implementation plans are complete, but they are no longer the active control document for the current workspace.
2. `check:improvements:drift` only proves that docs agree with docs; it does not prove that the repo still matches the last documented execution story.
3. The most active packages are also the highest-risk runtime packages, so stale status claims now create coordination and release risk.

## Workstream Status

Legend:
- `done`: revalidated in the current 2026-04-23 session
- `partially done`: some targeted checks are green, but completion criteria are not fully revalidated
- `not done`: not yet revalidated in the current session

| Workstream | Status | Evidence |
|---|---|---|
| Verification baseline refresh | partially done | Drift/runtime inventory/domain-boundary checks are green; full `verify` and `verify:strict` remain open. |
| Server runtime truth | partially done | Typecheck and 19 targeted lifecycle tests are green, but the broader `server` wave still needs deeper route/persistence review. |
| Server auth and secret boundaries | partially done | 76 targeted control-plane/auth tests are green, but touched routes still need explicit revalidation against current analysis-pack guidance. |
| Contract convergence across producers/consumers | not done | No shared 2026-04-23 checkpoint yet across `server`, `playground`, scaffolder, and docs. |
| Release/docs status truth | in progress | Rebaseline exists, but shared tracked documentation needs to stay synchronized with future execution. |

## Next Tasks

### 1. Finish Server Runtime Truth Revalidation

Scope:
- `packages/server/src/runtime/run-worker.ts`
- `packages/server/src/routes/runs.ts`
- `packages/server/src/routes/run-trace.ts`
- `packages/server/src/persistence/`

Required verification:
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test -- src/__tests__/run-trace-lifecycle.test.ts src/__tests__/runs-resume-semantics.test.ts src/__tests__/session-q-halted-run-status.test.ts`
- Add or update focused tests if any terminal-state or cancellation behavior changed without direct coverage

Exit rule:
- Do not mark this done unless lifecycle reporting, cancellation semantics, and persistence wiring are all rechecked together.

### 2. Finish Server Auth And Secret-Boundary Revalidation

Scope:
- `packages/server/src/app.ts`
- `packages/server/src/routes/api-keys.ts`
- `packages/server/src/routes/openai-compat/`
- `packages/server/src/routes/compile.ts`
- `packages/server/src/routes/compile-result-event.ts`
- `packages/server/src/middleware/`

Required verification:
- `yarn workspace @dzupagent/server test -- src/__tests__/api-key-wiring.test.ts src/routes/__tests__/api-keys.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`
- Add denial-path coverage for any touched endpoint that mutates keys, prompts, compile execution, or compatibility routes

Exit rule:
- Do not mark this done without explicit unauthorized or owner-scope denial coverage for touched endpoints.

### 3. Reconcile Contract Drift On Active Seams

Scope:
- `packages/server/src/routes/`
- `packages/playground/src/`
- `packages/create-dzupagent/`
- `docs/`

Required verification:
- Focused server tests on any changed route contracts
- Smallest consumer-facing checks that prove the payload and status semantics still match
- Doc/example updates in the same wave as contract changes

Exit rule:
- No contract-affecting change closes without server verification plus either a consumer update or a deliberate compatibility note.

### 4. Restore Authoritative Workspace Gates

Required verification:
- `yarn verify`
- `yarn verify:strict`

Exit rule:
- If either fails, record the exact failing package/check before taking on unrelated work.

## Execution Rules To Minimize Drift

1. Treat package-scoped checks as the first proof point, then widen to workspace gates.
2. Update plan status only after code and verification both land.
3. If a route, contract, or auth surface changes, update tests and docs in the same execution wave.
4. Record exact failing commands rather than replacing them with generic "still in progress" wording.
5. Do not use a passing doc-drift check as a substitute for live workspace revalidation.
