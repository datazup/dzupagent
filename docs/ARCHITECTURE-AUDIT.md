# Architecture Audit

## Findings

### ARCHITECTURE-001 - High - Published packages import undeclared workspace dependencies

**Impact:** Package manifests do not fully describe the runtime/type contract graph. The monorepo can still work because Yarn workspaces make sibling packages available, but published packages and downstream consumers can fail to resolve imports, and manifest-based layer/cycle checks can miss real edges.

**Evidence:** `@dzupagent/connectors` imports `AsyncToolResolver` and `ResolvedTool` from `@dzupagent/flow-ast` in `packages/connectors/src/agent-registry-resolver.ts:17` and `packages/connectors/src/mcp-tool-resolver.ts:13`, but `packages/connectors/package.json:23` declares only `@dzupagent/core` among workspace dependencies. `@dzupagent/evals` re-exports and imports contract types from `@dzupagent/eval-contracts` in `packages/evals/src/index.ts:15` and `packages/evals/src/index.ts:38`, but `packages/evals/package.json:21` declares only `@dzupagent/core`. `@dzupagent/server` imports types from `@dzupagent/memory` in `packages/server/src/routes/memory-sync.ts:13`, while `packages/server/package.json:30` declares `@dzupagent/memory-ipc` but not `@dzupagent/memory`.

**Remediation:** Add a source-import-to-manifest guard for production `src/**` imports and require every `@dzupagent/*` import to be declared in `dependencies` or `peerDependencies`, with explicit type-only exceptions only where the package manager/build model supports them. Then add the missing declarations or move those contracts behind packages that are already declared as stable dependencies.

### ARCHITECTURE-002 - High - `@dzupagent/server` remains a broad product/control-plane host

**Impact:** Product-facing concepts continue to accumulate in the maintenance server package instead of reusable framework primitives plus app-owned productization. This conflicts with the repository boundary that new workspace, persona, prompt, task/subtask, workflow DSL, memory-policy, multi-tenant filtering, adapter orchestration, or Codev operator UX work should route to consuming apps rather than expanding `packages/server` or `packages/playground`.

**Evidence:** The server app factory explicitly describes optional routes for "triggers, schedules, prompts, personas, presets, marketplace, reflections, mailbox+clusters, OpenAI compat" in `packages/server/src/app.ts:93`. The optional-route composer mounts prompt, persona, preset, marketplace, mailbox, cluster, and OpenAI-compatible routes in `packages/server/src/composition/optional-routes.ts:189`, `packages/server/src/composition/optional-routes.ts:219`, and `packages/server/src/composition/optional-routes.ts:259`. Concrete product-like CRUD lives in server routes: personas in `packages/server/src/routes/personas.ts:1`, prompt versioning in `packages/server/src/routes/prompts.ts:1`, and cluster workspaces/mail routing in `packages/server/src/routes/clusters.ts:1`. The root export surface exposes those areas from `packages/server/src/index.ts:288`, `packages/server/src/index.ts:313`, and `packages/server/src/index.ts:443`.

**Remediation:** Freeze new `@dzupagent/server` product/control-plane additions. Keep server as a compatibility host/runtime shell, move forward-path product control planes to `apps/codev-app` or other consumers, and expose only generic framework contracts or route-plugin seams from DzupAgent packages.

### ARCHITECTURE-003 - High - Declared package-pair boundary rules are not enforced

**Impact:** The repository appears to have fine-grained package boundary policy, but the active checker does not consume that policy. A future direct production import such as `codegen -> agent`, `connectors -> codegen`, or `server -> test-utils` could land if it still satisfies the coarse manifest/layer checks or appears outside the hard-coded legacy list.

**Evidence:** `config/architecture-boundaries.json:2` defines `packageBoundaryRules` with forbidden edges for `core`, `agent`, `codegen`, `connectors`, `agent-adapters`, and `server`. `scripts/check-domain-boundaries.mjs:37` hard-codes only a legacy extracted-domain import list, then validates layer direction and tooling edges from package manifests in `scripts/check-domain-boundaries.mjs:213` and `scripts/check-domain-boundaries.mjs:231`. The checker does not reference `packageBoundaryRules`; `node scripts/check-domain-boundaries.mjs` was run during this audit and passed, confirming the current gate can be green without evaluating those declared pair rules.

**Remediation:** Update `check-domain-boundaries.mjs` to load `packageBoundaryRules`, map production files to owning package directories, scan actual source imports, and fail on forbidden package pairs. Keep the layer-graph check as the coarse manifest model, but make package-pair rules the stricter source-level guard.

### ARCHITECTURE-004 - Medium - Production team runtime depends on playground primitives

**Impact:** The promoted production team runtime is coupled to an interactive playground implementation and playground result types. That makes the playground package area more than a compatibility/demo layer and creates circularity risk at the module-design level even though it stays inside one package.

**Evidence:** `TeamRuntime` documents itself as the promoted successor to `playground/team-coordinator.ts` in `packages/agent/src/orchestration/team/team-runtime.ts:4`, but imports `SharedWorkspace` from `../../playground/shared-workspace.js` and `SpawnedAgent`/`TeamRunResult` from `../../playground/types.js` in `packages/agent/src/orchestration/team/team-runtime.ts:31`. Its public execution result is explicitly "compatible with the playground coordinator" in `packages/agent/src/orchestration/team/team-runtime.ts:320`, and blackboard execution instantiates the playground `SharedWorkspace` directly in `packages/agent/src/orchestration/team/team-runtime.ts:590`.

**Remediation:** Move shared workspace and team result contracts into an orchestration-owned module such as `packages/agent/src/orchestration/team/workspace.ts` and make playground import from that lower-level runtime contract. Keep compatibility type aliases in playground during migration.

### ARCHITECTURE-005 - Medium - Root public API barrels expose too much implementation surface

**Impact:** Large root barrels make internal modules sticky as public API, hide which symbols are stable versus compatibility or experimental, and make semver-safe refactors harder. Consumers have few narrow import paths, so the root becomes the default dependency on entire package domains.

**Evidence:** Root entry files are large and multi-domain: `packages/core/src/index.ts:1` through `packages/core/src/index.ts:807`, `packages/agent/src/index.ts:1` through `packages/agent/src/index.ts:717`, `packages/server/src/index.ts:1` through `packages/server/src/index.ts:536`, and `packages/codegen/src/index.ts:1` through `packages/codegen/src/index.ts:437`. `@dzupagent/agent` and `@dzupagent/codegen` expose only `"."` in `packages/agent/package.json:7` and `packages/codegen/package.json:7`; `@dzupagent/server` has `./ops` in `packages/server/package.json:15`, but still re-exports CLI/ops-style symbols from the root in `packages/server/src/index.ts:350` and `packages/server/src/index.ts:380`.

**Remediation:** Add package-specific root allowlists and stable subpaths for major domains, for example `@dzupagent/agent/runtime`, `@dzupagent/agent/workflow`, `@dzupagent/codegen/vfs`, `@dzupagent/codegen/tools`, and `@dzupagent/server/compat`. Keep deprecated root re-exports only on a documented migration schedule.

### ARCHITECTURE-006 - Medium - OpenAI-compatible server routes mount unconditionally

**Impact:** Every `createForgeApp` host exposes `/v1/chat/completions` and `/v1/models` even when the host did not opt into an OpenAI-compatible API surface. This widens the default server contract and makes compatibility behavior part of the host baseline instead of an explicit adapter/compat feature.

**Evidence:** `mountOptionalRoutes` always calls `mountOpenAICompatRoutes` in `packages/server/src/composition/optional-routes.ts:66` and `packages/server/src/composition/optional-routes.ts:79`. `mountOpenAICompatRoutes` always installs `/v1/*` auth middleware and routes `/v1/chat/completions` and `/v1/models` in `packages/server/src/composition/optional-routes.ts:259`, `packages/server/src/composition/optional-routes.ts:263`, and `packages/server/src/composition/optional-routes.ts:269`. The config type only provides optional auth under `openai?: { auth?: OpenAIAuthConfig }` in `packages/server/src/composition/types.ts:222`, not an explicit enable flag.

**Remediation:** Require explicit compat opt-in such as `openai: { enabled: true, auth }`, or move OpenAI-compatible HTTP mounting into a route plugin/subpath owned by a compatibility package. Preserve current behavior behind a temporary migration flag if existing consumers depend on it.

### ARCHITECTURE-007 - Medium - `ForgeServerConfig` is a growing god object for unrelated server concerns

**Impact:** Adding a new capability currently tends to mean adding config fields, optional mounting logic, route exports, and tests in the same server package. This reinforces `packages/server` as the integration point for product features and makes host composition harder to reason about.

**Evidence:** `ForgeIntegrationsConfig` combines memory, traces, playground, deploy, learning, benchmarks, evals, MCP, skills, workflow registry, compile, A2A, triggers, schedules, prompts, personas, notifier, presets, reflection, mailbox, mail delivery, clusters, marketplace, OpenAI, prompt feedback, learning processors, and approvals in `packages/server/src/composition/types.ts:180` through `packages/server/src/composition/types.ts:228`. The optional-route composer then mounts those concerns in a single function sequence in `packages/server/src/composition/optional-routes.ts:66`.

**Remediation:** Move feature families behind route plugins or narrower composition modules with their own config contracts. Keep `ForgeServerConfig` focused on host/runtime primitives: stores, event bus, model registry, auth, queue/executor, metrics, shutdown, and route-plugin registration.

### ARCHITECTURE-008 - Medium - Server run worker centralizes too many runtime policies

**Impact:** Queue processing, input guard rejection, approval waits, context transfer, executor dispatch, metadata promotion, quota recording, trace completion, retrieval feedback, and reflection scoring are coupled in one host module. This increases regression risk around terminal state and makes it difficult to reuse individual runtime policies outside the server worker.

**Evidence:** `StartRunWorkerOptions` aggregates queue, run store, event bus, model registry, shutdown, context transfer, metrics, reflector, retrieval feedback, trace store, escalation policy, reflection store, analyzer, input guard, and quota in `packages/server/src/runtime/run-worker.ts:103`. The same worker body handles input guard rejection around `packages/server/src/runtime/run-worker.ts:289`, approval waiting around `packages/server/src/runtime/run-worker.ts:366`, context loading around `packages/server/src/runtime/run-worker.ts:422`, executor dispatch around `packages/server/src/runtime/run-worker.ts:451`, quota recording around `packages/server/src/runtime/run-worker.ts:521`, and reflection scoring around `packages/server/src/runtime/run-worker.ts:578`.

**Remediation:** Keep `startRunWorker` as the compatibility facade, but split internal stages into small interfaces: admission/input guard, approval gate, execution, completion persistence, telemetry/reflection, and post-run learning. Add focused unit tests for each stage plus one integration test for terminal state transitions.

### ARCHITECTURE-009 - Medium - Agent tool loop is a policy hub instead of a narrow execution primitive

**Impact:** Alternative runtimes must either import a very broad policy stack or risk inconsistent behavior. The low-level loop now owns model invocation, budgets, compression, tool scheduling, approval, governance, safety scanning, permission policy, timeout handling, stuck detection, telemetry, and event emission.

**Evidence:** `ToolLoopConfig` includes budget, stuck detector, parallelism, argument validation, tool stats, token lifecycle, governance, safety monitor, event bus, tool timeouts, tracing, agent/run identity, and permission policy across `packages/agent/src/agent/tool-loop.ts:77`, `packages/agent/src/agent/tool-loop.ts:176`, `packages/agent/src/agent/tool-loop.ts:221`, `packages/agent/src/agent/tool-loop.ts:240`, and `packages/agent/src/agent/tool-loop.ts:281`. The implementation directly handles model invocation and loop policy around `packages/agent/src/agent/tool-loop.ts:429`, compression/halt checks around `packages/agent/src/agent/tool-loop.ts:452`, tool execution mode selection around `packages/agent/src/agent/tool-loop.ts:499`, and approval/stuck-related behavior around `packages/agent/src/agent/tool-loop.ts:564`.

**Remediation:** Split the execution kernel from policy decorators. Preserve `runToolLoop` as the public facade, but internally compose model-turn, scheduler, governance/permission gate, result scanner, halt policy, and telemetry stages.

### ARCHITECTURE-010 - Medium - Workflow authoring has overlapping ownership across adapter workflows and flow compiler

**Impact:** Workflow semantics can diverge between adapter-specific orchestration and the canonical flow AST/compiler path. Branching, loops, parallel behavior, route resolution, diagnostics, and event semantics then need duplicate maintenance or implicit reconciliation.

**Evidence:** `packages/agent-adapters/src/workflow/adapter-workflow.ts:1` implements an adapter workflow DSL that imports `PipelineRuntime` from `@dzupagent/agent` in `packages/agent-adapters/src/workflow/adapter-workflow.ts:26`, while the canonical flow packages expose AST/DSL/compiler stages separately through `packages/flow-compiler/src/index.ts:7` and `packages/flow-compiler/package.json:21`. The package layer config classifies `flow-compiler` as a domain package and `agent-adapters` as composition in `config/architecture-boundaries.json:91` and `config/architecture-boundaries.json:100`, which makes duplicated workflow semantics a cross-layer concern rather than a single-module style issue.

**Remediation:** Choose one canonical workflow AST/lowering contract. Either compile adapter workflows through `flow-compiler`, or explicitly document adapter workflows as a provider-routing convenience layer and add equivalence tests for shared constructs such as step order, branch behavior, loop limits, parallel merge, and event emission.

### ARCHITECTURE-011 - Medium - Package-tier governance is not part of the normal verify gate

**Impact:** Owners, roadmap-driver status, supported/parked status, and Tier 3 constraints can drift even while the documented `verify` and `verify:strict` gates pass. This weakens architecture governance because package lifecycle metadata is maintained but not routinely enforced.

**Evidence:** `scripts/check-package-tiers.mjs:40` validates every workspace package against `config/package-tiers.json`, including valid statuses, tiers, owners, roadmap-driver booleans, and parked-package constraints in `scripts/check-package-tiers.mjs:45` through `scripts/check-package-tiers.mjs:87`. The root scripts expose `check:package-tiers` in `package.json:39`, but `verify` and `verify:strict` do not run it in `package.json:29` and `package.json:30`.

**Remediation:** Add `yarn check:package-tiers` to both `verify` and `verify:strict`, or merge the richer tier validation into `check:domain-boundaries` so architecture governance runs with the standard gate.

### ARCHITECTURE-012 - Low - Several production modules are large enough to hide structural responsibilities

**Impact:** Oversized modules make review and ownership harder, especially where the file is not only a barrel but also contains runtime logic. This is a maintainability and regression-risk issue, not a formatting complaint.

**Evidence:** A production-file line-count pass found large modules including `packages/agent/src/agent/tool-loop.ts` at 1665 lines, `packages/flow-ast/src/validate.ts` at 1522 lines, `packages/agent/src/agent/run-engine.ts` at 1070 lines, `packages/agent/src/pipeline/pipeline-runtime.ts` at 1024 lines, `packages/agent/src/orchestration/team/team-runtime.ts` at 982 lines, `packages/server/src/routes/runs.ts` at 915 lines, `packages/server/src/runtime/run-worker.ts` at 909 lines, and `packages/server/src/runtime/tool-resolver.ts` at 722 lines.

**Remediation:** Do not split files mechanically. For each large module, first identify policy, parsing, persistence, execution, and formatting responsibilities, then extract only stable internal stages with focused tests.

### ARCHITECTURE-013 - Low - Exported version constants drift from package versions

**Impact:** Consumers that read exported constants can see stale capability/version metadata even when package manifests are at `0.2.0`. This is low runtime risk but creates release/status ambiguity across public APIs.

**Evidence:** Package manifests report `0.2.0`, for example `packages/core/package.json:3`, `packages/agent/package.json:3`, `packages/codegen/package.json:3`, and `packages/server/package.json:3`. Their exported constants still report `0.1.0` in `packages/core/src/index.ts:807`, `packages/agent/src/index.ts:717`, `packages/codegen/src/index.ts:437`, and `packages/server/src/index.ts:536`; the same pattern appears in `packages/connectors/src/index.ts:95`, `packages/otel/src/index.ts:83`, and `packages/test-utils/src/index.ts:43`.

**Remediation:** Generate public version constants from package metadata during build, or remove them from public API if package manifests are the source of truth. Add a lightweight check that fails when exported constants and package versions diverge.

## Scope Reviewed

- Read the prepared repo snapshot first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-28/run-001/codex-prep/context/repo-snapshot.md`.
- Reviewed current source/config selectively for architecture concerns: package manifests, boundary configs/scripts, root entrypoints, server composition, server routes, server runtime worker, agent team runtime, agent tool loop, flow compiler/package layering, and line-count hotspots.
- Skipped generated outputs, dependency folders, and old audit/analyze artifacts except for noticing that `docs/ARCHITECTURE-AUDIT.md` already existed as the target file to replace.
- Ran one static repository check during this audit: `node scripts/check-domain-boundaries.mjs`, which passed. No build, typecheck, test suite, browser check, or runtime server validation was run.

## Strengths

- The repo has an explicit layered package model in `config/architecture-boundaries.json`, including contracts, foundation, domain, orchestration, composition, host, and tooling layers.
- `check-domain-boundaries.mjs` already enforces package classification, layer direction, tooling-upstream restrictions, and manifest-based runtime dependency cycles.
- The package tier model in `config/package-tiers.json` plus `scripts/check-package-tiers.mjs` is a useful governance primitive once it is wired into normal verification.
- Several contracts have already been extracted into low-level packages, including `@dzupagent/agent-types`, `@dzupagent/adapter-types`, `@dzupagent/runtime-contracts`, `@dzupagent/eval-contracts`, `@dzupagent/memory-ipc`, and `@dzupagent/flow-ast`.
- Server composition is partially decomposed under `packages/server/src/composition`, which is a better starting point than one monolithic app factory.
- `@dzupagent/core` already has stable/advanced/facade subpaths, showing the repo has an established pattern for reducing root import pressure.

## Open Questions Or Assumptions

- I treated the product boundary in `AGENTS.md` as current and authoritative: new product features should not expand `packages/server` or `packages/playground`.
- I treated type-only imports as package-contract evidence. If the intended policy is that type-only imports need not be declared in package manifests, that exception should be explicit in the dependency guard.
- I did not inspect sibling app consumers, so relocation/removal of existing server root exports should be preceded by consumer import analysis.
- I did not perform exhaustive intra-package cycle detection. The circularity findings are based on verified coupling and package boundaries, not a full module graph.
- I separated structural issues from purely stylistic refactors. Formatting, naming, comment style, and local code organization were not counted unless they affected package boundaries, public API shape, ownership, or runtime composition.

## Recommended Next Actions

1. Add a production source-import-to-manifest guard and fix the currently undeclared workspace dependencies.
2. Extend `check-domain-boundaries.mjs` to enforce `packageBoundaryRules`; add `check:package-tiers` to `verify` and `verify:strict`.
3. Freeze new `@dzupagent/server` product/control-plane additions, add a server root allowlist, and move forward-path product surfaces to consuming apps or route plugins.
4. Move shared team workspace/result contracts out of `playground` so `TeamRuntime` depends on orchestration-owned primitives.
5. Gate OpenAI-compatible `/v1/*` routes behind explicit opt-in.
6. Split `run-worker` and `runToolLoop` internally into policy stages while preserving current public facades.
7. Decide whether adapter workflows compile through `flow-compiler` or remain intentionally separate, then add semantic equivalence tests for overlapping constructs.

## Finding Manifest

```json
{
  "domain": "architecture",
  "counts": { "critical": 0, "high": 3, "medium": 8, "low": 2, "info": 0 },
  "findings": [
    { "id": "ARCHITECTURE-001", "severity": "high", "title": "Published packages import undeclared workspace dependencies", "file": "packages/connectors/package.json" },
    { "id": "ARCHITECTURE-002", "severity": "high", "title": "@dzupagent/server remains a broad product/control-plane host", "file": "packages/server/src/composition/optional-routes.ts" },
    { "id": "ARCHITECTURE-003", "severity": "high", "title": "Declared package-pair boundary rules are not enforced", "file": "scripts/check-domain-boundaries.mjs" },
    { "id": "ARCHITECTURE-004", "severity": "medium", "title": "Production team runtime depends on playground primitives", "file": "packages/agent/src/orchestration/team/team-runtime.ts" },
    { "id": "ARCHITECTURE-005", "severity": "medium", "title": "Root public API barrels expose too much implementation surface", "file": "packages/core/src/index.ts" },
    { "id": "ARCHITECTURE-006", "severity": "medium", "title": "OpenAI-compatible server routes mount unconditionally", "file": "packages/server/src/composition/optional-routes.ts" },
    { "id": "ARCHITECTURE-007", "severity": "medium", "title": "ForgeServerConfig is a growing god object for unrelated server concerns", "file": "packages/server/src/composition/types.ts" },
    { "id": "ARCHITECTURE-008", "severity": "medium", "title": "Server run worker centralizes too many runtime policies", "file": "packages/server/src/runtime/run-worker.ts" },
    { "id": "ARCHITECTURE-009", "severity": "medium", "title": "Agent tool loop is a policy hub instead of a narrow execution primitive", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "ARCHITECTURE-010", "severity": "medium", "title": "Workflow authoring has overlapping ownership across adapter workflows and flow compiler", "file": "packages/agent-adapters/src/workflow/adapter-workflow.ts" },
    { "id": "ARCHITECTURE-011", "severity": "medium", "title": "Package-tier governance is not part of the normal verify gate", "file": "package.json" },
    { "id": "ARCHITECTURE-012", "severity": "low", "title": "Several production modules are large enough to hide structural responsibilities", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "ARCHITECTURE-013", "severity": "low", "title": "Exported version constants drift from package versions", "file": "packages/core/src/index.ts" }
  ]
}
```
