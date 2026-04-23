# Recommendations And Roadmap - dzupagent (2026-04-21)

## Executive Summary
`dzupagent` has strong platform depth and engineering investment, but the main risk is no longer missing capability. The primary gaps are correctness trust, secure defaults on high-impact surfaces, and incomplete productization of already-implemented features.

The most important conclusions are:

1. Control-plane correctness must be fixed first. Current queue/cancel behavior can report terminal states without guaranteed worker-side effect, especially in BullMQ mode.
2. Security posture is not yet secure-by-default for advanced endpoints (`/a2a*`, `/v1/*`, `/api/mcp/*`) and secret-bearing responses.
3. Verification/release signals are too brittle to be release-authoritative today (`verify:strict` artifact preconditions, publish pipeline missing full gates).
4. Architecture and performance bottlenecks are concentrated in known hotspots (`createForgeApp`, `run-worker`, heavy route modules, unpaginated logs/trace, timer-heavy SSE/polling patterns).
5. Feature delivery should focus on surfacing what already exists (capability matrix, compile/capability UI routing, trigger lifecycle wiring, scaffolder contract alignment) before large greenfield expansion.
6. External comparison suggests a clear strategy: keep enterprise/runtime strengths, but close contract clarity and product-surface maturity gaps selectively.

## Repository Overview
`dzupagent` is a Yarn 1 + Turbo TypeScript monorepo with platform scope across runtime SDK, server, adapters, memory/RAG, playground UI, testing/evals, and scaffolding.

Current shape and constraints relevant to roadmap sequencing:

- Scale: large package/test surface with high route density and many optional subsystems.
- Maturity: strong CI/testing/security scaffolding exists, but several high-impact checks currently fail or drift due artifact/order issues.
- Complexity concentration: risk is localized in a few orchestration-heavy modules (`packages/server/src/app.ts`, `run-worker`, `routes/runs.ts`, `routes/learning.ts`) rather than uniformly distributed.
- Productization gap: multiple features exist in code but are not fully wired into route exports, router/nav, or operator docs.
- Operational reality: deploy/readiness/release surfaces are present but not yet fully enforceable as production gates.

This is a “strong internals, uneven contracts” repository. The roadmap should prioritize trust and contract integrity first, then structural scalability, then product reach.

## Strategic Priorities
1. Re-establish runtime correctness and verification trust.
2. Enforce secure-by-default behavior on protocol/control-plane endpoints.
3. Reduce hotspot coupling in `@dzupagent/server` so high-change areas are safer to evolve.
4. Remove known read/write amplification and timer-scaling bottlenecks before load growth.
5. Close high-ROI feature wiring gaps (already implemented, not fully reachable).
6. Make docs/version/release metadata authoritative and automation-backed.
7. Import external patterns selectively using adjacency and risk filters, not broad parity chasing.

## Priority Roadmap
### Immediate (0-2 sprints)
1. Fix execution and cancellation invariants.
Dependency: none.
Expected impact: removes the highest operational correctness risk.
Actions: enforce queue/worker execution invariant (or fail startup), implement truthful BullMQ cancel semantics by `runId`, transition to `cancelled` only after queue-level acknowledgement, add cancel-race integration tests.

2. Close high-severity auth and authorization gaps.
Dependency: can run in parallel with item 1.
Expected impact: prevents unauthorized control-plane access and secret leakage.
Actions: require auth on `/a2a*`; fail-closed `/v1/*` unless explicit validator policy is configured; admin-gate `/api/mcp/*`; add owner checks for API key rotate/revoke; redact MCP and trigger secret-bearing fields.

3. Make strict verification hermetic and release-relevant.
Dependency: complete before changing publish policy.
Expected impact: turns CI red/green into trustworthy engineering signal.
Actions: generate coverage artifacts before workspace coverage checks; move docs freshness checks to separate required lane; ensure strict check order reflects product correctness, not artifact presence.

4. Patch top documentation truth blockers.
Dependency: parallelizable; must finish before doc-gate hardening.
Expected impact: reduces onboarding and migration misconfiguration.
Actions: resolve MIGRATION preset contradiction, restore docs hub/capability matrix artifact flow, align version truth (`0.2.x`) across runtime constants and health endpoints, fix server README auth/path examples.

### Short-Term (1-2 months)
1. Decompose server layering.
Dependency: immediate correctness/security baseline complete.
Expected impact: lower regression probability and faster feature work.
Actions: extract application services from `runs`, `learning`, `workflows`, `compile`; remove `LearningEventProcessor -> routes/learning.ts` dependency inversion; split `createForgeApp` into deterministic installers.

2. Harden operability and release engineering.
Dependency: hermetic verification lane available.
Expected impact: safer deploy/rollback posture.
Actions: add `db:migrate` and `db:migrate:check`; enforce migration checks in CI/publish; wire deploy-confidence checks as release gates; improve readiness truthfulness (real version source, degraded status for critical unconfigured subsystems, accurate async queue stats).

3. Apply first-wave scalability fixes.
Dependency: correctness and telemetry baseline available.
Expected impact: immediate p95 and payload-size reduction on dominant paths.
Actions: paginate `/api/runs/:id/logs` and `/api/runs/:id/trace`; add run-log indexes (`run_id`, `timestamp`); add in-memory queue caps (`maxPending`, `maxDeadLetter`); fix terminal status parity (`halted`) to stop unnecessary polling.

4. Repair scaffolder contract reliability.
Dependency: canonical server config/auth contract stabilized.
Expected impact: fewer downstream integration failures.
Actions: align template-generated config keys with current server types, normalize template/version claims (9 templates vs stale docs), add scaffold smoke tests in CI.

### Medium-Term (1-2 quarters)
1. Productize automation beyond CRUD.
Dependency: service-layer refactor + security defaults.
Expected impact: unlock trigger/schedule product value.
Actions: lifecycle-wire `TriggerManager`, enforce signed webhook policy, add execution telemetry/retry policy and operational visibility for trigger/schedule runtime.

2. Scale runtime and analytics architecture.
Dependency: short-term instrumentation and endpoint baselines.
Expected impact: improved headroom for larger tenants/workloads.
Actions: stream/chunk memory analytics/export pipelines, reduce per-step trace write amplification, batch vector upserts, shift stream closure from timer polling to event-driven paths with fallback.

3. Clarify and harden package/product contracts.
Dependency: server decomposition complete.
Expected impact: better semver governance and integrator confidence.
Actions: narrow `@dzupagent/server` root exports, clarify/split `runtime-contracts` domain scope, consolidate duplicated playground websocket lifecycle logic.

4. Execute selective external-parity imports.
Dependency: stable baseline + measurable capacity.
Expected impact: high ROI without overbuild.
Actions: maintain a top-15 comparison import matrix scored by relevance, adjacency, and operational risk; promote capabilities only when ownership mapping and scenario drills are complete.

## Recommended Workstreams
1. Runtime Correctness And Verification Integrity
Scope: queue execution invariants, cancel truthfulness, hermetic strict verification, integration-lane confidence.
Deliverables: deterministic run lifecycle contract, reliable strict CI signal, publish preconditions tied to correctness.

2. Security And Trust Boundaries
Scope: A2A and OpenAI-compat auth defaults, MCP admin gating, owner-scoped key mutation, secret redaction/encryption posture, outbound callback policy.
Deliverables: secure-by-default route policy matrix, regression tests for authz boundaries, reduced secret exposure.

3. Server Architecture Decomposition
Scope: route-to-service extraction, `createForgeApp` installer decomposition, route-layer boundary enforcement, schema bounded-context split.
Deliverables: reduced change blast radius, clearer ownership boundaries, lower merge/regression friction.

4. Performance And Scalability Hardening
Scope: logs/trace pagination, indexing, queue depth controls, trace/vector write optimization, timer/cardinality controls.
Deliverables: lower p95 latency, bounded memory growth, improved stream efficiency under concurrency.

5. Operability And Release Hardening
Scope: migration lifecycle commands and checks, deploy confidence gating, truthful health/readiness semantics, stronger release workflow parity.
Deliverables: release-safe pipeline, predictable rollback posture, operator-trustworthy health signals.

6. Product Surface Closure
Scope: capability matrix end-to-end wiring, compile/capability UI route/nav exposure, trigger lifecycle completion, CLI workflow depth.
Deliverables: visible feature progress by integrating existing assets rather than net-new rewrites.

7. Docs And Contract Governance
Scope: version-source normalization, migration/doc contradiction cleanup, route/auth/toggle matrix publication, dead-link and drift CI.
Deliverables: docs as authoritative interface, fewer onboarding failures, lower cross-team ambiguity.

8. Comparison-Guided Evolution
Scope: structured import decisions from external references, scenario-based parity drills, explicit “do not import yet” guardrails.
Deliverables: focused parity gains aligned to `dzupagent` positioning.

## Risks And Tradeoffs
- Tightening auth defaults will break permissive local/dev assumptions unless explicit dev profiles and migration notes are provided.
- Enforcing queue/execution invariants may surface hidden misconfiguration in current deployments; staged rollout is needed.
- Service-layer extraction reduces near-term velocity but pays down the highest regression hotspot.
- Stronger publish/migration gates increase release cycle time initially, but reduce rollback and incident cost.
- Pagination/redaction changes may alter downstream API expectations; compatibility/deprecation policy is required.
- Deeper observability and docs governance adds maintenance overhead; without it, current trust drift will continue.
- Selective external import strategy may feel slower than broad parity, but prevents product overbuild and contract instability.

## Suggested Success Metrics
1. Strict verification determinism.
Target: `verify:strict` succeeds on clean runners without manual artifact priming in >=95% of runs over 30 days.

2. Release gate completeness.
Target: 100% of publish workflows execute required verify + migration checks before publish steps.

3. Cancellation truthfulness.
Target: 100% of `cancelled` terminal states have queue-level cancellation acknowledgement in integration telemetry/tests.

4. Auth boundary enforcement.
Target: 100% CI pass for unauthorized A2A/MCP/API-key mutation denial scenarios; zero reopened bypass findings.

5. Endpoint scalability.
Target: >=40% p95 latency reduction for run logs/trace endpoints after pagination/index changes under representative load.

6. Realtime efficiency.
Target: >=30% reduction in per-run polling/heartbeat request volume under stable connections.

7. Queue safety.
Target: bounded in-memory queue/dead-letter growth with explicit cap metrics and zero unbounded growth incidents.

8. Migration reliability.
Target: 100% migration-check pass before release; explicit rollback runbook coverage for all new migration classes.

9. Documentation truth.
Target: zero critical doc drift failures (version mismatch, missing required docs artifacts, broken links) for 4 consecutive weeks.

10. Product reachability.
Target: capability matrix and compile surfaces fully accessible via documented API routes and playground navigation with passing integration tests.

11. Scaffolder reliability.
Target: 100% template smoke-test success for generated projects using current server contract.

12. Architectural hotspot reduction.
Target: measurable decrease in high-churn defects and reduced average changed-lines per server feature PR in `app.ts`/`runs.ts`/`run-worker.ts` paths.

## Conclusion
The first move should be a single stabilization tranche that combines run-lifecycle correctness, security default hardening, and hermetic verification/release gating. That tranche directly addresses the highest trust risks and creates the prerequisite foundation for architecture decomposition, scalability improvements, and high-ROI productization of already-implemented features.