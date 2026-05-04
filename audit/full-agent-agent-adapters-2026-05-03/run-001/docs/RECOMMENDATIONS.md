# RECOMMENDATIONS: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03 | **Run:** run-001

Sorted by: Critical → High → Medium → Low, then by effort (quick first).

---

### REC-01: Fix `DzupEvent` discriminated union to dissolve `as never` casts
**Domain:** Code
**Severity:** Critical
**Phase:** quick
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/core/src/event-bus.ts`, `packages/agent/src/agent/dzip-agent.ts`
**Why:** Every `DzupEventBus.emit()` in agent core uses unsafe casts to bypass the union type, meaning callers can pass mismatched event shapes silently.
**Fix:** Add missing optional fields (`output?`, `errorMessage?`, `status?`) to the relevant `DzupEvent` union members in `@dzupagent/core`. All `as never`/`as unknown as X` casts dissolve.
**Acceptance:** `grep -r "as never\|as unknown as" packages/agent/src/ --include="*.ts"` returns 0 results. Typecheck passes.

---

### REC-02: Fix floating Promise in agent-finalizers journal write
**Domain:** Code
**Severity:** Critical
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/agent-finalizers.ts`
**Why:** Unawaited journal write silently discards errors, making memory persistence unreliable with no observable signal.
**Fix:** `await journal.write(...)` and emit `agent:error` on failure.
**Acceptance:** Test asserts error event emitted on write failure. No floating promises.

---

### REC-03: Fix `approval:requested` missing `runId` in payload
**Domain:** Code
**Severity:** Critical (behavioral bug)
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/approval/approval-gate.ts:147`
**Why:** `AdapterApprovalHandler` receives events without `runId`, silently failing to correlate approval responses.
**Fix:** Add `runId` and `requestedAt: Date.now()` to the emitted event.
**Acceptance:** Approval gate tests pass. `AdapterApprovalHandler` receives `runId` correctly.

---

### REC-04: Add prompt-injection scanning on user input
**Domain:** Agent
**Severity:** High
**Phase:** major
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/run-engine.ts` (prepareRunState), `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:217`
**Why:** OWASP LLM-01. Safety scanner is only applied to tool results, not to user prompts. A malicious prompt can redirect the agent.
**Fix:** Extend `SafetyMonitor.scanContent` to fire on every `HumanMessage`. Build `@dzupagent/security` with `PromptInjectionDetector`. Wire for network tools too.
**Acceptance:** 50+ fixture tests from known-bad injection corpus pass. `config.security.promptInjection: 'block'` is the production default.

---

### REC-05: Make approval gate durable across process restart
**Domain:** Agent
**Severity:** High
**Phase:** major
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/approval/approval-gate.ts:147`
**Why:** `setTimeout`-based approval wait is lost on process crash/deploy. Production agents must survive restarts.
**Fix:** Persist approval-pending state to `PipelineCheckpointStore` when `config.durableResume`. Throw `ApprovalSuspendedError` with resume token. Resume path loads checkpoint.
**Acceptance:** Integration test: process restart simulation, approval-rejected → workflow `onError` → recovery → success.

---

### REC-06: Implement Anthropic prompt caching
**Domain:** Agent
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/memory-context-loader.ts:88`, `packages/context/src/` (new file)
**Why:** `FrozenSnapshot` provides zero provider-side caching. Callers never get the 10× discount on cached tokens.
**Fix:** Build `PromptCacheMiddleware` that stamps `cache_control: {type:'ephemeral'}` on stable system blocks for Anthropic models. Surface cache token counts in `extractTokenUsage`.
**Acceptance:** Sonnet invocation with >1024-token system prompt has `cache_control` markers. Non-Anthropic models unaffected. Cache token metrics visible in cost tracking.

---

### REC-07: Add PII scrubbing to memory write-back
**Domain:** Agent
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/agent-finalizers.ts`
**Why:** Agents processing sensitive data (SSNs, API keys, credit cards) write it verbatim into long-term memory. `memory-sanitizer.ts` exists but is never called.
**Fix:** Wire `config.memorySanitizer ?? memorySanitizer.default()` into `maybeWriteBackMemory` and user-prompt path.
**Acceptance:** Test: agent given SSN in prompt; memory record contains `[REDACTED]` not the raw SSN.

---

### REC-08: Add tool-output schema validation
**Domain:** Agent
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:212`
**Why:** `ToolSchemaEntry.outputSchema` is declared but never consulted. Misbehaving MCP tools can poison the conversation silently.
**Fix:** Create `output-validator.ts` stage wired between `transformToolResult` and safety scan.
**Acceptance:** Tool returning mismatched output emits `tool:error` with `OUTPUT_VALIDATION_FAILED`. Existing tool loop tests pass.

---

### REC-09: Delete `ucl/` subdirectory (dead code + duplicate parser)
**Domain:** Architecture
**Severity:** High
**Phase:** quick
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/ucl/` (entire directory)
**Why:** 497 LOC of duplicated frontmatter parser + loader. No production code imports from `ucl/`. The `dzupagent/` subdirectory supersedes it entirely.
**Fix:** Verify no production imports (`grep -r "from.*ucl/"` = 0), then delete. Remove from barrel.
**Acceptance:** `yarn build --filter=@dzupagent/agent-adapters` passes. 0 references to `ucl/` in production code.

---

### REC-10: Flip `scanFailureMode` default to `fail-closed`
**Domain:** Agent
**Severity:** High (security posture)
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/tool-loop.ts:255`
**Why:** Current `fail-open` default means a crashed safety scanner silently passes tool output through. Inverts "secure by default".
**Fix:** Change default to `fail-closed`. Add `presets/dev.ts` opt-out. CHANGELOG entry.
**Acceptance:** Safety scanner crash triggers `tool:blocked` not silent pass-through. Dev preset allows fail-open.

---

### REC-11: Fix `IterationBudget` config mutation safety
**Domain:** Agent
**Severity:** High (correctness)
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/guardrails/iteration-budget.ts:60`
**Why:** In-place mutation of `config.blockedTools` throws `TypeError` on frozen configs; forks silently share parent state.
**Fix:** `private dynamicBlocks: Set<string>` instance field. Keep `config.blockedTools` readonly.
**Acceptance:** Frozen config does not throw. Fork does not affect parent block list.

---

### REC-12: Add first-class `MemoryClient` IPC contract
**Domain:** Agent
**Severity:** High
**Phase:** major
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/agent/src/agent/memory-context-loader.ts:98`, `packages/agent-types/src/` (new interface)
**Why:** Dynamic import + structural cast to `ArrowMemoryRuntime` with no protocol contract means multi-process memory sharing is fragile and untestable.
**Fix:** Define `MemoryClient` interface in `@dzupagent/agent-types`. Provide `InMemoryMemoryClient`, `IpcMemoryClient`, `HttpMemoryClient`. Backwards-compat `memoryServiceToClient` adapter.
**Acceptance:** `@dzupagent/agent` imports neither `@dzupagent/memory` nor `@dzupagent/memory-ipc` directly (boundary test).

---

### REC-13: Extract `executeStreamingToolCall` into testable helpers
**Domain:** Code
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/run-engine.ts:523–919`
**Why:** 396-line function with 7-level nesting and no direct unit tests is the highest-risk untested function in the codebase.
**Fix:** Extract `accumulateStreamChunks`, `dispatchToolResults`, `handleStreamAbort`. Outer function ≤100 LOC.
**Acceptance:** Each helper has its own test file. `wc -l run-engine.ts` shows reduction of ~300 lines.

---

### REC-14: Deduplicate `executeWithRecovery` + `executeWithRecoveryStream`
**Domain:** Code
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:1`
**Why:** 441+449 LOC near-duplicate methods. Any bug fix must be applied twice.
**Fix:** Extract `executeWithRecoveryCore<T>`. Both methods delegate to it.
**Acceptance:** `adapter-recovery.ts` is ≤500 LOC. All recovery tests pass.

---

### REC-15: Canonicalize `ProviderExecutionPort` types in `@dzupagent/adapter-types`
**Domain:** Architecture
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/agent-adapters/src/integration/provider-execution-port.ts:10`
**Why:** Pure interface types defined in `@dzupagent/agent` create unnecessary build coupling. Any agent change forces adapter-types rebuild.
**Fix:** Move to `@dzupagent/adapter-types`. Shim re-export from `@dzupagent/agent`.
**Acceptance:** `packages/agent-adapters` no longer imports `ProviderExecutionPort` from `@dzupagent/agent`.

---

### REC-16: Extract shared hash utility + `BaseStuckDetectorConfig`
**Domain:** Architecture
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/agent/src/guardrails/stuck-detector.ts:29`, `packages/agent-adapters/src/guardrails/adapter-guardrails.ts:101`
**Why:** Byte-for-byte duplicate `hashInput` function (SHA-256 of stringified input) in both packages.
**Fix:** `@dzupagent/core/src/utils/hash.ts` exports `hashToolInput`. Both detectors import it. `BaseStuckDetectorConfig` in `@dzupagent/agent-types`.
**Acceptance:** `grep -r "sha256\|hashInput" packages/agent/src packages/agent-adapters/src --include="*.ts"` has exactly 0 definition sites (only import sites).

---

### REC-17: Annotate `TeamRuntime` as `@experimental` + extract model constants
**Domain:** Architecture + Code
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/orchestration/team/team-runtime.ts:22`
**Why:** 1,281-line file shipped as tier-1 public API with stub LLM invocations. Consumers cannot distinguish implemented from placeholder.
**Fix:** Add `@experimental` JSDoc. Extract `TeamRuntimeDefaults` config. Split file.
**Acceptance:** `TeamRuntime` has `@experimental` tag. File split to ≤400 LOC per file.

---

### REC-18: Decompose `AdapterRecoveryCopilot` god object
**Domain:** Architecture + Code
**Severity:** High
**Phase:** major
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:1` (1,250 LOC)
**Why:** Owns 6 unrelated concerns. `setInterval` in constructor leaks if `dispose()` not called.
**Fix:** Extract `ExecutionTraceStore` (injectable) + `RecoveryLoopRunner`. Coordinator ≤200 LOC.
**Acceptance:** `AdapterRecoveryCopilot` is ≤200 LOC. `ExecutionTraceStore` has its own tests.

---

### REC-19: Canonicalize `MemoryServiceLike` in `@dzupagent/adapter-types`
**Domain:** Architecture
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/agent-adapters/src/middleware/memory-enrichment.ts:36` (+ 3 other locations)
**Why:** 4 independent definitions risk silent divergence when any one adds a required method.
**Fix:** Single definition in `@dzupagent/adapter-types`. All 4 files import from there.
**Acceptance:** `grep -rn "interface MemoryServiceLike" packages/ --include="*.ts"` returns 1 result.

---

### REC-20: Add unit tests for `policy-enabled-tool-executor.ts`
**Domain:** Code
**Severity:** High
**Phase:** refactor
**Expert Agent:** `dzupagent-test-dev`
**Files:** `packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts` (create)
**Why:** Central tool enforcement function (337 LOC) with zero dedicated unit tests is the highest risk coverage gap.
**Fix:** Tests covering: policy deny, approval required, safety fail-closed, checkpoint event emission.
**Acceptance:** 100% branch coverage on `policy-enabled-tool-executor.ts`.

---

### REC-21: Add per-tool retry with exponential backoff
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:194`
**Why:** LLM wastes a full turn "seeing" each transient tool error. Retry logic exists at other layers but not at tool invocation level.
**Fix:** Wrap `invokeWithOptionalTimeout` in retry loop using existing `calculateBackoff` + `isRetryable`. Emit `tool:retry` events.
**Acceptance:** Simulated transient 429 from fake tool retries exactly N times before surfacing failure.

---

### REC-22: Wire memory decay/consolidation into agent loop
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/memory-context-loader.ts:185`
**Why:** `decay-engine.ts` and `memory-consolidation.ts` exist but are never called. Memory budget is token-only, ignoring relevance.
**Fix:** Optional `memoryRanker?` defaulting to decay engine. Background consolidation trigger in finalizers.
**Acceptance:** Memory records loaded with decay scoring. Consolidation triggered at threshold.

---

### REC-23: Fix stale cost rate table + add cached-token accounting
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent-adapters/src/middleware/cost-tracking.ts:27`
**Why:** All Claude models collapse to one rate. Cached-input tokens ignored. Cost reports are systematically wrong.
**Fix:** Move to `@dzupagent/core/pricing` keyed by `(provider, modelId)` with `input`, `output`, `cachedInput`, `cacheWrite` rates + `validUntil`. CI test fails when any rate >90 days old.
**Acceptance:** `estimateCost` uses cached-input rate for `usage.cached`. CI fails on stale rates.

---

### REC-24: Add `WorkflowBuilder.onError()` failure-recovery edges
**Domain:** Agent
**Severity:** Medium
**Phase:** major
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/workflow/workflow-builder.ts:69`
**Why:** Failed workflow nodes have no declarative recovery path. Callers must implement try/catch wrappers.
**Fix:** `.onError(predicate, recoverySteps)` compiles to a conditional edge on `state._error`.
**Acceptance:** Workflow with `onError` handles node failure and reaches recovery node. Integration test passes.

---

### REC-25: Add orchestration-level stuck detector
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/orchestration/orchestrator.ts:117`
**Why:** Per-agent `StuckDetector` cannot catch infinite specialist-bouncing (A→B→A→B) in supervisor pattern.
**Fix:** `OrchestrationStuckDetector` tracking `(specialistId, hash(input))` sequence. Trigger after 3 identical pairs.
**Acceptance:** Supervisor test with infinite bounce is detected and terminated within 10 iterations.

---

### REC-26: Add LLM rate limiting
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/dzip-agent.ts:709`
**Why:** Bursty multi-agent runs trigger provider 429s and burn the circuit breaker unnecessarily.
**Fix:** `RateLimit` interface + `TokenBucketRateLimit` implementation. Wire before middleware pipeline.
**Acceptance:** Multi-agent test with RPM=2 spaces calls at least 30s apart.

---

### REC-27: Add `max-concurrency` guard to `AgentOrchestrator.parallel`
**Domain:** Code
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/orchestration/orchestrator.ts`
**Why:** `Promise.all(agents.map(...))` spawns unbounded LLM calls simultaneously.
**Fix:** `maxConcurrency?: number` on `ParallelConfig`. Default `Math.min(agents.length, 5)`. p-limit style queue.
**Acceptance:** 20-agent parallel call with `maxConcurrency: 3` shows at most 3 in-flight at any time.

---

### REC-28: Add structured-output max-repair-attempts guard
**Domain:** Code
**Severity:** Medium
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/structured-generate.ts:285`
**Why:** Persistent LLM returning malformed JSON loops until `IterationBudget` fires. Explicit cap is cleaner.
**Fix:** `maxRepairAttempts?: number` (default 2). Throw `StructuredOutputMaxAttemptsError` when exceeded.
**Acceptance:** LLM returning malformed JSON 3× throws `StructuredOutputMaxAttemptsError` after 2 attempts.

---

### REC-29: Add CI layering check for `agent-adapters → agent` boundary
**Domain:** Agent / Architecture
**Severity:** Medium
**Phase:** quick
**Expert Agent:** `dzupagent-test-dev`
**Files:** Repo root `package.json`/`turbo.json`
**Why:** No automated check prevents circular dep regression between these two packages.
**Fix:** `check:layering` script via `dependency-cruiser`. Fails on any `@dzupagent/agent` import from `agent-adapters/src/`.
**Acceptance:** `yarn check:layering` fails when test import of `@dzupagent/agent` is added to `agent-adapters/src/`.

---

### REC-30: Replace `console.*` with `@datazup/logger` in both packages
**Domain:** Architecture
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts:565`, `packages/agent-adapters/src/dzupagent/syncer.ts:610` + ~45 more
**Why:** 55 bare `console.*` calls bypass structured observability. Framework packages should not emit to stdout/stderr directly.
**Fix:** Replace all production-path `console.*` with `createLogger` from `@datazup/logger`.
**Acceptance:** `grep -r "console\." packages/agent/src packages/agent-adapters/src --include="*.ts" | grep -v "test\|spec\|dry-run"` returns 0.

---

### REC-31: Canonicalize `ApprovalMode`/`ApprovalResult` in `@dzupagent/agent-types`
**Domain:** Architecture
**Severity:** Medium
**Phase:** quick
**Expert Agent:** `dzupagent-core-dev`
**Files:** `packages/agent/src/approval/approval-types.ts:4`, `packages/agent-adapters/src/approval/adapter-approval.ts:52`
**Why:** Identical string literal types in two packages risk silent divergence.
**Fix:** Define in `@dzupagent/agent-types`. Both packages import from there.
**Acceptance:** Only one definition of each type exists in the monorepo.

---

### REC-32: Remove static Postgres/Redis imports from `pipeline-runtime.ts`
**Domain:** Architecture
**Severity:** Medium
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/pipeline/pipeline-runtime.ts:19`
**Why:** Forces every `@dzupagent/agent` consumer to bundle both store adapters regardless of use.
**Fix:** Remove static imports. Runtime uses only injected `config.checkpointStore`. Keep classes as named exports.
**Acceptance:** `@dzupagent/agent` bundle no longer pulls `pg` or `ioredis` unless a store is explicitly imported.

---

### REC-33: Create `BaseSdkAdapter` abstract class
**Domain:** Architecture
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/base/base-sdk-adapter.ts` (create), `packages/agent-adapters/src/claude/claude-adapter.ts`, `packages/agent-adapters/src/codex/codex-adapter.ts`
**Why:** Both SDK adapters independently re-implement lifecycle events, `InteractionResolver` wiring, token accumulation, and abort controller management.
**Fix:** `BaseSdkAdapter` with shared lifecycle skeleton. Claude + Codex extend it.
**Acceptance:** Each adapter loses ~200 LOC of duplicated lifecycle code. Tests pass.

---

### REC-34: Add `json-repair` for structured output extraction
**Domain:** Agent
**Severity:** Medium
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/agent/structured-generate.ts:285`
**Why:** Current heuristic breaks on truncated streams, single quotes, trailing commas — burning an extra LLM turn each time.
**Fix:** `json-repair` (or in-house in `@dzupagent/core`). Try repair before re-prompting.
**Acceptance:** Single-quoted JSON parsed without LLM re-prompt. Trailing comma JSON parsed without LLM re-prompt.

---

### REC-35: Semantic plateau detection in stuck detector
**Domain:** Agent
**Severity:** Medium
**Phase:** refactor
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/guardrails/stuck-detector.ts:53`
**Why:** Trailing-space difference in tool args bypasses syntactic hash detection. No content-similarity check across AIMessage turns.
**Fix:** `RegressDetector` checking edit-distance on AIMessage content across last K turns. Pluggable via config.
**Acceptance:** Agent calling `editFile({content:'X '})` vs `editFile({content:'X'})` alternately is detected as stuck within 5 iterations.

---

### REC-36: Delete `auto-compress.ts` 6-line shim
**Domain:** Agent
**Severity:** Low
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/src/context/auto-compress.ts`
**Why:** Pollutes directory listing without adding value.
**Fix:** Delete. Migrate imports to `from '@dzupagent/context'`.
**Acceptance:** `yarn typecheck --filter=@dzupagent/agent` passes. File is gone.

---

### REC-37: Fix `OrchestratorFacade` into composable pipeline steps
**Domain:** Architecture
**Severity:** High
**Phase:** major
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/facade/orchestrator-facade.ts:251` (909 LOC)
**Why:** 9 unrelated concerns in one class. Every change touches the same file.
**Fix:** Extract `PolicyEnforcementPipeline`, `ApprovalPipelineStep`, `GuardrailsPipelineStep`, `UCLEnrichmentStep`. Facade ≤300 LOC.
**Acceptance:** Facade class body ≤300 LOC. Each step has its own test file.

---

### REC-38: Add `./pipeline` subpath export to `@dzupagent/agent`
**Domain:** Architecture
**Severity:** Low
**Phase:** quick
**Expert Agent:** `dzupagent-agent-dev`
**Files:** `packages/agent/package.json`
**Why:** Consumers needing `PipelineRuntime` must import from root barrel, pulling all 750+ symbols.
**Fix:** Add `"./pipeline"` to `package.json` exports map.
**Acceptance:** `import { PipelineRuntime } from '@dzupagent/agent/pipeline'` resolves without pulling root barrel.

---

### REC-39: Remove duplicate `DzupError` re-export from `providers.ts`
**Domain:** Architecture
**Severity:** Low
**Phase:** quick
**Expert Agent:** `dzupagent-connectors-dev`
**Files:** `packages/agent-adapters/src/providers.ts:102`
**Why:** Same type re-exported from two barrel files in the same package.
**Fix:** Remove from `providers.ts`. One export from `utils/errors.ts` is sufficient.
**Acceptance:** `grep -n "DzupError" packages/agent-adapters/src/providers.ts` returns 0 results.
