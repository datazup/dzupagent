# Architecture Audit

## Findings

### ARCHITECTURE-001 - High - Workspace packages import undeclared `@dzupagent/*` dependencies

**Impact:** Published packages can pass in the monorepo because Yarn workspaces hoist sibling packages, while consumers of the built packages can fail to resolve runtime imports or receive incomplete dependency graphs. This also weakens layer/cycle analysis because package manifests no longer fully describe the true runtime graph.

**Evidence:** `@dzupagent/connectors` imports `AsyncToolResolver` and `ResolvedTool` from `@dzupagent/flow-ast` in `packages/connectors/src/agent-registry-resolver.ts:17` and `packages/connectors/src/mcp-tool-resolver.ts:13`, but `packages/connectors/package.json:23` only declares `@dzupagent/core` among workspace dependencies. `@dzupagent/evals` re-exports contract types from `@dzupagent/eval-contracts` in `packages/evals/src/index.ts:20`, but `packages/evals/package.json:21` only declares `@dzupagent/core`. `@dzupagent/server` imports types from `@dzupagent/memory` in `packages/server/src/routes/memory-sync.ts:13`; its manifest declares `@dzupagent/memory-ipc` but not `@dzupagent/memory` in `packages/server/package.json:30`.

**Remediation:** Add a CI guard that derives production `@dzupagent/*` imports from source and verifies they are declared in `dependencies` or `peerDependencies`, with explicit exceptions only for template string fixtures. Then fix the current manifest drift by adding the missing package declarations or moving the imports behind already-declared contract packages where that is the intended boundary.

### ARCHITECTURE-002 - High - `@dzupagent/server` remains a broad product/control-plane host despite the framework boundary

**Impact:** Product concepts can keep accumulating in the compatibility server package, making the framework server the accidental forward path for workspaces, personas, prompts, marketplace, clusters, mailbox, triggers, schedules, and OpenAI-compatible UX surfaces. That conflicts with the stated product boundary and makes later extraction harder because external consumers may already depend on root exports and route behavior.

**Evidence:** The server root exports persona, prompt, preset, reflection, mailbox, cluster, marketplace, trigger, schedule, OpenAI-compatible, deploy, docs, registry, and route factories from one public root in `packages/server/src/index.ts:245`, `packages/server/src/index.ts:271`, `packages/server/src/index.ts:288`, `packages/server/src/index.ts:298`, `packages/server/src/index.ts:304`, `packages/server/src/index.ts:313`, `packages/server/src/index.ts:443`, and `packages/server/src/index.ts:509`. The app factory mounts those same product-like optional surfaces through one composition path in `packages/server/src/app.ts:93` and `packages/server/src/composition/optional-routes.ts:66`.

**Remediation:** Freeze new root exports for `@dzupagent/server`, classify existing server surfaces as compatibility-only, and move forward-path product control planes to consuming apps or narrower framework packages. Keep server as host/runtime composition and provide migration subpaths for remaining compatibility areas rather than growing the root contract.

### ARCHITECTURE-003 - High - Declared forbidden package-pair rules are not enforced by the boundary checker

**Impact:** The repository appears to have fine-grained package boundary policy, but the active checker does not consume that policy. A future direct import such as `codegen -> agent` or `connectors -> codegen` could land if it still satisfies coarse layer direction, creating tight coupling before review catches it.

**Evidence:** `config/architecture-boundaries.json:2` defines `packageBoundaryRules` with explicit forbidden edges for `core`, `agent`, `codegen`, `connectors`, `agent-adapters`, and `server`. `scripts/check-domain-boundaries.mjs:37` instead hard-codes only a legacy `FORBIDDEN_IMPORTS` list and then validates classification, layer direction, tooling edges, and manifest cycles via `layerGraph` in `scripts/check-domain-boundaries.mjs:146` and `scripts/check-domain-boundaries.mjs:213`. A search of the checker shows `packageBoundaryRules` is not referenced. `yarn check:domain-boundaries` was run during this audit and passed, which confirms the current gate can be green without evaluating those declared pair rules.

**Remediation:** Teach `check-domain-boundaries.mjs` to load `packageBoundaryRules`, scan production imports by source package, and fail when a forbidden pair appears. Keep the existing layer-graph check, but make the pair rules the place for architectural exceptions that are stricter than layer direction.

### ARCHITECTURE-004 - Medium - Root public API barrels expose too much implementation surface

**Impact:** Large root barrels make internal modules sticky as public API, increase migration cost, and obscure which symbols are stable versus compatibility or experimental. This is especially risky for framework packages consumed by apps because importing from the root is the path of least resistance.

**Evidence:** Root entry files are large and export many subdomains: `packages/core/src/index.ts` is 807 lines, `packages/agent/src/index.ts` is 717 lines, `packages/agent-adapters/src/index.ts` is 543 lines, `packages/server/src/index.ts` is 536 lines, and `packages/codegen/src/index.ts` is 437 lines. `@dzupagent/agent` and `@dzupagent/agent-adapters` expose only `"."` in `packages/agent/package.json:7` and `packages/agent-adapters/package.json:8`, so consumers have no stable subpath alternative for narrower imports. `@dzupagent/server` has a first non-root `./ops` subpath in `packages/server/package.json:15`, but the root still re-exports ops symbols in `packages/server/src/index.ts:350` and `packages/server/src/index.ts:380`.

**Remediation:** Define per-package root allowlists for Tier 1 packages, add subpaths for stable domains such as `@dzupagent/agent/runtime`, `@dzupagent/agent/workflow`, `@dzupagent/agent-adapters/providers`, and `@dzupagent/server/compat`, and move experimental or operational exports off the root on a compatibility schedule.

### ARCHITECTURE-005 - Medium - `run-worker` centralizes too many runtime policies in one host module

**Impact:** Queue processing, approval waits, input scanning, trace writing, context transfer, executor dispatch, quota attribution, reflection scoring, metadata promotion, retrieval feedback, escalation, and analyzer hooks are coupled in one flow. This increases regression risk because adding a policy means editing the same long function that controls terminal state transitions and persistence.

**Evidence:** `StartRunWorkerOptions` aggregates queue, stores, event bus, model registry, shutdown, context transfer, metrics, reflector, retrieval feedback, trace store, escalation policy, reflection store, analyzer, input guard, and quota in `packages/server/src/runtime/run-worker.ts:103`. The worker body then performs input guard rejection and redaction in `packages/server/src/runtime/run-worker.ts:289`, approval waiting in `packages/server/src/runtime/run-worker.ts:366`, context loading in `packages/server/src/runtime/run-worker.ts:422`, executor dispatch in `packages/server/src/runtime/run-worker.ts:451`, output/metadata promotion in `packages/server/src/runtime/run-worker.ts:469`, quota recording in `packages/server/src/runtime/run-worker.ts:521`, trace completion in `packages/server/src/runtime/run-worker.ts:548`, and reflection scoring in `packages/server/src/runtime/run-worker.ts:578`.

**Remediation:** Keep the public worker entrypoint, but extract explicit policy stages behind small interfaces: admission/input guard, approval gate, execution, completion persistence, telemetry/reflection, and post-run learning. Add focused tests per stage so terminal state invariants are not dependent on one large integration fixture.

### ARCHITECTURE-006 - Medium - The agent tool loop has become a policy hub rather than a narrow execution primitive

**Impact:** The low-level ReAct loop now owns model invocation, budget enforcement, token lifecycle compression, tool stats prompts, parallel tool execution, approval gating, stuck recovery, governance, safety scanning, permission checks, timeout policy, telemetry spans, and event emission. This makes it difficult to reuse the primitive in alternative runtimes without importing the whole policy stack or risking inconsistent behavior.

**Evidence:** `ToolLoopConfig` includes budget, stuck detector, parallelism, argument validation, tool stats, token lifecycle halt/compression, governance, safety monitor, event bus, tool timeouts, tracing, agent/run identity, and permission policy in `packages/agent/src/agent/tool-loop.ts:77`, `packages/agent/src/agent/tool-loop.ts:176`, `packages/agent/src/agent/tool-loop.ts:200`, `packages/agent/src/agent/tool-loop.ts:221`, `packages/agent/src/agent/tool-loop.ts:240`, and `packages/agent/src/agent/tool-loop.ts:281`. The implementation directly handles model invocation, compression, halt checks, execution mode selection, approval suspension, stuck escalation, and stats aggregation in `packages/agent/src/agent/tool-loop.ts:429`, `packages/agent/src/agent/tool-loop.ts:452`, `packages/agent/src/agent/tool-loop.ts:476`, `packages/agent/src/agent/tool-loop.ts:499`, and `packages/agent/src/agent/tool-loop.ts:564`.

**Remediation:** Split the execution kernel from policy decorators. Preserve `runToolLoop` as the compatibility facade, but internally compose smaller stages such as model turn, tool scheduler, governance gate, result scanner, and halt policy.

### ARCHITECTURE-007 - Medium - There are two workflow-authoring paths with overlapping ownership

**Impact:** Workflow semantics can diverge between adapter-specific workflows and canonical flow compiler semantics. This raises maintenance cost for branching, loops, provider routing, eventing, and validation because changes must be mirrored or consciously reconciled across two packages.

**Evidence:** `packages/agent-adapters/src/workflow/adapter-workflow.ts:1` defines a declarative workflow DSL for multi-step adapter orchestration, with step, parallel, branch, transform, and loop node types in `packages/agent-adapters/src/workflow/adapter-workflow.ts:156`. It imports canonical `PipelineDefinition`/`PipelineNode` from `@dzupagent/core` and executes via `PipelineRuntime` from `@dzupagent/agent` in `packages/agent-adapters/src/workflow/adapter-workflow.ts:24`. Separately, `@dzupagent/flow-compiler` exposes a canonical parse, shape validate, semantic resolve, route, and lower pipeline in `packages/flow-compiler/src/index.ts:7`, with public stage exports in `packages/flow-compiler/src/index.ts:43`.

**Remediation:** Establish one canonical workflow AST/lowering contract. Either make adapter workflows compile through `flow-compiler` or explicitly document them as a provider-routing convenience layer with tests that prove equivalent semantics for shared constructs such as step order, parallel merge, branch behavior, loop limits, and event emission.

### ARCHITECTURE-008 - Medium - Package tier metadata is maintained by a script but not part of the normal verify gate

**Impact:** Owners, roadmap-driver status, and parked-package constraints can drift even when the documented `verify` and `verify:strict` commands pass. That weakens governance for which packages are supported versus parked and makes architectural status less reliable over time.

**Evidence:** `scripts/check-package-tiers.mjs:1` validates package-tier status, owners, roadmap-driver booleans, and Tier 3 constraints. The root script exposes `check:package-tiers` in `package.json:39`, but `verify` and `verify:strict` call `check:domain-boundaries`, `check:terminal-tool-event-guards`, and other checks without `check:package-tiers` in `package.json:29` and `package.json:30`.

**Remediation:** Add `yarn check:package-tiers` to `verify` and `verify:strict`, or fold the richer tier validation into `check:domain-boundaries` so package governance is enforced wherever architecture boundaries are enforced.

## Scope Reviewed

- Read the prepared repo snapshot at `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md` first.
- Reviewed current repository source and configuration selectively for architecture concerns: package manifests, boundary configs/scripts, root entrypoints, server composition, run worker, agent tool loop, adapter workflow DSL, and flow compiler entrypoint.
- Skipped generated outputs, dependency folders, and old audit artifacts.
- Ran one static repository check: `yarn check:domain-boundaries` passed. No build, typecheck, test suite, or runtime validation was run for this audit.

## Strengths

- The repo has an explicit layered architecture model in `config/architecture-boundaries.json`, including contracts, foundation, domain, orchestration, composition, host, and tooling layers.
- `check-domain-boundaries.mjs` already enforces package classification, layer direction, tooling-upstream restrictions, and package-manifest runtime cycles.
- The server composition root has been partially decomposed into focused helpers under `packages/server/src/composition`, which is a better structure than one monolithic app factory.
- Several packages already use contract packages to reduce coupling, for example `@dzupagent/eval-contracts`, `@dzupagent/agent-types`, `@dzupagent/adapter-types`, and `@dzupagent/runtime-contracts`.
- The server API surface has an inventory/generation script and a first non-root ops facade, which gives the project a path to reduce root export sprawl incrementally.

## Open Questions Or Assumptions

- I assumed the product boundary in `AGENTS.md` is current and authoritative: new product-facing workspace/project/persona/prompt/operator UX should not continue to expand `packages/server` or `packages/playground`.
- I treated source imports from production `src/**` as architecture evidence even when TypeScript may erase type-only imports, because public package manifests and boundary checks should still reflect package-level contracts or use explicit type-only exceptions.
- I did not inspect app consumers in `apps/codev-app` or other sibling apps; consumer usage should be checked before removing or relocating existing server root exports.
- I did not attempt exhaustive module-cycle detection inside each package. The findings focus on high-impact representative structural risks under the standard budget cap.

## Recommended Next Actions

1. Add and run a source-import-to-manifest guard, then fix the current undeclared workspace dependencies.
2. Extend `check-domain-boundaries.mjs` to enforce `packageBoundaryRules` and include `check:package-tiers` in the standard verify path.
3. Freeze `@dzupagent/server` root additions and create an explicit compatibility/root allowlist with migration subpaths.
4. Refactor `run-worker` and `runToolLoop` behind internal policy-stage interfaces without changing their public facades in the first slice.
5. Decide whether adapter workflows compile through `flow-compiler` or remain a separate convenience DSL, then add equivalence tests for overlapping constructs.

## Finding Manifest

```json
{
  "domain": "architecture",
  "counts": { "critical": 0, "high": 3, "medium": 5, "low": 0, "info": 0 },
  "findings": [
    { "id": "ARCHITECTURE-001", "severity": "high", "title": "Workspace packages import undeclared @dzupagent/* dependencies", "file": "packages/connectors/package.json" },
    { "id": "ARCHITECTURE-002", "severity": "high", "title": "@dzupagent/server remains a broad product/control-plane host despite the framework boundary", "file": "packages/server/src/index.ts" },
    { "id": "ARCHITECTURE-003", "severity": "high", "title": "Declared forbidden package-pair rules are not enforced by the boundary checker", "file": "scripts/check-domain-boundaries.mjs" },
    { "id": "ARCHITECTURE-004", "severity": "medium", "title": "Root public API barrels expose too much implementation surface", "file": "packages/core/src/index.ts" },
    { "id": "ARCHITECTURE-005", "severity": "medium", "title": "run-worker centralizes too many runtime policies in one host module", "file": "packages/server/src/runtime/run-worker.ts" },
    { "id": "ARCHITECTURE-006", "severity": "medium", "title": "The agent tool loop has become a policy hub rather than a narrow execution primitive", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "ARCHITECTURE-007", "severity": "medium", "title": "There are two workflow-authoring paths with overlapping ownership", "file": "packages/agent-adapters/src/workflow/adapter-workflow.ts" },
    { "id": "ARCHITECTURE-008", "severity": "medium", "title": "Package tier metadata is maintained by a script but not part of the normal verify gate", "file": "package.json" }
  ]
}
```
