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
- [`docs/stabilization/STABILIZATION_HANDOFF_MEMORY_2026-04-23.md`](./stabilization/STABILIZATION_HANDOFF_MEMORY_2026-04-23.md)
- [`docs/DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md`](./DZUPAGENT_RESEARCH_PLANNING_PIPELINE_2026-04-25.md)

Rule:
- area documents can expand the work, but they must not weaken the exit rules in this tracked rebaseline

## Current Findings

### What Is Green In The Current Session

- `yarn check:improvements:drift`
- `yarn test:inventory:runtime:strict`
- `yarn check:workspace:coverage`
- `yarn check:waiver-expiry`
- `yarn check:capability-matrix`
- `yarn check:domain-boundaries`
- `yarn check:terminal-tool-event-guards`
- `yarn workspace @dzupagent/agent-adapters test -- src/__tests__/process-helpers.test.ts src/__tests__/process-helpers-branches.test.ts src/__tests__/session-registry.test.ts src/__tests__/adapter-conformance.contract.test.ts src/__tests__/cli-smoke.test.ts`
- `yarn workspace @dzupagent/agent-adapters test:coverage`
- `yarn workspace create-dzupagent typecheck`
- `yarn workspace create-dzupagent lint`
- `yarn workspace create-dzupagent test`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server lint`
- `yarn workspace @dzupagent/server test`
- `yarn workspace @dzupagent/codegen test`
- `yarn workspace @dzupagent/server test -- src/__tests__/run-trace-lifecycle.test.ts src/__tests__/runs-resume-semantics.test.ts src/__tests__/session-q-halted-run-status.test.ts`
- `yarn workspace @dzupagent/server test -- src/__tests__/api-key-wiring.test.ts src/routes/__tests__/api-keys.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`
- `yarn workspace @dzupagent/server test -- src/__tests__/compile-routes.test.ts src/__tests__/workflow-routes.test.ts`
- `yarn verify:strict`
- `yarn verify`
- `yarn lint`

### What Is Still Open

- Public naming and vocabulary still drift across `DzupAgent`, `Forge`, and `DZIP` surfaces in `server`, scaffolder output, logs, and env vars.
- Producer/consumer contract drift is still a risk across `server`, `playground`, scaffolding, and docs, especially where one codepath owns route behavior but multiple surfaces describe it.
- Version and generated-doc truth improved in this wave, but the repo still lacks single-source ownership for several shared truth surfaces and still requires same-wave regeneration discipline.
- Root lint participation is now workspace-complete and warning-clean in the current session.

## Drift Diagnosis

The current drift is best understood in four buckets:

1. Execution truth drift:
   this was the main blocker at the start of the session and is now materially reduced. `yarn verify:strict` has been observed green end to end, and the highest-risk package slices were revalidated locally before widening back out.
2. Generated truth drift:
   generated artifacts such as `docs/CAPABILITY_MATRIX.md` can fall behind as soon as export surfaces change. This wave removed the brittle tooling path, but the workflow still depends on regenerating artifacts in the same execution wave as source changes.
3. Contract truth drift:
   active seams across `server`, `playground`, scaffolder output, and docs still do not have one explicit canonical owner per wire contract. That means local green tests can coexist with downstream confusion if route, envelope, or status semantics drift.
4. Naming and policy drift:
   mixed `DzupAgent` / `Forge` / `DZIP` vocabulary and the root-lint skip set both weaken the repo's trust model. Even when tests are green, ambiguous names and silent policy gaps make it harder to reason about what is stable, public, and governed.

The practical implication is that the repo has moved beyond "unknown state" and into late-stage stabilization. The next tranche should minimize new drift by forcing code, generated truth, contract truth, and naming/policy truth to land together.

## Workstream Status

Legend:
- `done`: revalidated in the current 2026-04-23 session
- `partially done`: some targeted checks are green, but completion criteria are not fully revalidated
- `not done`: not yet revalidated in the current session

| Workstream | Status | Evidence |
|---|---|---|
| Verification baseline refresh | done | Strict preflight checks are green, `@dzupagent/agent-adapters` coverage is restored, capability-matrix tooling is hermetic enough for sandboxed runs, and `yarn verify:strict` completed successfully. |
| Server runtime truth | done | `@dzupagent/server` typecheck, lint, targeted runtime/auth/compile/workflow tests, and the full package test lane are green in the current session. |
| Server auth and secret boundaries | partially done | Targeted auth/control-plane tests are green and the full `server` test lane passes, but explicit ownership and compatibility proof still need convergence across consumers and docs. |
| Contract convergence across producers/consumers | not done | No shared 2026-04-23 checkpoint yet across `server`, `playground`, scaffolder, and docs. |
| Release/docs status truth | partially done | Capability-matrix tooling is now plain-Node and hermetic enough for sandboxed runs, `create-dzupagent` now emits `0.2.0` truth, `yarn verify`, `yarn verify:strict`, and `yarn lint` are all green, and the remaining gaps are naming and ownership drift rather than broken generation paths or stale high-traffic version docs. |
| `agent-adapters` test naming drift | done | All `src/__tests__` files import `ProviderAdapterRegistry`; zero bare deprecated references remain. 117/117 tests pass for the workflow/orchestration/map-reduce cluster. Typecheck clean. 2026-04-25. |

## Next Tasks

### 1. Reduce Public Naming And Vocabulary Drift

Scope:
- `packages/server/src/index.ts`
- `packages/server/src/cli/`
- `packages/server/src/runtime/`
- `packages/create-dzupagent/`
- high-traffic docs and READMEs

Required verification:
- `rg -n "createForgeApp|ForgeServerConfig|forge-|DZIP_|dzip-agent" packages/server packages/create-dzupagent docs`
- rerun the narrowest package-local checks for any touched surfaces
- update docs/examples in the same wave as any public rename or aliasing decision

Exit rule:
- Do not treat naming cleanup as complete while one product surface still presents overlapping `DzupAgent`, `Forge`, and `DZIP` terms without an explicit compatibility rationale.

### 2. Reconcile Contract Drift On Active Seams

Scope:
- `packages/server/src/routes/`
- `packages/playground/src/`
- `packages/create-dzupagent/`
- `docs/`

Required verification:
- focused server tests on any changed route contracts
- smallest consumer-facing checks that prove payload, envelope, and status semantics still match
- doc/example updates in the same wave as contract changes
- for scaffolder truth changes, rerun:
  - `yarn workspace create-dzupagent typecheck`
  - `yarn workspace create-dzupagent lint`
  - `yarn workspace create-dzupagent test`

Exit rule:
- No contract-affecting change closes without server verification plus either a consumer update or an explicit compatibility note.

### 3. Reduce Generated-Truth And Version-Truth Drift At The Source

Required verification:
- `yarn docs:capability-matrix`
- `yarn check:capability-matrix`
- `yarn workspace create-dzupagent test`
- `rg -n "five built-in templates|0\\.1\\.0|\\^0\\.1\\.0" packages/create-dzupagent packages/*/README.md`

Exit rule:
- Do not mark this done while version identity, template inventory, or generated docs still require manual detective work to determine current truth.

### 4. Preserve Root Lint Signal Quality

Required verification:
- `yarn lint`
- if warnings return, record the exact files and counts immediately rather than treating warning-only output as acceptable steady state

Exit rule:
- Do not let later sessions regress from the current warning-clean root lint baseline.

### 5. Widen Back To The Broader Verification Lane

Required verification:
- `yarn verify`
- keep the exact completed result in the stabilization record so later sessions do not regress to vague status language

Exit rule:
- Do not let later tracked docs fall back to claiming the broader baseline is unknown when the current session has already observed it green.

## Execution Rules To Minimize Drift

1. Treat package-scoped checks as the first proof point, then widen to workspace gates.
2. Update plan status only after code and verification both land.
3. If a route, contract, or auth surface changes, update tests and docs in the same execution wave.
4. Record exact failing commands rather than replacing them with generic "still in progress" wording.
5. Do not use a passing doc-drift check as a substitute for live workspace revalidation.
6. If an exported surface changes, regenerate the tracked generated artifacts in the same wave.
7. If scaffolder defaults change, rerun scaffolder tests in the same wave so stale template truth does not persist.
