# AGENT-AUDIT: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03
**Packages:** `packages/agent`, `packages/agent-adapters`

## Score Summary

| Area | Score (1-5) | Key Gap |
|------|-------------|---------|
| Tool Loop | 5 | No tool *output* schema validation; no per-tool retry (only pipeline-level) |
| Memory | 4 | Decay/consolidation exists but not wired into agent loop; no `MemoryClient` IPC protocol |
| Context | 4 | `auto-compress.ts` is a 6-line shim; Anthropic `cache_control` never injected |
| Guardrails | 3 | No PII detection on prompts/memory; no LLM rate limiting; no prompt-injection scan on user input |
| Orchestration | 4 | Approval gate not durable across restart; no workflow `onError` edges; no orchestration-level stuck detection |
| LLM Integration | 4 | Cost rate table stale + ignores cached tokens; no streaming back-pressure |

---

## Findings

### AG-01: No tool-output schema validation
**Area:** Tool Loop
**Severity:** High
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:212-215`
**Current state:** Tool input is validated via `maybeValidateArgs`. The result is stringified directly. `ToolSchemaEntry.outputSchema` exists in `packages/agent/src/tools/tool-schema-registry.ts:19` but is never consulted.
**Gap:** A misbehaving or MCP tool returning malformed JSON silently poisons the conversation.
**Fix:** Add `output-validator.ts` policy stage between `transformToolResult` and `safetyMonitor.scanContent`. Use `tool.schema?.outputSchema` when present. On failure, return a structured error `ToolMessage`.
**Effort:** 4h

---

### AG-02: No per-tool retry/backoff in the tool loop
**Area:** Tool Loop
**Severity:** Medium
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:194-211`
**Current state:** Failed tool invocation is wrapped in an error `ToolMessage` in a single shot. Retry logic exists at pipeline node level (`pipeline/retry-policy.ts`) and provider level, but never at tool-execution level.
**Gap:** The LLM must "see" a transient error and retry on its own, wasting an LLM turn each time.
**Fix:** Add `ToolRetryPolicy` reusing `calculateBackoff` + `isRetryable` from `pipeline/retry-policy.ts`. Wire via `config.toolRetryPolicies?: Record<string, RetryPolicy>`.
**Effort:** 4-6h

---

### AG-03: `tools/create-tool.ts` is an 8-line stub
**Area:** Tool Loop
**Severity:** Medium
**File:** `packages/agent/src/tools/create-tool.ts:1-8`
**Current state:** Essentially empty. Tool authoring relies on raw LangChain `StructuredTool`/`tool()` factory, then manual `DynamicToolRegistry.register()`.
**Gap:** No typed factory that bundles schema, lifecycle policy, and registry wiring in one call.
**Fix:** Implement `createTool<I, O>({ name, description, inputSchema, outputSchema?, run, retry?, timeoutMs?, owner?, scope?, requiresApproval? })`. Re-export from `agent/index.ts`.
**Effort:** 3h

---

### AG-04: Tool argument validator re-implements JSON Schema subset manually
**Area:** Tool Loop
**Severity:** Medium
**File:** `packages/agent/src/agent/tool-arg-validator.ts:27-145`
**Current state:** Hand-rolled validator knows only `type`, `default`, `items.type`, `enum`. No support for `oneOf`, `anyOf`, `pattern`, `format`, `minimum/maximum`, nested objects, `$ref`.
**Gap:** MCP-bridged tool schemas routinely use `oneOf`, `format: "uri"`, regex `pattern`. Validator silently passes malformed args through.
**Fix:** Replace internals with `ajv` (already a transitive dep) using `addFormats`. Keep `autoRepair` API via AJV error post-processing.
**Effort:** 6h

---

### AG-05: OTel tracing disconnected between tool loop and adapter spawns
**Area:** Tool Loop
**Severity:** Low
**File:** `packages/agent/src/agent/tool-loop.ts:354-370`, `packages/agent-adapters/src/observability/adapter-tracer.ts`
**Current state:** The tool loop accepts a structural `ToolLoopTracer`; adapter tracer lives in a parallel pipeline. Two disconnected trace trees.
**Gap:** Consumer using both must manually correlate tool-loop spans with adapter spans.
**Fix:** Ship a `@dzupagent/otel` bridge that emits a single root span per `runId`, with `tool-loop.startToolSpan` creating a child of the active adapter span.
**Effort:** 6h

---

### AG-06: Memory IPC is a side-package dynamic import — no first-class `MemoryClient` contract
**Area:** Memory
**Severity:** High
**File:** `packages/agent/src/agent/memory-context-loader.ts:98-100`
**Current state:** `loadArrowRuntime` does `await import('@dzupagent/memory-ipc')` and structurally casts to `ArrowMemoryRuntime`. No IPC protocol surface in `@dzupagent/agent`.
**Gap:** No `MemoryClient` interface supporting in-process, out-of-process, or HTTP memory backends. The `MemoryClaim` contract called out in the project memory brainstorm plan does not yet exist.
**Fix:** Define `MemoryClient` interface in `@dzupagent/agent-types`. Provide `InMemoryMemoryClient` (default), `IpcMemoryClient` (Arrow), `HttpMemoryClient` (future server). Agent consumes `MemoryClient`, not `MemoryServiceLike`.
**Effort:** 12h

---

### AG-07: Memory decay engine exists but is not wired into the agent loop
**Area:** Memory
**Severity:** Medium
**File:** `packages/agent/src/agent/memory-context-loader.ts:185-201`, `packages/memory/src/decay-engine.ts:38-97`
**Current state:** `decay-engine.ts` implements Ebbinghaus-style decay. `memory-context-loader.ts` calls `memory.get()` and never invokes `MemoryDecayEngine.scoreMemoriesForRetrieval` or `MemoryConsolidator.consolidate`.
**Gap:** Agents do not benefit from existing decay/consolidation infrastructure. Memory budget is sliced by token count, not by decay strength + relevance.
**Fix:** Add optional `memoryRanker?` to `AgentMemoryContextLoaderConfig`, defaulting to `decayEngine.scoreMemoriesForRetrieval`. Trigger background consolidation in `agent-finalizers.maybeWriteBackMemory` above a record-count threshold.
**Effort:** 6h

---

### AG-08: Memory write-back lacks PII scrubbing
**Area:** Memory / Guardrails
**Severity:** High
**File:** `packages/agent/src/agent/agent-finalizers.ts` (referenced from `dzip-agent.ts:787-794`)
**Current state:** `maybeWriteBackMemory` writes final content to memory. `memory-sanitizer.ts` exists in `@dzupagent/memory` but is not invoked. The only PII-style filter (`replay/trace-serializer.ts:135`) fires only at trace-export time.
**Gap:** An agent processing SSN, credit card, or API key writes it verbatim into long-term memory.
**Fix:** Define `MemorySanitizer` interface in `agent-types`. Wire `config.memorySanitizer ?? memorySanitizer.default()` into `agent-finalizers.maybeWriteBackMemory` and into the user-prompt path before memory retrieval.
**Effort:** 4h

---

### AG-09: No prompt-injection scanning on user input or tool output
**Area:** Guardrails
**Severity:** High
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:217-288`
**Current state:** `safetyMonitor.scanContent` is invoked on tool results with `source: 'tool:result'`. NOT called on user prompts before LLM invocation. `content-sanitizer.ts:21-47` strips HTML/JS but is XSS-prevention for UI rendering, not prompt-injection defense.
**Gap:** OWASP LLM-01 (prompt injection). Standard defense: scan tool output, web-fetched content, AND user input for instruction-redirect markers.
**Fix:** Extend `SafetyMonitor.scanContent` to fire on every `HumanMessage` in `run-engine.prepareRunState`. Add `webFetchScanner` for tools tagged `network: true`. Ship default `PromptInjectionDetector` with regex + classifier.
**Effort:** 8h

---

### AG-10: No global LLM rate limiting
**Area:** Guardrails
**Severity:** Medium
**File:** `packages/agent/src/agent/dzip-agent.ts:709-727`, `packages/agent/src/mailbox/rate-limiter.ts`
**Current state:** Only rate limiter is for mailbox (per-sender quota). `dzip-agent.invokeModel` has no rate-limit guard. `IterationBudget` enforces cumulative caps but not RPM/TPM.
**Gap:** Anthropic and OpenAI enforce RPM/TPM quotas. Without client-side limiting, bursty multi-agent runs trigger 429s and burn the circuit breaker.
**Fix:** Add `RateLimit` interface to `agent-types`. Default `TokenBucketRateLimit({rpm, tpm})` in `@dzupagent/core`. Wire into `dzip-agent.invokeModel` before the middleware pipeline.
**Effort:** 6h

---

### AG-11: Cost-tracking rate table is hard-coded and stale
**Area:** Guardrails / LLM Integration
**Severity:** Medium
**File:** `packages/agent-adapters/src/middleware/cost-tracking.ts:27-37`
**Current state:** `PROVIDER_RATES` collapses all Claude models into one row. Cached-input pricing missing. As of 2026 rates for Sonnet 4.6/Opus 4.7 differ from the table.
**Gap:** Cost reports are systematically wrong. `usage.cachedTokens` is ignored.
**Fix:** Move pricing to `@dzupagent/core/pricing` keyed by `(provider, modelId)` with `input`, `output`, `cachedInput`, `cacheWrite` rates + `validUntil` date. CI test fails when any rate is >90 days old.
**Effort:** 4h

---

### AG-12: Anthropic prompt caching mentioned but never implemented
**Area:** Context
**Severity:** High
**File:** `packages/agent/src/agent/memory-context-loader.ts:88-126`
**Current state:** `FrozenSnapshot` caches the string result of memory loading. No LangChain message ever gets `cache_control: { type: 'ephemeral' }`. The "frozen snapshot" provides zero provider-side caching.
**Gap:** Without `cache_control` markers, callers never get the 10× discount on cached tokens.
**Fix:** Build `PromptCacheMiddleware` in `@dzupagent/context` that, for Anthropic models, stamps `cache_control: { type: 'ephemeral' }` on the first three stable system message blocks. Surface `cache_creation_input_tokens` and `cache_read_input_tokens` through `extractTokenUsage`.
**Effort:** 8h

---

### AG-13: `auto-compress.ts` is a 6-line re-export shim
**Area:** Context
**Severity:** Low
**File:** `packages/agent/src/context/auto-compress.ts:1-6`
**Current state:** Entire content is `export { autoCompress, FrozenSnapshot } from '@dzupagent/context'`.
**Gap:** Pollutes directory listing without adding value.
**Fix:** Delete the file. Migrate 5-7 internal imports to `from '@dzupagent/context'`.
**Effort:** 1h

---

### AG-14: Stuck detector is purely syntactic — no semantic plateau detection
**Area:** Orchestration / Guardrails
**Severity:** Medium
**File:** `packages/agent/src/guardrails/stuck-detector.ts:53-110`
**Current state:** Repeat-call detector uses SHA-256 of stringified args. Trailing-space difference bypasses detection. No content-similarity check across AIMessage turns.
**Gap:** Agent calling `editFile({content:'X '})` (trailing space) vs `editFile({content:'X'})` is not detected as stuck.
**Fix:** Add `RegressDetector` that hashes AIMessage content across last K turns and flags stuck when edit-distance < 0.05. Pluggable via `StuckDetectorConfig.contentSimilarity?: { threshold, window }`.
**Effort:** 4h

---

### AG-15: Approval gate not durable across process restart
**Area:** Orchestration
**Severity:** High
**File:** `packages/agent/src/approval/approval-gate.ts:147-160`
**Current state:** `waitForApproval` blocks on a Promise resolved by EventBus. Timeout uses `setTimeout`. If process crashes between `approval:requested` and `approval:granted`, wait-state is lost.
**Gap:** Production agents must survive deploys. LangGraph uses `interrupt()` + checkpointer for durable suspend/resume.
**Fix:** When `config.durableResume`, persist approval-pending state to `PipelineCheckpointStore`. Replace in-memory Promise with resume-token model: `requestApproval` writes `pending` to store, throws `ApprovalSuspendedError`. Resume path looks up token.
**Effort:** 10h

---

### AG-16: No streaming back-pressure or chunk re-assembly
**Area:** LLM Integration / Streaming
**Severity:** Medium
**File:** `packages/agent/src/streaming/streaming-run-handle.ts`, `packages/agent/src/streaming/text-delta-buffer.ts`
**Current state:** `streamRun` yields adapter events directly. No flow-control. Slow consumer buffers unboundedly.
**Gap:** Production SSE streams use bounded buffers with `highWaterMark`.
**Fix:** Wrap iteration in `text-delta-buffer.ts` with a bounded queue (default `highWaterMark: 256` deltas). On overflow: coalesce, throttle, or drop based on `config.streamingBackpressureStrategy`. Emit `stream:backpressure` events.
**Effort:** 6h

---

### AG-17: Structured-output extractor uses heuristic JSON repair
**Area:** LLM Integration
**Severity:** Medium
**File:** `packages/agent/src/agent/structured-generate.ts:285-310`
**Current state:** Falls back to substring slicing + `JSON.parse`. On failure, re-prompts LLM.
**Gap:** `partial-json`, `json-repair` handle truncated streams, single quotes, trailing commas. Current impl burns an extra LLM turn for any of these.
**Fix:** Add `json-repair` as a dep (or in-house impl in `@dzupagent/core`). Try repair before re-prompting.
**Effort:** 3h

---

### AG-18: Recovery strategy ignores per-provider cost budget state
**Area:** Orchestration / LLM Integration
**Severity:** Low
**File:** `packages/agent-adapters/src/recovery/recovery-strategy.ts`
**Current state:** `selectRecoveryStrategy` picks `retry-different-provider` without consulting `CostTrackingMiddleware` state. An over-budget provider can be selected as fallback.
**Gap:** Budget-exhausted provider should never be the first fallback target.
**Fix:** Inject `costTracking?: CostTrackingMiddleware` into `RecoveryConfig`. Filter over-budget providers in `selectRecoveryStrategy`.
**Effort:** 3h

---

### AG-19: Provider failover blocked after tool calls with no idempotent override
**Area:** LLM Integration
**Severity:** Low (intentional but under-documented)
**File:** `packages/agent/src/agent/dzip-agent.ts:226-229`
**Current state:** Failover blocked after tool results unless `allowRetryAfterToolResults: true`. No per-tool `idempotent` declaration.
**Gap:** An Anthropic outage after a first idempotent tool call cannot be transparently failed over to OpenAI.
**Fix:** Add `idempotent?: boolean` to `RegisterOptions`. When all tools in conversation are idempotent, allow failover automatically.
**Effort:** 3h

---

### AG-20: `WorkflowBuilder` lacks failure-recovery edges
**Area:** Orchestration
**Severity:** Medium
**File:** `packages/agent/src/workflow/workflow-builder.ts:69-99`
**Current state:** Builder exposes `then`, `parallel`, `branch`, `suspend`. No `onError(handler)` or `compensate(step)`.
**Gap:** LangGraph supports `addConditionalEdges` keyed off error state. DzupAgent workflows have no declarative recovery path.
**Fix:** Add `onError(predicate, recoverySteps)` to builder. Compile to a `branch` node switching on `state._error?.retryable`.
**Effort:** 6h

---

### AG-21: No orchestration-level stuck detector
**Area:** Orchestration
**Severity:** Medium
**File:** `packages/agent/src/orchestration/orchestrator.ts:117-`
**Current state:** Per-agent `StuckDetector` in each invocation. No detection of "whole orchestration is stuck" (e.g., infinite specialist-bouncing in supervisor pattern).
**Gap:** Supervisor delegating A→B→A→B repeatedly is not caught — each agent only sees its own one-shot invocation.
**Fix:** Add `OrchestrationStuckDetector` tracking sequence of `(specialistId, hash(input))` across delegations. Trigger after 3 identical pairs.
**Effort:** 4h

---

### AG-22: `iteration-budget.ts` config mutation is unsafe
**Area:** Guardrails
**Severity:** Low
**File:** `packages/agent/src/guardrails/iteration-budget.ts:60-68`
**Current state:** `blockTool` mutates constructor-supplied `config.blockedTools` in place via cast. Frozen config would throw `TypeError`. Forked agents share same config object.
**Gap:** Parent budget config silently modified by child.
**Fix:** Move `blockedTools` to instance `private dynamicBlocks: Set<string>`. Keep `config.blockedTools` truly readonly.
**Effort:** 1h

---

### AG-23: `scanFailureMode` defaults to `fail-open` — insecure default
**Area:** Guardrails
**Severity:** Low
**File:** `packages/agent/src/agent/tool-loop.ts:255-268`
**Current state:** `scanFailureMode: 'fail-open' | 'fail-closed'` defaults to `'fail-open'`. A crashed safety scanner silently lets tool output through.
**Gap:** Inverts "secure by default" principle.
**Fix:** Flip default to `'fail-closed'`. Add `presets/dev.ts` that opts back to `'fail-open'`. Add CHANGELOG entry.
**Effort:** 1h

---

### AG-24: Checkpoint shape recognition hardcoded in tool executor
**Area:** Tool Loop
**Severity:** Low
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:392-409`
**Current state:** `coerceResultToRecord` recognizes `{checkpointed, label}` and `{restored, label, reason}` shapes hardcoded. Layering violation: tool loop should not know checkpoint semantics.
**Gap:** Adding new checkpoint fields requires editing the tool executor.
**Fix:** Move to `@dzupagent/agent/snapshot/checkpoint-result-extractor.ts`. Subscribe to `tool:result` events and emit `checkpoint:created`/`checkpoint:restored`.
**Effort:** 2h

---

### AG-25: No CI enforcement of `agent-adapters` → `agent` layer boundary
**Area:** Architecture (cross-cutting)
**Severity:** Medium
**File:** Repo root — `turbo.json`, `package.json`
**Current state:** `check:domain-boundaries` script exists but no agent ↔ adapters direction check.
**Gap:** A regression PR could trivially introduce a circular dep between the two packages.
**Fix:** Add `check:layering` script using `dependency-cruiser` that fails on any `@dzupagent/agent` or `@dzupagent/codegen` import from `agent-adapters/src/**/*.ts`. Run in `yarn verify`.
**Effort:** 3h

---

## Implementation Prompts

### Quick wins (under 2h)

**Q1 — Flip safety scan to fail-closed (AG-23)**
> In `packages/agent/src/agent/tool-loop.ts`, change the default of `scanFailureMode` from `fail-open` to `fail-closed`. Update resolution in `policy-enabled-tool-executor.ts:217-288`. Add CHANGELOG entry under `### Breaking`. Update tests in `__tests__/stream-tool-guardrail-parity.test.ts`.
> **Validation:** `yarn test --filter=@dzupagent/agent -- guardrail` passes.

**Q2 — Fix IterationBudget immutability (AG-22)**
> In `packages/agent/src/guardrails/iteration-budget.ts`, replace in-place mutation of `config.blockedTools` with `private dynamicBlocks: Set<string>`. Update `isToolBlocked` to union both. Update `fork()` to share the `dynamicBlocks` reference.
> **Validation:** `yarn test --filter=@dzupagent/agent -- iteration-budget` passes.

**Q3 — Delete `auto-compress.ts` shim (AG-13)**
> Delete `packages/agent/src/context/auto-compress.ts`. Rewrite imports to `from '@dzupagent/context'`. Run `yarn typecheck --filter=@dzupagent/agent`.
> **Validation:** `yarn typecheck` passes with 0 errors.

### Refactors (4-8h)

**R1 — Tool output schema validation (AG-01)**
> Create `packages/agent/src/agent/tool-loop/output-validator.ts`. Wire into `policy-enabled-tool-executor.ts` between lines 215 and 217. Add `validateToolResults?: boolean | ToolArgValidatorConfig` to `ToolLoopConfig`. On failure emit `tool:error` with `errorCode: 'OUTPUT_VALIDATION_FAILED'`.
> **Validation:** `yarn test --filter=@dzupagent/agent -- tool-loop-canonical-audit` passes.

**R2 — Per-tool retry with backoff (AG-02)**
> Add `ToolRetryPolicy` re-exporting `RetryPolicy` from `pipeline/retry-policy.ts`. Wrap `invokeWithOptionalTimeout` in retry loop in `policy-enabled-tool-executor.ts`. Emit `tool:retry` events.
> **Validation:** Simulate transient 429 from fake tool; assert exactly N attempts.

**R3 — Memory decay-aware retrieval (AG-07)**
> Add optional `memoryRanker?` to `AgentMemoryContextLoaderConfig` defaulting to `decayEngine.scoreMemoriesForRetrieval`. Apply ranker before budget bound in `loadStandardMemoryContext`. Trigger `MemoryConsolidator.consolidate` in `agent-finalizers.ts` above `config.memoryConsolidationThreshold ?? 200`.
> **Validation:** `yarn test --filter=@dzupagent/agent -- memory-context-loader` passes.

**R4 — LLM rate limiting (AG-10)**
> Define `RateLimit` interface in `@dzupagent/agent-types`. Implement `TokenBucketRateLimit` in `@dzupagent/core`. Wire into `dzip-agent.ts:invokeModel` before middleware pipeline.
> **Validation:** Simulate paced calls; assert wall-clock spacing matches RPM config.

**R5 — Anthropic prompt-cache injection (AG-12)**
> Create `@dzupagent/context/prompt-cache-injector.ts`. For `claude-*` models, stamp `cache_control: {type:'ephemeral'}` on stable system message blocks > min-token threshold. Update `extractTokenUsage` to surface cache token counts.
> **Validation:** Sonnet invocation with >1024-token system prompt sees cache_control markers; non-Anthropic passes through unchanged.

### Major changes (16h+)

**M1 — First-class `MemoryClient` interface (AG-06)**
> Write ADR. Define `MemoryClient` in `@dzupagent/agent-types`. Implement `InMemoryMemoryClient`, `IpcMemoryClient`, `HttpMemoryClient`. Refactor `AgentMemoryContextLoader` to consume `MemoryClient`. Provide backwards-compat `memoryServiceToClient(svc)` adapter. Add boundary test: `@dzupagent/agent` must not import `@dzupagent/memory` or `@dzupagent/memory-ipc` directly.

**M2 — Durable approval gates + workflow recovery edges (AG-15 + AG-20)**
> Re-architect `ApprovalGate` to be checkpointer-backed via `ApprovalSuspendedError` + resume-token model. Add `.onError(predicate, recoveryNodes)` to `WorkflowBuilder`. Integration test: process-restart simulation with approval-rejected → workflow onError → recovery → success.

**M3 — OWASP-grade prompt-injection defense (AG-09 + AG-08)**
> Build `@dzupagent/security` package with `PromptInjectionDetector` (regex + classifier), `PIIDetector`, and `ContentScanner`. Wire into `run-engine.prepareRunState`, `agent-finalizers.maybeWriteBackMemory`, and `policy-enabled-tool-executor` for network tools. Ship 50+ fixture tests from curated injection corpus.
