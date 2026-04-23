# Operability And Release Readiness Review (dzupagent, 2026-04-21)

## Repository Overview
This review focuses on deployability and day-2 operations for `dzupagent`, with emphasis on runtime contracts, background execution, migration safety, observability, release automation, and rollback posture.

Primary evidence reviewed:
- Runtime/server implementation: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts), [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts), [run-worker.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts), [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts)
- Queue/backpressure/streaming: [run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/run-queue.ts), [bullmq-run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/bullmq-run-queue.ts), [event-gateway.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/events/event-gateway.ts), [sse-streaming-adapter.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/streaming/sse-streaming-adapter.ts)
- Migration/deploy/release surfaces: [drizzle-schema.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/persistence/drizzle-schema.ts), [drizzle.config.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle.config.ts), [0002_run_status_halted.sql](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle/0002_run_status_halted.sql), [_journal.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle/meta/_journal.json), [publish.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/publish.yml)
- CI/quality controls: [verify-strict.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/verify-strict.yml), [coverage-gate.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/coverage-gate.yml), [security.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/security.yml), [compat-matrix.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/compat-matrix.yml)
- Secondary `out/` artifacts for drift/cross-check: [DZUPAGENT.md](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md), [SUMMARY.md](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/SUMMARY.md), [plan.json](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-commit-groups/dzupagent/plan.json)

## Operational Surface
1. Runtime API surface is broad and modular, but execution-critical wiring is optional and externally assumed.
Evidence: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:453), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:466).

2. Queue worker starts only when `runQueue` is supplied; there is no actual in-code fallback despite config comments claiming in-memory default.
Evidence: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:174), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:466).

3. Run creation without queue does not execute work, it only emits `agent:started` and returns `201`, leaving execution semantics undefined for that deployment mode.
Evidence: [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:97), [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:129).

4. Background tasks exist (DLQ worker, consolidation scheduler, learning/prompt loops), but each is opt-in and tied to manual composition choices.
Evidence: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:691), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:765), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:797).

5. Trigger/schedule persistence is present, but scheduler execution is mostly CRUD/manual-trigger oriented at app level; `TriggerManager` lifecycle is not wired into `createForgeApp`.
Evidence: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:640), [schedules.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/schedules.ts:100), [trigger-manager.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/triggers/trigger-manager.ts:107).

6. Migration surface is Drizzle SQL + config-driven push/generate, with no explicit repo-standard migrate command and no env template files for operators.
Evidence: [package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:22), [drizzle.config.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle.config.ts:8).

## Observability Review
1. Positive: run-level logs/events/trace context are substantial, including event-stream and step tracing.
Evidence: [run-worker.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts:206), [run-worker.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts:252), [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:525).

2. Positive: SSE and event gateway include heartbeat and bounded queues with overflow strategy.
Evidence: [events.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/events.ts:47), [event-gateway.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/events/event-gateway.ts:130), [sse-streaming-adapter.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/streaming/sse-streaming-adapter.ts:96).

3. Health/readiness has useful coverage, but operator trust is weakened by correctness gaps:
- Liveness version is hardcoded to `0.1.0` while package is `0.2.0`.
- Readiness can still be `ok` when model providers are `unconfigured`.
- Readiness queue stats rely on sync `stats()`; BullMQ’s sync pending count is explicitly approximate (`0`).
Evidence: [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:20), [package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:3), [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:55), [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:97), [bullmq-run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/bullmq-run-queue.ts:138).

4. Metrics are available in JSON and Prometheus formats, but only when a collector is injected; no enforced default exporter pipeline.
Evidence: [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:111), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:760), [metrics.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/metrics.ts:20).

5. Operator diagnostics (`dzup doctor`) are structurally good but materially shallow by default because CLI invokes it with empty probe context.
Evidence: [dzup.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/dzup.ts:91), [doctor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/doctor.ts:255), [doctor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/doctor.ts:279).

## Release And Migration Risks
1. Migration process is not release-rigorous:
- package scripts expose `db:generate` and `db:push` only.
- migration journal currently has empty entries.
Evidence: [package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:22), [_journal.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle/meta/_journal.json:1).

2. Rollback posture is metadata-first, not execution-first:
- schema stores `rollbackAvailable` and deploy history/outcome.
- no built-in rollback execution route or migration down pipeline.
Evidence: [drizzle-schema.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/persistence/drizzle-schema.ts:123), [deploy.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/deploy.ts:100), [signal-checkers.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/deploy/signal-checkers.ts:103).

3. BullMQ cancellation semantics are non-operational:
- API marks run cancelled regardless of queue cancel result.
- BullMQ adapter always returns `false` for cancel.
Evidence: [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:188), [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:190), [bullmq-run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/bullmq-run-queue.ts:128).

4. Feature flag / staged rollout controls are light at release system level; deploy confidence exists but is not wired as a mandatory CI gate.
Evidence: [deploy-gate.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/deploy/deploy-gate.ts:31), [publish.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/publish.yml:39).

5. Graceful shutdown behavior includes hard process termination (`process.exit(0)`), which can complicate embedded/runtime-hosted deployments and rollback orchestration.
Evidence: [graceful-shutdown.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/lifecycle/graceful-shutdown.ts:135).

## CI And Automation Review
1. Pre-merge quality controls are strong and layered:
- strict contract checks + verify strict.
- package coverage matrix + workspace coverage gate.
- security audit + secret scan + SAST.
Evidence: [verify-strict.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/verify-strict.yml:59), [coverage-gate.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/coverage-gate.yml:95), [security.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/security.yml:44).

2. Release workflow is comparatively thin:
- publish job runs install + build + changesets action.
- no explicit test/typecheck/lint/security/migration/smoke steps in publish job.
Evidence: [publish.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/publish.yml:39).

3. Compatibility matrix is valuable, but snapshot publish tolerates package publish failures (`|| true`), weakening signal fidelity.
Evidence: [compat-matrix.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/compat-matrix.yml:88).

4. Branch protection expectations are documented, but still manual repository configuration; enforcement is not self-contained in code.
Evidence: [README.md](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:97).

5. Local strict verification is currently fragile due coverage artifact dependency. In this review run, `verify:strict` failed because `agent-adapters` coverage summary was missing.
Evidence: [package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:29), [check-workspace-coverage.mjs](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-workspace-coverage.mjs:241).

## Findings
1. **Critical**: Run cancellation is unsafe in BullMQ mode and can create false terminal state reporting.
Evidence: [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:188), [bullmq-run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/bullmq-run-queue.ts:128), [run-worker.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/runtime/run-worker.ts:711).

2. **High**: Execution path is not guaranteed unless queue wiring is explicitly provided; comment and runtime behavior diverge.
Evidence: [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:174), [app.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:466), [runs.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:129).

3. **High**: Migration lifecycle is underdefined for production release safety (no explicit migrate command, empty journal tracking, no down strategy).
Evidence: [package.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:22), [_journal.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle/meta/_journal.json:1), [0002_run_status_halted.sql](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/drizzle/0002_run_status_halted.sql:26).

4. **High**: Publish-time automation does not enforce full release-readiness gates.
Evidence: [publish.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/publish.yml:39), [verify-strict.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/verify-strict.yml:65), [coverage-gate.yml](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.github/workflows/coverage-gate.yml:130).

5. **Medium**: Readiness/liveness signals can be misleading for operators (hardcoded version, unconfigured provider not treated as degraded/error, approximate queue stats).
Evidence: [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:20), [health.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:55), [bullmq-run-queue.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/queue/bullmq-run-queue.ts:138).

6. **Medium**: Env/config contract is not fail-fast at boot; diagnostics are optional and warning-heavy by default invocation.
Evidence: [dzup.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/dzup.ts:91), [doctor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/doctor.ts:123), [doctor.ts](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/doctor.ts:369).

7. **Medium**: Operability-critical deploy components have very low exercised coverage despite overall server coverage clearing threshold.
Evidence: [coverage-summary.json](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/coverage/coverage-summary.json), especially low lines for `routes/deploy.ts`, `deploy/confidence-calculator.ts`, `deploy/deployment-history-store.ts`, `deploy/signal-checkers.ts`.

8. **Low**: Secondary static artifacts currently overstate operational health and can create false confidence if used as release gate inputs.
Evidence: [DZUPAGENT.md](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:54), [DZUPAGENT.md](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:191), [SUMMARY.md](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/SUMMARY.md:31).

## Recommended Hardening Plan
1. Make queue/execution invariants explicit.
- Instantiate an internal `InMemoryRunQueue` fallback when queue is omitted, or reject startup in non-dev mode.
- Fail startup if run creation can succeed without an active worker path.
- Align comments/docs with runtime truth.

2. Fix cancellation correctness end-to-end.
- Add cancellable BullMQ job lookup/index by `runId`.
- Only transition run to `cancelled` after queue-level acknowledgement.
- Add race tests for `cancel` vs completion in BullMQ mode.

3. Promote migrations to first-class release controls.
- Add `db:migrate` and `db:migrate:check` scripts.
- Enforce migration check in CI and publish workflow.
- Track migration journal entries and add explicit rollback runbooks for each migration class.

4. Turn deploy confidence into an enforceable gate.
- Wire `DeployGate.exitCode()` into CI release pipeline before publish.
- Require non-stale signals for production.
- Treat missing rollback checker/project context as blocking for prod deploys.

5. Improve observability truthfulness.
- Source health version from package/runtime metadata (single source of truth).
- Change readiness policy so `unconfigured` critical subsystems are not `ok`.
- For BullMQ readiness, use async Redis-backed stats and expose queue lag/age.

6. Add strict environment boot validation.
- Centralize env schema validation (required vs optional by mode).
- Provide `.env.example` for operator onboarding.
- Fail fast in production profile when required env vars are absent.

7. Strengthen release workflow parity with strict verification.
- In `publish.yml`, run `verify:strict` (or equivalent build/typecheck/lint/test/coverage/security checks) before changesets publish.
- Add smoke tests against packed artifacts.
- Remove `npm publish ... || true` in compat snapshot flows or convert to explicit error accounting.

## Overall Assessment
`dzupagent` has strong engineering foundations and extensive CI/testing investment, but current operability is **not yet fully release-safe at scale**. The largest blockers are queue cancellation correctness, non-enforced execution/runtime invariants, migration/release gating gaps, and readiness signal fidelity. In controlled environments with disciplined manual ops, it is workable; for high-confidence production operations, the hardening items above should be treated as preconditions.