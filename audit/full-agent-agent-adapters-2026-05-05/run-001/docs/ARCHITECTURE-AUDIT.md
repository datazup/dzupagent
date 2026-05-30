# Architecture Audit — `@dzupagent/agent` + `@dzupagent/agent-adapters`

**Date:** 2026-05-05
**LOC:** agent ~44,280 src LOC; agent-adapters ~35,545 src LOC

---

## Summary

The dependency direction (`core → agent-types/adapter-types → agent → agent-adapters`) is correct in `package.json` and no runtime circular dependencies were found. However, three P1 boundary violations exist in test files, and several P2 god-class / conceptual-duplication issues require structural work.

| Severity | Count |
|----------|-------|
| P1 | 4 |
| P2 | 8 |
| P3 | 6 |
| **Total** | **18** |

---

## P1 — Urgent

### ARCH-001 · P1 · `agent` test imports `@dzupagent/server` (forbidden upward dep, undeclared)
**File:** `packages/agent/src/__tests__/workflow-durability-integration.test.ts:14`
Imports `createForgeApp, type ForgeServerConfig from '@dzupagent/server'`. Server depends on agent — never the reverse. `@dzupagent/server` is not declared anywhere in `packages/agent/package.json`. Works only because workspace resolution finds it; fails in a published build.
**Fix:** Move test to `packages/server/src/__tests__/`, OR rewrite to use only public `@dzupagent/agent` API + `InMemoryRunStore`/`InMemoryRunJournal`.

### ARCH-002 · P1 · `agent-adapters` test uses sibling-package relative path
**File:** `packages/agent-adapters/src/__tests__/structured-output-parity.test.ts:17-18`
Imports `from '../../../agent/src/index.js'` — bypasses the `@dzupagent/agent` `exports` field entirely and couples to internal source layout.
**Fix:** Replace with `from '@dzupagent/agent'`.

### ARCH-003 · P1 · No automated boundary enforcement test for `agent → server/agent-adapters` non-imports
**Scope:** `packages/agent` and `packages/agent-adapters` (test infrastructure gap)
The existing `memory-client-boundary.test.ts` enforces one boundary; no equivalent enforces the full upstream non-import invariant.
**Fix:** Add `upstream-package-boundary.test.ts` in both packages asserting forbidden upstream imports and no relative `../../../` escapes.

### ARCH-004 · P1 · Workflow ownership claims `@dzupagent/flow-compiler` dependency but it is undeclared
**File:** `packages/agent-adapters/src/workflow/adapter-workflow.ts:8-12` (doc comment)
Comment establishes `@dzupagent/flow-compiler` as canonical parsing/lowering owner, but neither `agent` nor `agent-adapters` declares it as a dependency. The layer boundary is informal and unenforced.
**Fix:** Write ADR-0007 locking the flow-compiler dependency layer; add typed `FlowCompilerPort` interface in `adapter-types`.

---

## P2 — Structural Issues

### ARCH-005 · P2 · `TeamRuntime` god class (1,281 LOC, ~25 methods, 5 coordination patterns)
**File:** `packages/agent/src/orchestration/team/team-runtime.ts`
Implements supervisor / contract-net / blackboard / peer-to-peer / council in a single `execute` switch. Has its own circuit-breaker tracking (duplicates `orchestration/circuit-breaker.ts`), policy validation (3 dedicated methods), blackboard formatting, phase transitions, OTel span management.
**Fix:** Define `TeamPattern` interface in `agent-types`; extract each `run*` method into `team/patterns/<pattern>-pattern.ts` (5 files ≤200 LOC each); `TeamRuntime` becomes a ~250 LOC dispatcher.

### ARCH-006 · P2 · `PipelineRuntime` mega-class (1,029 LOC) despite existing helpers in `pipeline-runtime/`
**File:** `packages/agent/src/pipeline/pipeline-runtime.ts`
`pipeline-runtime/` folder with `branch-merge.ts`, `edge-resolution.ts`, `error-classification.ts`, etc. exists but the runtime class still owns large algorithm slabs. Naming is confusing (file `pipeline-runtime.ts` next to folder `pipeline-runtime/`).
**Fix:** Rename folder to `pipeline-runtime-internals/`; extract `PipelineExecutor` (per-node algorithm) from `PipelineRuntime` (run lifecycle + events); target ≤400 LOC each.

### ARCH-007 · P2 · `AdapterWorkflow` (1,128 LOC) and `WorkflowBuilder` (954 LOC) duplicate the same DSL concept
**Files:** `packages/agent/src/workflow/workflow-builder.ts`, `packages/agent-adapters/src/workflow/adapter-workflow.ts`
Both implement `step`/`parallel`/`branch`/`loop`/`transform`/`build()` DSL compiling to the same `PipelineDefinition`. Shared helpers (`resolveTemplate`, `mergeParallelResults`) are functionally equivalent.
**Fix:** Promote `WorkflowGraphBuilder` into `@dzupagent/workflow-dsl` (or `agent-types/workflow-dsl/`); `agent`'s builder extends with journal/store; `agent-adapters`'s builder extends with provider routing.

### ARCH-008 · P2 · Orchestration primitives reimplemented in both packages
**Files:** `agent/src/orchestration/{contract-net,map-reduce.ts,supervisor→orchestrator.ts}` vs `agent-adapters/src/orchestration/{contract-net.ts,map-reduce.ts,supervisor.ts,parallel-executor.ts}`
`agent-types/orchestration-contracts.ts` provides base contracts but only `agent-adapters` uses them; `agent`'s implementations diverge silently.
**Fix:** Audit each pair and force both to implement `agent-types` extension contracts; add `SupervisorAlgorithm<TAgent>`, `ContractNetAlgorithm<TAgent>`, `MapReduceAlgorithm<TAgent>` interfaces.

### ARCH-009 · P2 · `BaseCLIAdapter` (821 LOC, 30+ methods) bundles 4 concerns
**File:** `packages/agent-adapters/src/base/base-cli-adapter.ts`
Owns: governance event emission (~80 LOC), guardrails attachment (~100 LOC), rule validation, artifact watcher lifecycle, env building, error normalization, interaction policy, capability declaration, process spawning.
**Fix:** Extract `governance-emitter.ts`, `artifact-watcher-host.ts`, `env-builder.ts`, `adapter-error-normalizer.ts`; `BaseCLIAdapter` becomes a thin composition (~250 LOC).

### ARCH-010 · P2 · `CodexAdapter` (1,098 LOC) and `ClaudeAdapter` (728 LOC) re-implement stream-iteration, retry, raw-event mapping
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts`, `packages/agent-adapters/src/claude/claude-adapter.ts`
Both re-implement: `AbortController` plumbing, heartbeat detection, raw passthrough, lifecycle events, usage extraction, error classification. Every new adapter (today 8) repeats this.
**Fix:** Add `base/stream-runner.ts` with `AdapterStreamSource<TRaw>` interface and `AdapterStreamRunner<TRaw>` class; each adapter becomes a 200-300 LOC `AdapterStreamSource` impl.

### ARCH-011 · P2 · `AdapterRegistry` (750 LOC) blends router, health-checker, lifecycle manager (22+ public methods)
**File:** `packages/agent-adapters/src/registry/adapter-registry.ts`
**Fix:** Split into `registry.ts` (CRUD), `health-monitor.ts` (health + circuit breaker), `router.ts` (task routing); keep `ProviderAdapterRegistry` as back-compat façade.

### ARCH-012 · P2 · Shared utilities `exact-optional` and `event-record` not in `core`
**Files:** `packages/agent/src/utils/exact-optional.ts`, `packages/agent-adapters/src/utils/event-record.ts`
Both are generally useful pure utilities but live in package-specific `utils/` directories.
**Fix:** Move both to `@dzupagent/core/utils/`; all consumers import from `@dzupagent/core`.

---

## P3 — Polish

### ARCH-013 · P3 · 27/30 `agent-adapters` subdirs missing `index.ts` barrels
Forces all consumers to import from deep paths; refactors break consumers.
**Fix:** Add one-line `index.ts` in each subdirectory; root `index.ts` re-exports from subdir barrels (target: 587 LOC → ~120 LOC).

### ARCH-014 · P3 · Several `agent` subdirs missing barrels
`src/agent/`, `src/context/`, `src/guardrails/`, `src/tools/`, `src/utils/`, `src/snapshot/` lack `index.ts`.
**Fix:** Same as ARCH-013; root `index.ts` shrinks from 813 LOC.

### ARCH-015 · P3 · `playground/` (1,556 LOC) still in `agent` despite being marked as moved
**File:** `packages/agent/src/playground/`
CLAUDE.md states playground moved to `apps/codev-app`. The `./playground/ui` export is bricked (`null`) but `./playground` still resolves.
**Fix:** Move still-used symbols to `orchestration/team/`; move `playground.ts`/`team-coordinator.ts` to `apps/codev-app/`; drop subpath export.

### ARCH-016 · P3 · `compat.ts` subpath has no documented sunset date
**File:** `packages/agent/src/compat.ts`
"Transitional compatibility facade" with no removal target version.
**Fix:** Tag each export with `@deprecated since 0.2.0, removed in 0.4.0`; write ADR-0008.

### ARCH-017 · P3 · Root `index.ts` size sprawl (813 LOC agent, 587 LOC agent-adapters)
After ARCH-013/014, both should shrink to ~80 named re-exports.

### ARCH-018 · P3 · `MergeStrategy` type name collision across packages
`agent/src/workflow/workflow-types.ts` and `agent-adapters/src/orchestration/parallel-executor.ts` both export incompatible `MergeStrategy` types.
**Fix:** Promote canonical taxonomy to `agent-types/orchestration-contracts.ts`; rename adapter version to `ParallelMergeStrategy`.
