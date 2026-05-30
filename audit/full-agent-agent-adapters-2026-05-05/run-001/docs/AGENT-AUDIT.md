# Agent Pattern Audit — `@dzupagent/agent` + `@dzupagent/agent-adapters`

**Date:** 2026-05-05
**Context:** Follow-up to 2026-05-03 audit. MC sprint on 2026-05-04 addressed: security package (95 tests), MemoryClient interface, durable approvals, OrchestratorFacade 909→279 LOC, RecoveryCopilot, subpath exports.

---

## 1. TOOL LOOP — Quality 4/5

### Current state
- ReAct loop in `tool-loop.ts` orchestrates iterations; `policy-enabled-tool-executor.ts` (576 LOC) owns governance, validation, retry, timeout, scanning, telemetry, output validation
- Decomposed kernels exist: `model-turn-kernel.ts`, `tool-scheduler-kernel.ts`, `output-validator.ts`
- Per-tool retry with `calculateBackoff` (jitter, exponential); transient classification via `isTransientError`
- Per-tool timeout via `invokeWithOptionalTimeout`
- Stuck detection 3-stage escalation: block tool → nudge → abort, plus checkpoint recovery hook
- Argument validation against tool schema; output schema validation; safety-monitor scanning with fail-open/fail-closed
- OTel tracing on every tool call via `ToolLoopTracer`
- Iteration budget tracker with token/cost/iteration thresholds (70%/90% default)
- Token-lifecycle compression hook before halt check

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-001 | High | `policy-enabled-tool-executor.ts:148,353,398` and 11 other sites | 14 `as never` casts on `eventBus.emit({...} as never)` in tool-loop hot paths suppress union-narrowing. Carry-over from prior audit. |
| AGENT-002 | High | `tool-loop.ts:524-792` | 268-line monolithic `for` body in `runToolLoop` mixes hint injection, model invocation, compression, halt check, scheduling, stuck handling, escalation. Hard to test branches in isolation. |
| AGENT-003 | Medium | `policy-enabled-tool-executor.ts:282-299` | Retry sleep `setTimeout` adds an `abort` listener but never removes it on resolve — listener leak across many retries. |
| AGENT-004 | Medium | `policy-enabled-tool-executor.ts:226-303` | Retry loop swallows `tool:retry` telemetry because the canonical `DzupEvent` union forbids a `tool:retry` event. Either extend the union or use a dedicated structural callback. |
| AGENT-005 | Medium | `tool-scheduler-kernel.ts:128-160` | Parallel mode uses `Promise.allSettled` then re-throws the first thrown error; other settled tools' results are dropped. |
| AGENT-006 | Low | `tool-loop.ts:519-522,807-813` | Stuck-error reasoning relies on mutable `lastStuckToolName`/`lastStuckReason` strings that can be reset by intermediate iteration handling. |
| AGENT-007 | Low | `tool-arg-validator.ts:19-77` | Auto-repair widens the API contract (string→number coercion, single→array wrapping) with no signal to the LLM. Should emit a `tool:args:repaired` event. |
| AGENT-008 | Low | `tool-loop.ts:556-575` | Tool-stats hint injection scans `allMessages` from end-to-front O(n) per iteration. Quadratic with long histories. |

---

## 2. MEMORY — Quality 3/5

### Current state
- `memory-context-loader.ts` (>500 LOC) bridges `MemoryServiceLike` from `@dzupagent/memory-ipc` with the prepare-messages path; supports Arrow frames + standard fallback with phase-weighted selection
- Memory write-back finalizer scans for PII (`agent-finalizers.ts:140`), supports `pii: 'block'`/`'redact'`
- Memory failures are non-fatal; emit `agent:context_fallback` events
- Decay strength integration via `@dzupagent/memory.calculateStrength`
- Frozen-snapshot prompt-cache optimisation flag

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-010 | High | `team-runtime.ts:368-371` | `consolidateOnComplete` is declared in the team memory policy but **explicitly throws** — no consolidation runs after a team completes. Missing feature presented as supported. |
| AGENT-011 | High | n/a | No periodic working-memory pruning loop. Memory grows unbounded inside `MemoryServiceLike`; the agent never prunes by TTL or strength threshold. |
| AGENT-012 | Medium | `memory-context-loader.ts:43-51` | `STANDARD_MEMORY_MAX_ITEMS = 10`, `STANDARD_MEMORY_BUDGET_CONFIG.totalBudget = 128_000` are hardcoded; not tuneable per agent or per phase. |
| AGENT-013 | Medium | `agent-finalizers.ts:140-144` | PII detection runs only on the write-back path; does **not** scan tool results before they hit memory via consolidation hooks. |
| AGENT-014 | Low | `memory-context-loader.ts:19-26` | `ArrowRuntimeNotInjectedError` thrown synchronously when Arrow memory is configured without injector — swallowed by generic catch, hiding the configuration error. |

---

## 3. CONTEXT MANAGEMENT — Quality 3/5

### Current state
- `context/auto-compress.ts`, `context/token-lifecycle-integration.ts` deliver pressure-based compression hooked into the tool loop
- `PhaseAwareWindowManager` lazy-imported for retention-split semantics
- Token estimation via `estimateTokens` from `@dzupagent/core` (heuristic char/4)

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-020 | **Critical** | global | **No prompt caching in any adapter or LLM invocation path.** `claude-adapter.ts:632-693` builds query options without `cache_control` markers. 50-90% cost savings foregone. Carry-over from 2026-05-03 audit, still unimplemented. |
| AGENT-021 | High | `dzip-agent.ts:626-628` | Token estimation uses heuristic char/4; compression triggers and budget warnings are imprecise. |
| AGENT-022 | Medium | `tool-loop.ts:608-624` | Compression failure is silently swallowed; run continues with oversized context. Should emit `context:compression_failed`. |
| AGENT-023 | Medium | `agent/memory-context-loader.ts` | Frozen-snapshot prompt-cache optimisation has no built-in snapshot lifecycle (capture, version, invalidate). |

---

## 4. GUARDRAILS — Quality 3/5

### Current state
- `guardrails/iteration-budget.ts`: token/cost/iteration tracker with 70%/90% thresholds, fork semantics for child agents
- `guardrails/stuck-detector.ts`: 5-mode detection (repeated calls, error rate, idle iterations, progress-hash blocks, semantic plateau)
- `guardrails/cascading-timeout.ts`: timeout enforcement
- `agent-adapters/guardrails/adapter-guardrails.ts` (714 LOC): event-stream guardrails with budget, blocked tools, output filter, stuck wrapping
- Run-engine has prompt-injection scan modes (`block`/`warn`/`off`) using `ContentScanner`
- HTTP layer has `SlidingWindowRateLimiter`

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-030 | High | n/a | **No LLM-call audit logging** — no persistence of prompts, completions, model, usage, ts, runId. Compliance/audit trail gap. |
| AGENT-031 | High | `adapter-guardrails.ts`, `guardrails/stuck-detector.ts` | Two parallel implementations of stuck detection (agent has 5 modes; adapter has 3 modes — no progress-hash, no semantic plateau). Drift risk. |
| AGENT-032 | High | `agent-finalizers.ts`, `run-engine.ts:259-307` | PII/prompt-injection scanning is scoped to incoming HumanMessages and final write-back, but **not to tool results before they enter the LLM context**. |
| AGENT-033 | High | `dzip-agent.ts:719-733` | `rateLimiter.waitUntilAvailable` is per-agent in-memory only; no Redis-backed shared limiter for multi-instance deployments. |
| AGENT-034 | Medium | `adapter-guardrails.ts:700-712` | `looksLikeError` heuristic is ad-hoc string matching; should be a structured signal from adapters. |
| AGENT-035 | Medium | `iteration-budget.ts:60-68` | `blockTool` mutates the caller-passed `config` object via cast: `(this.config as { blockedTools: string[] }).blockedTools = []`. |
| AGENT-036 | Medium | `adapter-guardrails.ts` output-filter | Single async function; no pluggable filter chain for layered policies. |
| AGENT-037 | Low | `iteration-budget.ts:83-142` | Three near-identical threshold check blocks (tokens/cost/iterations). Extract to `checkMetric(name, current, limit)` helper. |

---

## 5. ORCHESTRATION — Quality 4/5

### Current state
- `orchestration/orchestrator.ts` (572 LOC): sequential, parallel, supervisor, debate, contract-net patterns
- Provider-adapter execution mode for supervisor with explicit fail-closed when port is missing
- Routing policies and merge strategies are pluggable: `routing/`, `merge/`, `contract-net/`, `team/`, `topology/`
- `parallel-executor.ts` semaphore; `runConcurrently` with `maxConcurrency` cap
- Circuit breaker per-specialist via `instrumentSpecialistTool`
- `team-runtime.ts` has supervision-policy, checkpointing, workspace, phases
- Approval gate is durable: persists `ApprovalPendingState` to checkpoint store, throws `ApprovalSuspendedError`, exposes `resume(runId, decision)` and `loadPending`
- `pipeline-runtime.ts` (1029 LOC): forks/joins, loops, gates, suspensions, checkpoints, retry policy, recovery hooks, iteration-budget tracker, OTel events

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-040 | High | `orchestrator.ts:480-501` | Supervisor builds `new DzupAgent({...})` on every call — re-pays init cost. Cache by manager+specialist-set. |
| AGENT-041 | High | `pipeline-runtime.ts` | 1029 LOC monolith. Branch-merge, edge-resolution, retry, checkpoint, error-classification all in one file despite helper modules existing in `pipeline-runtime/`. |
| AGENT-042 | High | `approval-gate.ts:104-107` | `notifyWebhook(...).catch(() => {})` swallows webhook delivery failures with no retry, no DLQ, no observability event. |
| AGENT-043 | Medium | `orchestrator.ts:103-114` | `instrumentSpecialistTool` mutates `tool.invoke` of a tool that may be shared across managers; thread-safety hazard with concurrent supervisors. |
| AGENT-044 | Medium | `orchestrator.ts:520-522` | `try { ... } catch (err) { throw err }` is a no-op catch — dead code. |
| AGENT-045 | Medium | `team-runtime.ts:368-371` | `consolidateOnComplete` policy field declared but throws — half-baked feature. |
| AGENT-046 | Medium | `pipeline-runtime.ts:99-110` | Auto-wires checkpoint store from Redis/PG/in-memory but does not verify the wired store on startup. Misconfigured Redis URL surfaces only on first `save()`. |
| AGENT-047 | Low | `approval-gate.ts:153-164` | `setTimeout` for timeout is not `unref`'d; keeps the event loop alive indefinitely in long-lived servers. |

---

## 6. LLM INTEGRATION (agent-adapters) — Quality 3.5/5

### Current state
- `ProviderAdapterRegistry` (750 LOC) with circuit breaker per adapter, fallback chain via `executeWithFallback`, terminal-completion gate, per-attempt timeout
- `OrchestratorFacade` (468 LOC, refactored from 909) cleanly composes registry + bridge + cost tracking + sessions + composable pipeline
- 9 adapters: Claude (716 LOC), Codex, OpenAI (387 LOC), OpenRouter, Gemini (CLI + SDK), Qwen, Goose, Crush
- Circuit breaker imported from `@dzupagent/core/advanced`
- `EventBusBridge` (238 LOC) translates adapter events into bus events
- Cost tracking middleware with `CostReport`
- OpenAI/OpenRouter use native fetch + SSE parsing (no SDK dependency)
- Recovery layer: `RecoveryPolicySelector` with default/research/codegen policies; `recovery-attempt-handler.ts` (658 LOC) tracks attempts, escalation, cross-provider handoff

### Findings

| ID | Severity | File:Line | Description |
|----|----------|-----------|-------------|
| AGENT-050 | **Critical** | `claude-adapter.ts:632-693` | **Prompt caching not implemented in Claude adapter.** Never sets `cache_control: 'ephemeral'`. 50-90% cost savings foregone. |
| AGENT-051 | High | `adapter-registry.ts:740-748` | `eventBus.emit(event as Parameters<DzupEventBus['emit']>[0])` — same `as never`-style union violation, laundered through a different name. Comment acknowledges it. |
| AGENT-052 | High | `claude-adapter.ts:444-485` | `interrupt()` installs a `process.once('unhandledRejection', ...)` handler. Process-level handler from per-instance method leaks; concurrent interrupts clobber each other. |
| AGENT-053 | High | `openai-adapter.ts:74-88` | `getCapabilities` declares `supportsToolCalls: false` — silent feature gap. OpenAI Chat Completions API supports tool calls; adapter just doesn't implement them. |
| AGENT-054 | High | `claude-adapter.ts:127-141` | `mapSandboxMode('workspace-write')` returns `'bypassPermissions'` — same as `'full-access'`. Sandbox semantics collapse: workspace-write should be scoped to cwd writes only. **Security-relevant defect.** |
| AGENT-055 | Medium | `openai-adapter.ts:308-318` | `resumeSession` throws unconditionally even though it's a generator — unreachable dead behaviour. |
| AGENT-056 | Medium | `adapter-registry.ts:251-466` | 215-line `executeWithFallback` method. Per-attempt block, timeout setup, and terminal-failure synthesis should be extracted into helpers. |
| AGENT-057 | Medium | `recovery-attempt-handler.ts` | 658 LOC monolith — same structural anti-pattern that `OrchestratorFacade` was just refactored away from. |
| AGENT-058 | Medium | `openrouter-adapter.ts`, `openai-adapter.ts` | SSE parser duplicated nearly verbatim across both adapters. |
| AGENT-059 | Medium | `recovery-policies.ts:65-103` | Built-in policies are static; no runtime mutation or priority weighting from past success rates. |
| AGENT-060 | Low | `adapter-registry.ts:535` | `checks.indexOf(check)` after `Promise.allSettled` — O(n²) lookup; use forEach with index. |
| AGENT-061 | Low | `claude-adapter.ts:619` | `loadSDK` (uppercase) preserved for backward-compat with test spies. Migrate spies, drop alias. |

---

## 7. TEST GAPS

| Adapter | Test files | Adequate? |
|---------|-----------|-----------|
| Claude | `claude-adapter.test.ts`, `claude-adapter-deep.test.ts` | Yes |
| Codex | `codex-adapter.test.ts`, `codex-adapter-deep.test.ts`, `codex-agent-writeback.test.ts` | Yes |
| Gemini | `gemini-adapter.test.ts`, `gemini-adapter-deep.test.ts`, `gemini-adapter-branches.test.ts`, `gemini-sdk-adapter.test.ts` | Yes |
| OpenAI | **None found** | **No (gap)** |
| OpenRouter | `openrouter-adapter.test.ts` | Thin |
| Qwen | `qwen-adapter.test.ts` | Thin |
| Goose | `goose-adapter.test.ts`, `goose-adapter-branches.test.ts` | Yes |
| Crush | `crush-adapter.test.ts` | Thin |

| ID | Severity | Description |
|----|----------|-------------|
| AGENT-070 | High | **No `openai-adapter.test.ts`** — SSE parser, structured output detection, error paths untested. |
| AGENT-071 | High | No end-to-end test for the durable approval flow traversing agent → adapter → registry → facade across a simulated restart. |
| AGENT-072 | Medium | Stuck detection has unit tests but no realistic-scenario integration test with the adapter-side `AdapterStuckDetector` exercised inside `executeWithFallback`. |
| AGENT-073 | Medium | No fuzzer/property test on `tool-arg-validator.validateAndRepairToolArgs` — auto-repair widens contracts. |
| AGENT-074 | Medium | Zero tests for prompt-injection scanner integration with tool results (only HumanMessage path tested). |
| AGENT-075 | Medium | `recovery-attempt-handler.ts` (658 LOC) has only thin coverage; missing branch tests for escalation thresholds. |
| AGENT-076 | Low | No chaos test against `OrchestratorFacade.run()` when `bridge` throws mid-stream. |

---

## Severity Summary

| Domain | Critical | High | Medium | Low | Total |
|--------|----------|------|--------|-----|-------|
| Tool Loop | 0 | 2 | 3 | 3 | 8 |
| Memory | 0 | 2 | 2 | 1 | 5 |
| Context | 1 | 1 | 2 | 0 | 4 |
| Guardrails | 0 | 4 | 3 | 1 | 8 |
| Orchestration | 0 | 3 | 4 | 1 | 8 |
| LLM Integration | 1 | 4 | 5 | 2 | 12 |
| Tests | 0 | 2 | 4 | 1 | 7 |
| **Total** | **2** | **18** | **23** | **9** | **52** |
