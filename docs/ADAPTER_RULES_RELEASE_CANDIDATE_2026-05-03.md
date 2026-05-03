# Adapter Rules and Monitor Release Candidate Note

Date: 2026-05-03

Status: release-candidate sealing pass. Treat the current adapter-rules, monitor-status, and trace/tool-span batch as frozen except for validation failures, API drift, or narrowly scoped bug fixes.

## Batch Boundary

This batch is considered sealed when these remain true:

- Rule diagnostics are additive and stable.
- `prepareAdapterRuleRuntime()` is the supported host bridge for rule loading, compiling, projection, and governance diagnostics.
- Adapter monitor status is visible through health, without making monitor installation mandatory.
- Trace propagation and duplicate tool span handling are covered by source and tests.
- Public API docs and allowlists mention the supported surfaces.
- The repo validation lane remains green.
- The implementation worktree is clean and checkpointed outside this note.

## Supported Surfaces

### `@dzupagent/adapter-rules`

Supported as the canonical rule schema, loader, compiler, and provider-config projector package for this batch.

Current evidence:

- `RuleLoader` exposes diagnostic-aware loading through `loadFileWithDiagnostics()` and `loadFromDirectoryWithDiagnostics()`.
- `RuleCompiler` compiles canonical `AdapterRule[]` plus `CompileContext` into a provider-specific `RuntimePlan`.
- Provider projectors remain in `packages/adapter-rules/src/projectors/*` and are intentionally narrower than a canonical runtime policy model.

Operational stance:

- Keep diagnostics additive.
- Do not add CLI write/apply behavior here during the stabilization window.
- Do not reinterpret `RuntimePlan` as the final policy model yet.

### `@dzupagent/agent-adapters/rules`

Supported as the host bridge for running adapter rules inside provider execution.

Current evidence:

- `prepareAdapterRuleRuntime(input, context, options)` loads rules from provided arrays, files, and directories, compiles them, projects the runtime plan, and emits governance events for loader/compiler diagnostics.
- `projectAdapterRuleRuntimePlan()` attaches the plan to `AgentInput.options`, appends prompt sections by default, carries guardrail metadata, and stores provider config patches without forcing hosts to apply them blindly.
- `withAdapterRuleRuntimePlan()`, `getAdapterRuleRuntimePlan()`, `resolveRuntimePlanWatcherPaths()`, and `resolveAdapterWatchPath()` are the supported lower-level helper seams.

Operational stance:

- Prefer `prepareAdapterRuleRuntime()` for host integration.
- Use lower-level helpers only when the host already owns rule loading and compilation.
- Keep rule diagnostics on the governance plane; do not move them into the primary adapter event stream without an explicit contract decision.

### `HealthStatus.monitorStatus`

Supported as optional adapter monitor visibility in adapter health.

Current evidence:

- `HealthStatus` includes optional `monitorStatus`.
- `BaseCliAdapter.healthCheck()` reports `monitorStatus`.
- `ProviderAdapterRegistry.getHealthStatus()` enriches missing monitor status with provider-catalog defaults.
- `BaseCliAdapter.setArtifactWatcherFactory()` keeps the monitor dependency optional and reports `not_configured`, `ready`, `active`, `failed_to_start`, or `unsupported`.

Operational stance:

- Monitor installation must remain optional.
- Health should report monitor visibility even when no artifact watcher factory is wired.
- Do not unify server/provider health shapes in this batch.

### Trace and Tool Span Behavior

Supported as lightweight adapter tracing with W3C trace propagation and stable handling of concurrent same-name tool calls.

Current evidence:

- `AdapterTracer` creates root spans, child tool spans, and `TRACEPARENT` propagation env.
- `ToolSpanTracker` matches tool results by explicit call id when present and otherwise uses FIFO per tool name.
- `BaseCliAdapter` reads the per-run trace env option and passes it into spawned CLI processes.

Operational stance:

- Keep propagation opt-out through tracer config.
- Keep call-id matching narrow and source-shape based.
- Do not invent provider event semantics beyond observed call-id fields.

## Validation Lane

Known release-candidate lane:

```bash
yarn verify
```

Recommended focused checks if `yarn verify` fails and the failure appears unrelated:

```bash
yarn workspace @dzupagent/adapter-rules test
yarn workspace @dzupagent/agent-adapters test -- src/__tests__/rule-runtime-plan.test.ts src/__tests__/detailed-health.test.ts src/__tests__/adapter-tracer.test.ts src/__tests__/base-cli-adapter-artifact-watcher.test.ts
node scripts/check-improvements-drift.mjs
node scripts/check-runtime-test-inventory.mjs
node scripts/check-domain-boundaries.mjs
```

Use focused checks only to separate current-slice regressions from unrelated repo noise. They are not a replacement for the release-candidate lane when preparing the final checkpoint.

## Deferred Work

These are intentionally not part of the sealed batch:

- CLI adapter-rule preview/apply commands.
- Canonical runtime policy model.
- Server/provider health unification.
- Root API contraction.
- `BaseCliAdapter` extraction.
- More audit-pack automation.
- New planning scripts or audit generators.
- Product dashboard work.
- CLI write/apply behavior.

## Next Batch Brainstorming

### 1. Stabilization Window

Goal: keep the current feature batch unchanged except for bug fixes.

Watch points:

- `@dzupagent/adapter-rules` schema or projector drift.
- `@dzupagent/agent-adapters/rules` export/subpath drift.
- `HealthStatus.monitorStatus` shape changes.
- Trace propagation env shape changes.
- Tool span matching regressions for same-name concurrent tool calls.
- Consumer friction around whether hosts should call `prepareAdapterRuleRuntime()` or lower-level helpers.

Exit criteria:

- `yarn verify` is green.
- No new public API drift is detected.
- No current-slice bugs are discovered during consumer testing.
- This note, API docs, and allowlists still agree.

### 2. Canonical Runtime Policy Model

Goal: unify adapter-rules projection and `AdapterPolicy` compilation behind one internal runtime policy model.

Why this comes first:

- It removes duplicate semantics between rule effects, provider config projection, and policy compiler output.
- It gives CLI preview/validate commands one stable data shape to inspect.
- It gives future health/observability snapshots one conformance model instead of several partial interpretations.

Recommended shape:

- Define an internal `RuntimePolicyModel` that can be produced from adapter rules and from `AdapterPolicy`.
- Keep provider-native config patches as outputs, not the source of truth.
- Keep governance diagnostics tied to model compilation, not only filesystem loading.
- Add conformance tests that compare rule-derived output and policy-derived output for equivalent approval, path, monitor, and prompt behavior.

Do not expose this as a broad root API until it has settled behind package-local tests.

### 3. CLI Preview and Validate

Goal: add read-only commands only after the runtime policy model is stable.

Initial commands:

- `adapter-rules validate`
- `adapter-rules plan`

Constraints:

- No write/apply behavior.
- No provider config file mutation.
- Output should show diagnostics, projected runtime policy, provider config patch summary, watcher paths, and governance events that would be emitted.
- Command implementation should reuse the canonical runtime policy model rather than reimplementing compile/projection logic.

### 4. Observability Unification

Goal: normalize provider adapter health, monitor status, rule conformance, and server registry health into one snapshot shape.

Inputs:

- Adapter `HealthStatus`.
- Registry `ProviderAdapterRegistryHealthStatus`.
- Provider catalog monitor metadata.
- Rule/runtime-policy conformance results.
- Server registry health when applicable.

Constraints:

- Keep framework health generic.
- Do not add product dashboard assumptions to `packages/server` or `packages/playground`.
- Product UX belongs in consuming apps such as Codev.

### 5. Maintainability Refactor

Goal: extract stable `BaseCliAdapter` seams after behavior stops moving.

Candidates:

- Provider hook record detection.
- Spawn env construction.
- Artifact watcher path resolution/start/stop helpers.
- Governance event stamping.
- Provider completion invariant handling.

Constraints:

- Start with pure helpers and tests.
- Avoid reshaping public root exports in the same batch.
- Keep concrete provider adapters behaviorally unchanged.

## Script and Refactor Alignment

Current audit/script stack is sufficient for this topic. Do not add new script automation unless a validation gate proves insufficient.

Use existing guardrails:

- `scripts/check-improvements-drift.mjs`
- `scripts/check-runtime-test-inventory.mjs`
- `scripts/check-domain-boundaries.mjs`
- `scripts/audit/workflow/inspect-audit-pack.js` only when working from an actual audit pack

Refactor posture:

- Stabilize first.
- Model unification second.
- CLI read-only UX third.
- Health snapshot unification fourth.
- `BaseCliAdapter` extraction fifth.

## Future Session Prompt

Use this prompt to continue without re-deriving the boundary:

```text
We are in /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent.
Read AGENTS.md and docs/ADAPTER_RULES_RELEASE_CANDIDATE_2026-05-03.md first.
Treat the adapter-rules, agent-adapters/rules, HealthStatus.monitorStatus, and trace/tool-span feature batch as frozen except for validation failures or narrow bug fixes.
Do not add new audit generators, planning scripts, CLI apply/write behavior, product dashboard work, BaseCliAdapter refactors, or root export reshaping.
First check git status and run the known validation lane (`yarn verify`) or a focused current-slice lane if the full lane is already known to be blocked.
If stabilization is green, plan the next batch around the canonical runtime policy model before CLI preview/validate or observability unification.
Save any new planning updates into repo-local docs and keep supported/deferred/validated boundaries explicit.
```
