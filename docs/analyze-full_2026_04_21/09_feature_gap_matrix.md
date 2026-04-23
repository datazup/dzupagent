# 09 Feature Gap Matrix

## Repository Overview
`dzupagent` is a Yarn 1 + Turbo TypeScript monorepo with broad platform scope: core SDK/runtime packages, agent orchestration, adapters/connectors, a server runtime/API surface, a playground UI, and scaffolding (`create-dzupagent`).  
This matrix was built from direct code/docs evidence in `dzupagent/` plus secondary requirement artifacts under `out/` (especially `out/knowledge-index/gap-analysis-requirements.dzupagent.md` and `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md`).

## Feature Domains Reviewed
- Core SDK/API tiering and package export surface.
- Agent runtime, orchestration depth, and adapter capabilities.
- Server route/API surface (baseline + advanced optional domains).
- Routed UI surface in `@dzupagent/playground`.
- Queue/run lifecycle correctness and cancellation semantics.
- Triggers/schedules/webhook automation.
- A2A and OpenAI-compatible protocol surfaces.
- CLI product surface and command completeness.
- Scaffolding quality (`create-dzupagent`) and template validity.
- Documentation/claims consistency (README, migration, package docs, wave tracking docs).
- Verification/release gating fidelity.
- External requirement candidates from `out/` artifacts.

## Feature Matrix

| Domain | Feature Area | Status | Claimed Sources | Implementation Evidence | Confidence | Notes |
|---|---|---|---|---|---|---|
| Core SDK | Tiered core API (`@dzupagent/core`, `/stable`, `/advanced`) | `implemented` | `README.md` core-tier guidance | `packages/core/package.json` exports include `.`, `./stable`, `./advanced` | High | Claim and implementation align. |
| Agent runtime | Orchestration/self-correction + adapter reliability depth | `implemented` | `docs/WAVE22_TRACKING.md`, `docs/WAVE23_TRACKING.md` completion claims | Large runtime/export surfaces in `packages/agent/src/index.ts`, `packages/agent-adapters/src/index.ts`; deep test additions recorded in W22/W23 | High | Mature implementation and test depth. |
| Server baseline API | Health, runs, agents, approvals, events | `implemented` | `packages/server/README.md` default routes | Mounted in `packages/server/src/app.ts` (`/api/health`, `/api/runs`, `/api/agents`, `/api/events`) | High | Core server product surface is present. |
| Server advanced domains | Prompts/personas/presets/marketplace/reflections/mailbox/clusters/evals/benchmarks/workflows/compile/skills/mcp/openai | `implemented` | README + package docs imply broad server capabilities | Mounted conditionally in `packages/server/src/app.ts` + plugin wiring in `createBuiltInRoutePlugins()` | High | Present but heavily config-gated; docs under-specify toggle matrix. |
| Capability matrix (end-to-end) | API + UI exposure for capability matrix | `partially implemented` | UCL comments/tests in capability route/UI test files | `packages/server/src/routes/capabilities.ts` exists; `packages/playground/src/views/CapabilityMatrixView.vue` exists; but no mount in `packages/server/src/app.ts`, no export in `packages/server/src/index.ts`, no route in playground router | High | Feature components exist but are not wired into product surface. |
| Playground routed UX | Developer views for compile/capability matrix | `not implemented` | View-level comments imply availability | `packages/playground/src/views/CompileView.vue` and `CapabilityMatrixView.vue` exist; absent from `packages/playground/src/router/index.ts` and sidebar nav in `packages/playground/src/App.vue` | High | UI assets exist but are inaccessible through routing/nav. |
| Run lifecycle correctness | Queue handoff, execution guarantees, cancel semantics | `partially implemented` | `ForgeServerConfig` comments imply in-memory queue fallback | `packages/server/src/routes/runs.ts` enqueues when queue exists; `createForgeApp` starts worker only if queue provided; `BullMQRunQueue.cancel()` returns `false` while cancel route marks run cancelled | High | Semantics can report cancellation/success without guaranteed worker-side effect in BullMQ path. |
| Trigger/schedule automation | CRUD + actual runtime scheduling/webhook execution | `partially implemented` | Trigger/schedule docs and type comments imply cron/webhook/chain automation | CRUD routes in `packages/server/src/routes/triggers.ts` and `schedules.ts`; standalone `TriggerManager` in `packages/server/src/triggers/trigger-manager.ts`; no TriggerManager lifecycle wiring in `createForgeApp` | High | Data model and CRUD are present; production execution path is incomplete. |
| A2A protocol | Agent-to-agent tasking endpoints | `partially implemented` | A2A feature claims in docs and route comments | Mounted in `createForgeApp` at root (`app.route('', a2aRoutes)`), route set present in `packages/server/src/routes/a2a/index.ts` | High | Functional route surface exists, but it bypasses `/api/*` auth middleware by default pathing. |
| OpenAI-compatible API | `/v1/chat/completions` and `/v1/models` | `partially implemented` | README/product messaging suggests compat endpoints | Mounted in `createForgeApp`; auth middleware in `routes/openai-compat/auth-middleware.ts` accepts any non-empty bearer token when `validateKey` is omitted | High | Works functionally; security defaults are permissive for production. |
| CLI surface | First-class terminal workflow layer (`/plan`, `/implement`, `/review`, `/reflect`) | `not implemented` | Requirement candidate in `out/knowledge-index/gap-analysis-requirements.dzupagent.md` | `packages/server/src/cli/dzup.ts` contains many commands but no `plan/implement/review/reflect` command layer | High | Existing CLI is useful but does not match this requested product layer. |
| Scaffolding | `create-dzupagent` template coverage and generated-project correctness | `partially implemented` | `packages/create-dzupagent/README.md` claims template-led scaffolding | Template registry has 9 templates (`src/templates/index.ts`), but README claims 5; several templates generate stale/invalid server config (`auth.mode: 'bearer'`, `cors`, `queue`, `database`, `otel` keys) vs current `createForgeApp` config | High | Generator exists but generated output quality is inconsistent and sometimes invalid. |
| Documentation truth | Migration/version/docs-hub alignment | `stale-doc-only` | Root/package docs and migration guide claims | `README.md` links missing `docs/README.md`; `MIGRATION.md` says presets removed, while `packages/agent/src/index.ts` still exports them; runtime version constants still `0.1.0` while manifests are `0.2.0` | High | High-impact claim drift across onboarding/migration/release metadata. |
| Verification/release | Strict verification and publish-readiness fidelity | `partially implemented` | `package.json` scripts + CI workflows | `verify:strict` includes strong checks (`check:capability-matrix`, coverage, boundaries), but capability matrix doc file is missing (`scripts/check-capability-matrix-freshness.mjs` expects `docs/CAPABILITY_MATRIX.md`) | High | Strong gate design, but currently brittle due missing required artifacts and doc drift. |
| External candidate | `@dzupagent/connectors-defi` package | `not implemented` | High-priority candidate in `out/knowledge-index/gap-analysis-requirements.dzupagent.md` | No matching package under `packages/` | Medium | Candidate exists in requirements seed, not in current repo surface. |
| External candidate | Tutorial-grade chaptered starter track in scaffolder | `not implemented` | Requirement candidate in `out/knowledge-index/gap-analysis-requirements.dzupagent.md` | No chapter progression system in `packages/create-dzupagent` template model | Medium | Rich templates exist, but no chaptered pedagogy flow. |
| Product strategy | Explicit decision: extend playground vs separate app repo | `unclear` | Requirement candidate in `out/knowledge-index/gap-analysis-requirements.dzupagent.md` | No explicit ADR found in `docs/` resolving this product-surface strategy | Low | Decision may exist externally; not codified in reviewed repo docs. |

## High-Value Gaps
1. End-to-end capability matrix remains inaccessible despite existing route/view/test assets.
2. Run lifecycle correctness has queue/cancel semantic risk, especially under BullMQ cancellation behavior.
3. Trigger/schedule systems are mostly CRUD-level and not fully wired into runtime orchestration.
4. Advanced protocol surfaces (A2A and `/v1/*`) are functional but insufficiently fail-closed by default.
5. Scaffolding currently generates stale or invalid configs in key templates, reducing new-project success.
6. Documentation truth drift (migration, versions, missing docs hub/capability matrix artifacts) undermines trust and release clarity.
7. CLI workflow-product gap remains open relative to top-ranked requirement candidates in `out/knowledge-index`.

## False-Positive Or Stale Claims
1. Claim: built-in presets were removed from `@dzupagent/agent`.  
Reality: `packages/agent/src/index.ts` still exports `RAGChatPreset`, `ResearchPreset`, `SummarizerPreset`, `QAPreset`, and `BUILT_IN_PRESETS`, contradicting `MIGRATION.md`.
2. Claim: root documentation hub exists at `docs/README.md`.  
Reality: `README.md` links it, but the file is missing.
3. Claim: capability-matrix freshness gate is an active truth check.  
Reality: strict check requires `docs/CAPABILITY_MATRIX.md`, which is absent, so gate can fail for missing artifact rather than freshness drift.
4. Claim: server README auth setup is copy-paste correct.  
Reality: README example uses `auth: { apiKeys: [...] }`, while `AuthConfig` expects `mode` and optional `validateKey`.
5. Claim: server README playground path is current.  
Reality: example references `packages/dzupagent-playground/dist`; actual package path is `packages/playground`.
6. Claim: `create-dzupagent` ships five templates.  
Reality: template registry/type union includes nine templates.
7. Claim: scaffold templates are aligned with current server config.  
Reality: templates include unsupported/stale keys (`auth.mode: 'bearer'`, `cors`, `queue`, `database`, `otel`) and old `^0.1.0` dependency ranges.
8. Claim: compile developer view targets live compile endpoint (`/compile`).  
Reality: built-in compile route mounts under `/api/workflows/compile` in `createForgeApp`.
9. Claim: static `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md` “no obvious structural gaps / 100 health” reflects current truth.  
Reality: live repo contains multiple high-impact doc and feature-wiring drifts.

## Dependency And Sequencing Notes
- Capability-matrix closure requires coordinated server and UI work.
Server dependency: mount/export capability routes in `createForgeApp` and `@dzupagent/server` exports.
UI dependency: add router/nav entries and align endpoint path expectations.
- Run-lifecycle fixes should precede scaling/perf work.
Deterministic queue execution and truthful cancellation semantics are prerequisite correctness constraints.
- Trigger/schedule productization depends on runtime lifecycle ownership.
`TriggerManager` needs startup/shutdown wiring, persistence synchronization, and webhook signature verification.
- Security hardening depends on policy defaults, not new primitives.
Identity/RBAC/capability middleware exists; missing piece is enforced default route-policy mapping for A2A/MCP/OpenAI surfaces.
- Scaffolder reliability depends on shared contract alignment.
Templates should be generated from canonical server config/types to prevent config drift.
- Docs/release gate reliability depends on artifact generation order.
Capability matrix/docs artifacts must be generated before strict checks; publish should depend on strict verification outputs.

## Priority Recommendations
1. Fix run execution/cancellation correctness first.
Reason: this is core control-plane integrity and affects real runtime behavior, not just UX.
2. Enforce secure-by-default policy on advanced surfaces.
Reason: A2A and `/v1/*` currently expose high-impact operations with permissive defaults.
3. Complete capability matrix end-to-end wiring.
Reason: most implementation already exists; integration work can unlock a visible feature quickly.
4. Repair `create-dzupagent` template contracts and version ranges.
Reason: scaffolding is a primary adoption path; broken templates multiply downstream failures.
5. Productize trigger/schedule automation beyond CRUD.
Reason: automation value requires runtime execution and signed webhook trust, not storage alone.
6. Normalize docs and version truth, then harden strict gate ergonomics.
Reason: accurate migration/docs metadata and artifact-backed checks improve release confidence and onboarding.
7. Decide explicit product-surface strategy (playground extension vs separate app) and document it as an ADR.
Reason: this decision drives UI investment, CLI scope, and future cross-repo planning.