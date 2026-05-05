# Unified Prioritised Recommendations

**Date:** 2026-05-05  
**Scope:** `@dzupagent/agent` + `@dzupagent/agent-adapters`  
**Total findings:** 97 (2 Critical, 27 High, 42 Medium, 26 Low)

Sorted: Critical → High → Medium → Low, then quick-first within each severity band.

---

## Critical

### C-01: Implement Prompt Caching in Claude Adapter
**Domain:** Agent / LLM Integration  
**Severity:** Critical  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-connectors-dev  
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts:632-693`, `packages/agent-adapters/src/prompts/system-prompt-builder.ts`  
**Why:** The Claude adapter never sets `cache_control: 'ephemeral'` markers on system prompts, tool definitions, or static memory frames. This leaves 50-90% cost savings on the table for every Claude-powered run. Carry-over from 2026-05-03 audit — still unimplemented.  
**Fix:** Add `cache_control: { type: 'ephemeral' }` markers on system prompt segment, tool definitions block, and optional last static memory frame. Expose `promptCache: 'auto' | 'manual' | 'off'` on `AdapterConfig`.  
**Acceptance:** Integration test confirms cache markers present in SDK query options; cost-tracking middleware records `cache_creation_input_tokens` and `cache_read_input_tokens`.

---

## High (Quick first)

### H-01: Fix `workspace-write` sandbox mode maps to `bypassPermissions`
**Domain:** Agent / LLM Integration  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-connectors-dev  
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts:127-141`  
**Why:** `mapSandboxMode('workspace-write')` returns `'bypassPermissions'` — same as `'full-access'`. A caller that expects scoped cwd-write permission gets full permission bypass instead. Security-relevant defect.  
**Fix:** Map `'workspace-write'` to a permission profile that allows file writes within cwd but blocks shell/network. If Claude SDK doesn't expose granular mode, document the limitation and route `workspace-write` to `default` + `allowedTools` config.  
**Acceptance:** Adapter test asserts workspace-write mode produces a non-`bypassPermissions` config.

### H-02: Fix boundary violation — `agent` test imports `@dzupagent/server`
**Domain:** Architecture  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/__tests__/workflow-durability-integration.test.ts:14`  
**Why:** `@dzupagent/server` is undeclared in `packages/agent/package.json`. Works only due to workspace resolution; fails in published builds and violates the dependency hierarchy.  
**Fix:** Move test to `packages/server/src/__tests__/` (server depends on agent), or rewrite to use only public `@dzupagent/agent` API + `InMemoryRunStore`/`InMemoryRunJournal`.  
**Acceptance:** `yarn workspace @dzupagent/agent test` passes; no `@dzupagent/server` import in `packages/agent/src/`.

### H-03: Fix relative-path boundary violation in `agent-adapters` test
**Domain:** Architecture  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent-adapters/src/__tests__/structured-output-parity.test.ts:17-18`  
**Why:** `from '../../../agent/src/index.js'` bypasses the `@dzupagent/agent` exports contract and couples to internal source layout.  
**Fix:** Replace with `from '@dzupagent/agent'`.  
**Acceptance:** `yarn workspace @dzupagent/agent-adapters test` passes; grep for `'../../../agent/src'` returns zero hits.

### H-04: Add automated upstream-package boundary enforcement tests
**Domain:** Architecture  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** New `packages/agent/src/__tests__/boundary/upstream-package-boundary.test.ts`, new `packages/agent-adapters/src/__tests__/boundary/upstream-package-boundary.test.ts`  
**Why:** Without automated enforcement, boundary regressions (like H-02/H-03) go undetected until publish-time.  
**Fix:** Walk `src/**/*.ts` and assert no imports of `@dzupagent/{server,agent-adapters,codegen,connectors*,express,otel,evals,rag}` in `agent`; assert no relative `../../../` escapes in `agent-adapters`.  
**Acceptance:** Both tests green; CI fails immediately on future boundary regression.

### H-05: Add `agent:rate_limited` to DzupEvent union; remove `as never` cast
**Domain:** Code  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-core-dev  
**Files:** `packages/core/src/events/event-types.ts`, `packages/agent/src/agent/dzip-agent.ts:730`  
**Why:** `agent:rate_limited` is emitted with an `as never` cast, making it invisible to typed subscribers. Rate-limit telemetry is silently discarded.  
**Fix:** Add `{ type: 'agent:rate_limited'; agentId: string; reason: string }` to `DzupEvent` union; remove cast.  
**Acceptance:** `yarn typecheck --filter=@dzupagent/core && yarn typecheck --filter=@dzupagent/agent` pass; cast removed.

### H-06: Fix `consolidateOnComplete` — declare or implement
**Domain:** Agent / Memory  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/orchestration/team/team-runtime.ts:368-371`  
**Why:** `consolidateOnComplete` is a declared policy field that throws — a feature presented as supported but not implemented. Callers configuring team memory consolidation get silent runtime failures.  
**Fix:** Implement consolidation by calling `memory.consolidate?.(scope, namespace)` and emitting `team:consolidation_completed`.  
**Acceptance:** New unit test for consolidation invocation; no `throw "not supported"` in codebase.

### H-07: Fix adapter-registry event-bus union violation
**Domain:** Agent / LLM  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-core-dev  
**Files:** `packages/agent-adapters/src/registry/adapter-registry.ts:740-748`  
**Why:** `eventBus.emit(event as Parameters<DzupEventBus['emit']>[0])` — same root cause as H-05. Comment acknowledges the union violation. Suppresses type safety on adapter:completed events with usage.  
**Fix:** Extend DzupEvent union to include `agent:completed-with-usage` or the specific fields needed; remove the cast.  
**Acceptance:** `yarn typecheck --filter=@dzupagent/agent-adapters` passes; cast removed.

### H-08: Fix `interrupt()` process-level unhandledRejection handler leak
**Domain:** Agent / LLM  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-connectors-dev  
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts:444-485`  
**Why:** Installing `process.once('unhandledRejection', ...)` from a per-instance method is a leaky abstraction. Concurrent interrupts from multiple adapters clobber each other.  
**Fix:** Use a local try/catch around the SDK cleanup call rather than a process-level handler, or use `AbortController` signal to coordinate cleanup.  
**Acceptance:** Test with 3 concurrent adapter interrupts; no process-level handler accumulation.

### H-09: Fix retry abort-listener leak
**Domain:** Agent / Tool Loop  
**Severity:** High (Medium in isolation, but affects every retry across all runs)  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:282-299`  
**Why:** Retry sleep `setTimeout` adds an `abort` listener but never removes it on resolve — listener accumulates across many retries.  
**Fix:** Use `{ once: true }` for the abort listener and call `signal.removeEventListener('abort', onAbort)` in `clearTimeout` cleanup.  
**Acceptance:** Test driving 1000 retries on an aborted signal asserts no listener accumulation.

### H-10: Fix iteration-budget config mutation
**Domain:** Agent / Guardrails  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/guardrails/iteration-budget.ts:60-68`  
**Why:** `blockTool` mutates the caller-passed `config` via cast — unexpected side-effect on an externally-passed object.  
**Fix:** Track blocked tools in a private `Set<string>` field; expose `isToolBlocked` via union of config + dynamic set.  
**Acceptance:** Unit test asserts externally-passed config object retains identical shape after `blockTool`.

### H-11: Add webhook delivery retry + DLQ
**Domain:** Agent / Orchestration  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/approval/approval-gate.ts:104-107`  
**Why:** `notifyWebhook(...).catch(() => {})` swallows webhook delivery failures with no retry, no DLQ, no event. Webhook-driven approval flows can silently break.  
**Fix:** Add retry with backoff (3 attempts, jittered); add `webhookDLQ?: (payload, lastError) => Promise<void>` callback; emit `approval:webhook_failed` on terminal failure.  
**Acceptance:** Network-flake test asserts 3 attempts then DLQ invocation + event emission.

### H-12: Fix dead no-op try/catch in orchestrator
**Domain:** Agent / Orchestration  
**Severity:** High (cosmetic but indicates code maintenance quality)  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/orchestration/orchestrator.ts:520-522`  
**Why:** `try { ... } catch (err) { throw err }` is a no-op that adds no value and obscures intent.  
**Fix:** Delete the dead wrapper.  
**Acceptance:** `yarn typecheck && yarn test` pass.

### H-13: Remove dead `resumeSession` throw in OpenAI adapter
**Domain:** Agent / LLM  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-connectors-dev  
**Files:** `packages/agent-adapters/src/openai/openai-adapter.ts:308-318`  
**Why:** `resumeSession` throws unconditionally but `getCapabilities().supportsResume === false` means it's never called. Dead unreachable behavior.  
**Fix:** Remove the generator function body or replace with a proper "not supported" error that's clearly intentional.  
**Acceptance:** `yarn typecheck` passes.

### H-14: Add OpenAI adapter test suite
**Domain:** Agent / Tests  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-test-dev  
**Files:** New `packages/agent-adapters/src/__tests__/openai-adapter.test.ts`  
**Why:** OpenAI adapter has zero tests. SSE parser, structured output detection, error paths, abort propagation all untested.  
**Fix:** Create test file covering SSE chunk parsing, `[DONE]` terminator, malformed JSON skip, missing API key error, abort propagation, usage extraction, custom baseURL.  
**Acceptance:** ≥10 test cases; ≥80% statement coverage on `openai-adapter.ts`.

### H-15: Fix `as unknown as X` timeoutMs cast in CodexAdapter
**Domain:** Code  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-connectors-dev  
**Files:** `packages/agent-adapters/src/codex/codex-adapter.ts:508`  
**Why:** `(this.config as Record<string, unknown>).timeoutMs as number | undefined` — `timeoutMs` is undeclared on `AdapterConfig`. Critical path controlling hard abort of Codex streaming thread.  
**Fix:** Add `timeoutMs?: number` to `AdapterConfig` or `CodexAdapterConfig`.  
**Acceptance:** `yarn typecheck --filter=@dzupagent/agent-adapters` passes; double-cast removed.

### H-16: Move shared utilities to `@dzupagent/core`
**Domain:** Architecture  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-core-dev  
**Files:** `packages/agent/src/utils/exact-optional.ts` → `packages/core/src/utils/exact-optional.ts`; `packages/agent-adapters/src/utils/event-record.ts` → `packages/core/src/utils/event-record.ts`  
**Why:** Both utilities are pure, domain-independent helpers that both packages need. Currently siloed.  
**Fix:** Move both files; update all import sites; delete originals.  
**Acceptance:** `yarn verify` passes; no lingering local copies.

### H-17: Add `unref` to approval-gate timeout
**Domain:** Agent / Orchestration  
**Severity:** High  
**Phase:** quick (<2h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/approval/approval-gate.ts:153-164`  
**Why:** `setTimeout` without `.unref()` keeps the event loop alive indefinitely on pending approvals in long-lived servers.  
**Fix:** `timeoutHandle = setTimeout(...).unref()`  
**Acceptance:** Unit test confirms process can exit while approval is pending.

### H-18: Decompose `runToolLoop` outer body into staged helpers
**Domain:** Code / Agent  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/agent/tool-loop.ts:489-825`  
**Why:** 268-line monolithic `for` body mixes 6 concerns; impossible to test individual branches without constructing a full agent.  
**Fix:** Extract `injectToolStatsHint`, `recordTurnUsage`, `maybeCompressTurn`, `handleToolResults` into typed helpers returning `{ continue } | { halt: StopReason }`. Final `tool-loop.ts` ≤350 LOC.  
**Acceptance:** All existing tool-loop tests pass; new helpers individually testable.

### H-19: Add `runToolLoop` direct unit tests
**Domain:** Code / Tests  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-test-dev  
**Files:** New `packages/agent/src/__tests__/tool-loop-direct.test.ts`  
**Why:** All current coverage is via full `DzupAgent` integration; error paths in the loop are untestable in isolation.  
**Fix:** Add 5+ direct test scenarios: single tool call → complete; budget exceeded mid-loop; tool throws approval gate error; stuck detector fires; learning hook fails.  
**Acceptance:** ≥5 test cases; loop can be tested without a full agent instance.

### H-20: Add streaming-run provider failover tests + fix `recordProviderSuccess` gap
**Domain:** Code / Tests  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-test-dev  
**Files:** `packages/agent/src/agent/streaming-run.ts:148-207`; new `streaming-run-failover.test.ts`  
**Why:** Streaming path diverged from non-streaming: missing `recordProviderSuccess()` call. Existing tests don't catch this.  
**Fix:** Extract shared `attemptWithFailover<T>` in `provider-failover.ts`; wire both callers through it; add `recordProviderSuccess` to streaming path; add test covering provider-fail → retry → success with success-recording assertion.  
**Acceptance:** Both paths call `registry?.recordProviderSuccess()`; test green.

### H-21: Implement distributed rate limiter via Redis
**Domain:** Agent / Guardrails  
**Severity:** High  
**Phase:** major (16h+)  
**Expert Agent:** dzupagent-core-dev  
**Files:** New `packages/agent/src/guardrails/distributed-rate-limiter.ts`; `packages/agent/src/agent/dzip-agent.ts:719-733`  
**Why:** Per-process rate limiter allows budget overrun across multiple instances of the same agent.  
**Fix:** Redis-backed token-bucket with pessimistic increment. Inject via `rateLimiter` config on `DzupAgentConfig`. Default remains local limiter.  
**Acceptance:** Multi-instance integration test (Docker compose 3 nodes) confirms budget enforcement is global.

### H-22: Implement real tokenizer integration
**Domain:** Agent / Context  
**Severity:** High  
**Phase:** major (16h+)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** New `packages/core/src/llm/tokenizer.ts`; `packages/agent/src/context/auto-compress.ts`; `packages/agent/src/agent/dzip-agent.ts:626-628`  
**Why:** Current heuristic (char/4) can be off by ±30%. Compression triggers and budget warnings fire at wrong thresholds.  
**Fix:** Add `Tokenizer` interface in core; model-specific implementations for `@anthropic-ai/tokenizer`, `tiktoken` for OpenAI/Codex; resolve per-model in `ModelRegistry`. Keep heuristic as fallback.  
**Acceptance:** Within ±2% of provider-reported usage on recorded fixtures.

### H-23: Add durable approval E2E test across simulated restart
**Domain:** Agent / Tests  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-test-dev  
**Files:** New `packages/agent-adapters/src/__tests__/approval-durable-e2e.test.ts`  
**Why:** Durable approval gate is a critical feature; no test validates persistence across process restart.  
**Fix:** Fake adapter yields `requireApproval`; suspend; persist via test checkpoint store; tear down facade; rebuild; call `resume`; assert continuation produces `adapter:completed`.  
**Acceptance:** Test green using in-memory checkpoint store simulating persistence.

### H-24: Unify stuck detection under `@dzupagent/core`
**Domain:** Agent / Guardrails  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/guardrails/stuck-detector.ts`; `packages/agent-adapters/src/guardrails/adapter-guardrails.ts`  
**Why:** Two implementations with 5 vs 3 modes will drift. The adapter is missing `progress-hash` and `semantic plateau` detection.  
**Fix:** Move canonical `StuckDetector` (5 modes) into `@dzupagent/core`; agent-adapters wraps via thin `AdapterStreamSource` adapter; delete duplicate.  
**Acceptance:** Parity test confirms both detection surfaces have identical mode counts; `AdapterStuckDetector` deleted.

### H-25: Add LLM-call audit log
**Domain:** Agent / Guardrails  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** New `packages/agent/src/observability/llm-call-audit.ts`; `packages/agent/src/agent/run-engine.ts`  
**Why:** No compliance/audit trail for LLM calls — missing in regulated enterprise contexts.  
**Fix:** Pluggable `LLMCallAuditStore` interface persisting (prompt, completion, model, usage, ts, runId, agentId); `InMemory`/`File`/`Postgres` backends. Opt-in via `auditStore` config.  
**Acceptance:** Integration test confirms every successful/failed LLM call reaches the store.

### H-26: Cache supervisor manager-with-tools instance
**Domain:** Agent / Orchestration  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/orchestration/orchestrator.ts:480-501`  
**Why:** Supervisor re-creates `new DzupAgent({...})` on every call — pays full init cost each time.  
**Fix:** Memoize per `(managerId, sortedSpecialistIds)` key; invalidate on specialist set change.  
**Acceptance:** Microbenchmark shows ≥10× speedup on repeated `supervisor()` calls with identical specialists.

### H-27: Decompose `PipelineRuntime` (1029 LOC) into executor + lifecycle
**Domain:** Code / Architecture  
**Severity:** High  
**Phase:** refactor (4-8h)  
**Expert Agent:** dzupagent-agent-dev  
**Files:** `packages/agent/src/pipeline/pipeline-runtime.ts`; `packages/agent/src/pipeline/pipeline-runtime/`  
**Why:** 1029 LOC monolith despite helper modules existing in `pipeline-runtime/`. Same anti-pattern that was fixed in `OrchestratorFacade`.  
**Fix:** Extract `PipelineExecutor` (per-node retry/loop/branch/join) from `PipelineRuntime` (run lifecycle + events); rename `pipeline-runtime/` to `pipeline-runtime-internals/`. Target: ≤400 LOC each.  
**Acceptance:** All `pipeline-runtime.*.test.ts` green; new helpers individually testable.

---

## Medium (Quick first — partial selection)

### M-01: Emit `context:compression_failed` instead of swallowing silently
**Files:** `packages/agent/src/agent/tool-loop.ts:608-624` | **Phase:** quick | **Agent:** dzupagent-agent-dev

### M-02: Fix `instrumentSpecialistTool` tool.invoke mutation race
**Files:** `packages/agent/src/orchestration/orchestrator.ts:103-114` | **Phase:** quick | **Agent:** dzupagent-agent-dev

### M-03: Extract `sha256` to shared hash-utils
**Files:** `packages/agent-adapters/src/dzupagent/syncer.ts:127`, `importer.ts:132,182` | **Phase:** quick | **Agent:** dzupagent-connectors-dev

### M-04: Replace `console.log`/`debug` with `@dzupagent/logger`
**Files:** `codex-adapter.ts`, `orchestration-telemetry.ts`, `self-learning-hook.ts`, `syncer.ts`, `memory-enrichment.ts` | **Phase:** quick | **Agent:** dzupagent-connectors-dev

### M-05: Fix O(n²) indexOf in `adapter-registry` health checks
**Files:** `packages/agent-adapters/src/registry/adapter-registry.ts:535` | **Phase:** quick | **Agent:** dzupagent-connectors-dev

### M-06: Drop `loadSDK` alias in Claude adapter
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts:619` | **Phase:** quick | **Agent:** dzupagent-connectors-dev

### M-07: Fix `ArrowRuntimeNotInjectedError` swallowed as generic failure
**Files:** `packages/agent/src/agent/memory-context-loader.ts:19-26` | **Phase:** quick | **Agent:** dzupagent-agent-dev

### M-08: Make memory limits per-agent tuneable
**Files:** `packages/agent/src/agent/memory-context-loader.ts:43-51` | **Phase:** refactor | **Agent:** dzupagent-agent-dev

### M-09: Extract SSE parser to shared utility
**Files:** `packages/agent-adapters/src/openai/openai-adapter.ts`, `openrouter-adapter.ts` | **Phase:** refactor | **Agent:** dzupagent-connectors-dev

### M-10: Decompose `executeWithFallback` (215 LOC) in adapter-registry
**Files:** `packages/agent-adapters/src/registry/adapter-registry.ts:251-466` | **Phase:** refactor | **Agent:** dzupagent-connectors-dev

### M-11: Add `BaseCliAdapter.execute` path-level tests
**Files:** New `packages/agent-adapters/src/__tests__/base-cli-adapter-execute.test.ts` | **Phase:** refactor | **Agent:** dzupagent-test-dev

### M-12: Add `RecoveryAttemptHandler` unit tests
**Files:** New `packages/agent-adapters/src/__tests__/recovery-attempt-handler.test.ts` | **Phase:** refactor | **Agent:** dzupagent-test-dev

### M-13: Add pluggable output filter chain
**Files:** `packages/agent-adapters/src/guardrails/adapter-guardrails.ts` | **Phase:** major | **Agent:** dzupagent-connectors-dev

### M-14: Implement memory consolidation engine
**Files:** New `packages/memory/src/consolidation-engine.ts`; `team-runtime.ts:368-371`; `agent-finalizers.ts` | **Phase:** major | **Agent:** dzupagent-core-dev

---

## Low (Selected quick items)

### L-01: Add justification comments to 8 `eslint-disable` suppressions
**Files:** `failure-analyzer.ts:43`, `output-refinement.ts:211,222`, `root-cause-analyzer.ts:131,160`, `reflection-loop.ts:123,128,140` | **Phase:** quick | **Agent:** general-purpose

### L-02: Add ADR-0007 for `flow-compiler` layer ownership
**Files:** New ADR; `adapter-workflow.ts:8-12` | **Phase:** quick | **Agent:** dzupagent-architect

### L-03: Add sunset date to `compat.ts` exports (ADR-0008)
**Files:** `packages/agent/src/compat.ts` | **Phase:** quick | **Agent:** dzupagent-architect

### L-04: Resolve `MergeStrategy` type name collision
**Files:** `packages/agent/src/workflow/workflow-types.ts`, `packages/agent-adapters/src/orchestration/parallel-executor.ts` | **Phase:** quick | **Agent:** dzupagent-architect

### L-05: Extract `TeamRuntime` into 5 strategy pattern classes
**Files:** `packages/agent/src/orchestration/team/team-runtime.ts` | **Phase:** major | **Agent:** dzupagent-agent-dev

### L-06: Extract `AdapterStreamRunner` shared base for all adapters
**Files:** New `packages/agent-adapters/src/base/stream-runner.ts`; all 9 adapter files | **Phase:** major | **Agent:** dzupagent-connectors-dev
