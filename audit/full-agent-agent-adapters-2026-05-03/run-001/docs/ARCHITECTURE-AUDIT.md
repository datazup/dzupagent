# ARCHITECTURE-AUDIT: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03
**Packages:** `packages/agent`, `packages/agent-adapters`

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 7 |
| Medium | 8 |
| Low | 3 |
| **Total** | **20** |

---

## Findings

### A-01: `AdapterWorkflowBuilder` imports concrete `PipelineRuntime` — missing DI port
**Severity:** Critical
**File:** `packages/agent-adapters/src/workflow/adapter-workflow.ts:42`
**Pattern:** `AdapterWorkflowBuilder` directly imports `PipelineRuntime` (concrete class) from `@dzupagent/agent`. While the import direction is correct (layer 6 importing from layer 5), the adapter layer is tightly coupled to an implementation class. `PipelineDefinition` is already a contract in `@dzupagent/core` (line 655 of `packages/core/src/index.ts`); the runtime should be injected.
**Refactor guidance:** Introduce `PipelineExecutorPort` interface in `@dzupagent/core`. `AdapterWorkflowBuilder` accepts the port via constructor injection. Concrete `PipelineRuntime` wiring stays in `@dzupagent/agent`.
**Effort:** 2-3d

---

### A-02: `ProviderExecutionPort` / `ProviderExecutionResult` defined in `@dzupagent/agent` instead of `@dzupagent/adapter-types`
**Severity:** Critical
**File:** `packages/agent-adapters/src/integration/provider-execution-port.ts:10-13`
**Pattern:** Pure interface types imported from `@dzupagent/agent`. They carry no implementation and should reside in the type-contract package `@dzupagent/adapter-types`.
**Refactor guidance:** Move to `@dzupagent/adapter-types`. Re-export from `@dzupagent/agent` as a shim. Update `RegistryExecutionPort` import.
**Effort:** 1d

---

### A-03: `SupervisorConfig` / `MapReduceConfig` / `ContractNetConfig` independently redefined in both packages
**Severity:** High
**Files:**
- `packages/agent/src/orchestration/orchestrator.ts:23`
- `packages/agent-adapters/src/orchestration/supervisor.ts:83`
- `packages/agent/src/orchestration/map-reduce.ts:19`
- `packages/agent-adapters/src/orchestration/map-reduce.ts:106`
- `packages/agent/src/orchestration/contract-net/contract-net-types.ts`
- `packages/agent-adapters/src/orchestration/contract-net.ts`
**Pattern:** Both packages export types with identical names for the same orchestration concepts. Consumers importing both see name collisions.
**Refactor guidance:** Define generic base contracts (`BaseMapReduceConfig<TAgent>`, etc.) in `@dzupagent/agent-types`. Each package provides a typed specialization.
**Effort:** 3-4d

---

### A-04: Two parallel UCL implementations (`ucl/` vs `dzupagent/`) — 497 LOC duplicated frontmatter parser
**Severity:** High
**Files:**
- `packages/agent-adapters/src/ucl/frontmatter-parser.ts` (234 LOC)
- `packages/agent-adapters/src/dzupagent/md-frontmatter-parser.ts` (263 LOC)
- `packages/agent-adapters/src/ucl/memory-loader.ts` (113 LOC)
- `packages/agent-adapters/src/dzupagent/memory-loader.ts` (355 LOC)
- `packages/agent-adapters/src/ucl/agent-loader.ts` (90 LOC)
- `packages/agent-adapters/src/dzupagent/agent-loader.ts` (349 LOC)
**Pattern:** `ucl/` is an older, thinner version of `dzupagent/`. No production code imports from `ucl/`, but it exists as a public surface. Two independent frontmatter parsers (497 LOC combined).
**Refactor guidance:** Delete `ucl/` subdirectory. Single frontmatter parser lives in `dzupagent/md-frontmatter-parser.ts`.
**Effort:** 2d

---

### A-05: `AdapterStuckDetector` is a near-copy of `StuckDetector` from `@dzupagent/agent`
**Severity:** High
**Files:**
- `packages/agent-adapters/src/guardrails/adapter-guardrails.ts:101`
- `packages/agent/src/guardrails/stuck-detector.ts:29`
- `packages/agent/src/guardrails/iteration-budget.ts:8`
**Pattern:** Both track repeated tool calls via SHA-256 hash, error rates in a sliding window, and idle iteration counts. The `hashInput` function is byte-for-byte identical in both.
**Refactor guidance:** Extract `hashToolInput(input: unknown): string` to `@dzupagent/core/src/utils/hash.ts`. Extract `BaseStuckDetectorConfig` to `@dzupagent/agent-types`. Both implementations import the shared helper.
**Effort:** 2-3d

---

### A-06: `OrchestratorFacade` is a god object (909 LOC, 9 concerns, 10 public methods)
**Severity:** High
**File:** `packages/agent-adapters/src/facade/orchestrator-facade.ts:251`
**Pattern:** Owns: provider registry lifecycle, event bus wiring, cost tracking, policy compilation, approval gate, guardrails, session registry, UCL config resolution, and 8 orchestration patterns. Constructor initializes 9 fields.
**Refactor guidance:** Extract `PolicyEnforcementPipeline`, `ApprovalPipelineStep`, `GuardrailsPipelineStep`, `UCLEnrichmentStep`. `OrchestratorFacade` becomes a ≤300 LOC coordinator injecting composable steps.
**Effort:** 4-5d

---

### A-07: `MemoryServiceLike` interface defined in four separate locations
**Severity:** High
**Files:**
- `packages/agent-adapters/src/middleware/memory-enrichment.ts:36`
- `packages/context/src/snapshot-builder.ts:26`
- `packages/memory-ipc/src/memory-service-ext.ts:40`
- `packages/rag/src/memory-namespace.ts:32`
**Pattern:** Structural duck-typing interface appearing in 4 independent files. Silent divergence risk if any one adds a required method.
**Refactor guidance:** Canonicalize in `@dzupagent/adapter-types`. All four files import from there.
**Effort:** 1-2d

---

### A-08: `TeamRuntime` (1,281 LOC) ships as a structural skeleton with stub LLM invocations
**Severity:** High
**File:** `packages/agent/src/orchestration/team/team-runtime.ts:22`
**Pattern:** The file's own documentation states LLM invocations "do not yet invoke real LLMs." Exported as tier-1 public API. Three hardcoded model-name constants embedded as exported API.
**Refactor guidance:** Mark `@experimental`. Extract model constants to `TeamRuntimeDefaults`. Split into `team-runtime-base.ts` (~300 LOC infrastructure) and pattern-specific files.
**Effort:** 3d annotation/extraction + 5-10d completing stubs

---

### A-09: `AdapterRecoveryCopilot` is a god object (1,250 LOC)
**Severity:** High
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:1`
**Pattern:** Owns trace storage with `setInterval` eviction, abort controller management, non-streaming + streaming recovery loops, human escalation, and cross-provider handoff. `setInterval` in constructor leaks if `dispose()` is not called.
**Refactor guidance:** Extract `ExecutionTraceStore` (injectable, handles eviction) and `RecoveryLoopRunner`. `AdapterRecoveryCopilot` becomes ~200 LOC coordinator.
**Effort:** 3d

---

### A-10: Duplicate structured-output implementations in both packages
**Severity:** Medium
**Files:**
- `packages/agent-adapters/src/output/structured-output.ts:361` (`StructuredOutputAdapter`, 744 LOC)
- `packages/agent/src/structured/structured-output-engine.ts:230` (`generateStructured`)
**Pattern:** Both implement JSON extraction from markdown, Zod schema-to-prompt conversion, retry-with-repair loops. Core utilities (`extractJsonFromCodeBlock`, `buildSchemaDescription`) duplicated.
**Refactor guidance:** Extract shared utilities (`extractJsonFromText`, `buildZodPromptHint`, `repairJsonString`) to `@dzupagent/core`.
**Effort:** 2d

---

### A-11: `ConversationCompressor` in agent-adapters duplicates `autoCompress` from `@dzupagent/context`
**Severity:** Medium
**Files:**
- `packages/agent-adapters/src/session/conversation-compressor.ts:83` (250 LOC)
- `packages/agent/src/context/auto-compress.ts` (6-line re-export shim)
**Pattern:** Same trim-oldest-turns compression strategy implemented twice, once per message type.
**Refactor guidance:** Define `ConversationCompactionPort<T>` in `@dzupagent/adapter-types`. One impl in `@dzupagent/context` (LangChain messages), one in agent-adapters (`ConversationTurn`).
**Effort:** 2d

---

### A-12: Claude and Codex adapters do not extend `BaseCliAdapter` — three base-class patterns
**Severity:** Medium
**Files:**
- `packages/agent-adapters/src/base/base-cli-adapter.ts:96`
- `packages/agent-adapters/src/claude/claude-adapter.ts` (778 LOC, implements `AgentCLIAdapter` directly)
- `packages/agent-adapters/src/codex/codex-adapter.ts` (1,144 LOC, implements `AgentCLIAdapter` directly)
- Gemini, Goose, Qwen, Crush all extend `BaseCliAdapter`
**Pattern:** SDK adapters re-implement started/completed/failed lifecycle events, `InteractionResolver` wiring, token accumulation, abort controller management, and `filterSensitiveEnvVars` independently.
**Refactor guidance:** Create `BaseSdkAdapter` abstract class with shared lifecycle skeleton. Claude and Codex extend it.
**Effort:** 2d

---

### A-13: `AdapterHttpHandler` (794 LOC) — HTTP layer embedded in adapter package
**Severity:** Medium
**File:** `packages/agent-adapters/src/http/adapter-http-handler.ts:1`
**Pattern:** Full HTTP handler with request parsing, Zod validation, streaming, token validation, rate limiting, and response formatting — in layer 6 instead of layer 7 (`server`/`express`).
**Refactor guidance:** Move `adapter-http-handler.ts`, `rate-limiter.ts`, `request-schemas.ts` to `@dzupagent/express` or a new `@dzupagent/adapter-http` package.
**Effort:** 2d

---

### A-14: `pipeline-runtime.ts` statically imports Postgres and Redis store implementations
**Severity:** Medium
**File:** `packages/agent/src/pipeline/pipeline-runtime.ts:19-20`
**Pattern:** Static top-level imports of `PostgresPipelineCheckpointStore` and `RedisPipelineCheckpointStore` force every consumer to bundle both store adapters. `PipelineCheckpointStore` interface already exists in `@dzupagent/core`.
**Refactor guidance:** Remove static imports. Stores are passed via `config.checkpointStore`. Keep classes as named exports but do not instantiate them in the runtime.
**Effort:** 1d

---

### A-15: `@dzupagent/agent` public barrel exports 750+ symbols — internals leak
**Severity:** Medium
**File:** `packages/agent/src/index.ts:1`
**Pattern:** Root barrel exports 207 `export` statement lines including all 14 `SelfCorrection*` classes, `AgentPlayground`, `ReplayEngine`, `PipelineAnalytics`, etc. Consumers pull entire type surface for basic agent execution.
**Refactor guidance:** Move advanced exports to subpath entry points (`/self-correction`, `/replay`, `/playground`, `/pipeline-analytics`). Root barrel limited to ~60 core execution symbols.
**Effort:** 2d

---

### A-16: `ApprovalMode` / `ApprovalResult` redeclared in both packages
**Severity:** Medium
**Files:**
- `packages/agent/src/approval/approval-types.ts:4`
- `packages/agent-adapters/src/approval/adapter-approval.ts:52`
**Pattern:** Identical string literal types defined independently.
**Refactor guidance:** Define both in `@dzupagent/agent-types`. Both packages import from there.
**Effort:** 30m

---

### A-17: 55 bare `console.*` calls — no structured logger
**Severity:** Medium
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts:565,588,605,777,796`, `packages/agent-adapters/src/dzupagent/syncer.ts:610,615`, plus ~25 more across `packages/agent/src/`
**Pattern:** Production code uses raw `console.*` bypassing structured log levels and observability pipelines. `@datazup/logger` exists and is used at app layer.
**Refactor guidance:** Replace all production-path `console.*` with `createLogger` from `@datazup/logger`.
**Effort:** 1d

---

### A-18: `./workflow` subpath in `@dzupagent/agent` does not expose `PipelineRuntime`
**Severity:** Low
**File:** `packages/agent-adapters/src/workflow/adapter-workflow.ts:177-178`
**Pattern:** Consumers needing `PipelineRuntime` for `AdapterWorkflowBuilder` must import from the root barrel.
**Refactor guidance:** Add `"./pipeline"` subpath to `packages/agent/package.json`. Update import in `adapter-workflow.ts`.
**Effort:** 1h

---

### A-19: `DzupError` re-exported from two barrel files in same package
**Severity:** Low
**Files:** `packages/agent-adapters/src/utils/errors.ts:8`, `packages/agent-adapters/src/providers.ts:102`
**Pattern:** Same type re-exported twice from different subpath barrels.
**Refactor guidance:** Remove `DzupError` re-export from `providers.ts`.
**Effort:** 5m

---

### A-20: `MemoryProfile` / `MemoryProfilePreset` live in `@dzupagent/agent` instead of `@dzupagent/memory`
**Severity:** Low
**File:** `packages/agent/src/agent/memory-profiles.ts`
**Pattern:** Memory configuration presets for `@dzupagent/memory-ipc` exported from the orchestration-layer agent package. Forces `@dzupagent/agent` dependency for memory-only configuration.
**Refactor guidance:** Move to `@dzupagent/memory-ipc`. Re-export from `@dzupagent/agent` as backward-compat shim.
**Effort:** 1d

---

## Phased Implementation Prompts

### Phase 1 — Quick wins (≤2 days, no API breaks)

> Fix these items in `packages/agent` and `packages/agent-adapters`:
>
> 1. **A-16** — Canonicalize `ApprovalMode` and `ApprovalResult` in `@dzupagent/agent-types`. Remove from `packages/agent/src/approval/approval-types.ts` and `packages/agent-adapters/src/approval/adapter-approval.ts`.
> 2. **A-14** — Remove static imports of `PostgresPipelineCheckpointStore` and `RedisPipelineCheckpointStore` from `packages/agent/src/pipeline/pipeline-runtime.ts`. Runtime uses only injected `config.checkpointStore`.
> 3. **A-17** — Replace all production-path `console.*` in `packages/agent-adapters/src/codex/codex-adapter.ts` and `packages/agent-adapters/src/dzupagent/syncer.ts` with `@datazup/logger`.
> 4. **A-18** — Add `"./pipeline"` to `packages/agent/package.json` exports. Update `adapter-workflow.ts` import.
> 5. **A-19** — Remove duplicate `DzupError` re-export from `providers.ts`.
> 6. **A-04** — Delete `packages/agent-adapters/src/ucl/` (no production imports found). Remove from barrel.
>
> Run `yarn verify` after each. No public API changes.

### Phase 2 — Structural refactor (3–5 days)

> 1. **A-02** — Move `ProviderExecutionPort` + `ProviderExecutionResult` to `@dzupagent/adapter-types`. Shim re-export from `@dzupagent/agent`.
> 2. **A-05** — Extract `hashToolInput` to `@dzupagent/core`. Add `BaseStuckDetectorConfig` to `@dzupagent/agent-types`. Update both stuck detectors.
> 3. **A-12** — Create `BaseSdkAdapter` with shared lifecycle skeleton. `ClaudeAgentAdapter` and `CodexAdapter` extend it.
> 4. **A-10** — Extract `extractJsonFromText`, `buildZodPromptHint`, `repairJsonString` to `@dzupagent/core/src/structured/extract.ts`.

### Phase 3 — Major surgery (1–2 sprints, semver bump)

> 1. **A-01** — Introduce `PipelineExecutorPort` in `@dzupagent/core`. Wire DI into `AdapterWorkflowBuilder`.
> 2. **A-06** — Decompose `OrchestratorFacade` into composable pipeline steps (Policy, Approval, Guardrails, UCL). Target ≤300 LOC facade class.
> 3. **A-03** — Define generic base orchestration contracts in `@dzupagent/agent-types`. Both packages extend with concrete agent-handle types.
> 4. **A-15** — Restructure `@dzupagent/agent` public API into subpath exports. Root barrel limited to core execution surface.
