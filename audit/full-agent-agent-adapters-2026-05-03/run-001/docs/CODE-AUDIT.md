# CODE-AUDIT: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03
**Packages:** `packages/agent` (385 .ts, 179 test files), `packages/agent-adapters` (268 .ts, 134 test files)

## Summary

| Severity | Count |
|----------|-------|
| P1 (Critical) | 5 |
| P2 (High) | 10 |
| P3 (Medium) | 9 |
| P4 (Low) | 4 |
| **Total** | **28** |

---

## Findings

### C-01: `DzupEventBus.emit()` uses `as never` / `as unknown as X` throughout
**Severity:** P1
**File:** `packages/agent/src/agent/dzip-agent.ts` (multiple emit sites), `packages/agent/src/orchestration/orchestrator.ts` (emit sites)
**Pattern:** Every `DzupEventBus.emit()` call in agent core uses `as never` or `as unknown as X` to bypass the discriminated-union type. Root cause: the `DzupEvent` union in `@dzupagent/core` is missing optional fields (`output`, `errorMessage`, `status: 'success'`) that callers legitimately emit.
**Fix effort:** 2h
**Fix:** Add the missing optional fields to the relevant discriminated union members in `@dzupagent/core/src/event-bus.ts`. All `as never` casts at emit sites dissolve without needing changes to the callers.

---

### C-02: Double-cast `as unknown as X` in orchestration emit
**Severity:** P1
**File:** `packages/agent/src/orchestration/orchestrator.ts` (emit sites), `packages/agent/src/approval/approval-gate.ts:147-160`
**Pattern:** `as unknown as AgentStartedEvent` style double-casts bypass discriminated-union type safety. These are in hot paths (approval gate, orchestration start/end events).
**Fix effort:** 1h (after C-01 is fixed)
**Fix:** Fix the `DzupEvent` union types (C-01). Then remove double-casts; if residual casts remain, they indicate genuinely incorrect event shape — fix the shape.

---

### C-03: `executeStreamingToolCall` is a 396-line function with 7-level nesting
**Severity:** P1
**File:** `packages/agent/src/agent/run-engine.ts:523–919`
**Pattern:** Single function handles tool dispatch, streaming accumulation, checkpoint detection, abort handling, error paths, and event emission — all inline with 7 levels of nesting. No direct unit tests.
**Fix effort:** 4-8h
**Fix:** Extract three helpers: `accumulateStreamChunks(stream, budget, signal)`, `dispatchToolResults(toolMessages, executor)`, and `handleStreamAbort(runId, budget)`. Each is independently testable. The outer function becomes a coordinator of ~80 LOC.

---

### C-04: `executeWithRecovery` and `executeWithRecoveryStream` are near-identical (441 + 449 LOC)
**Severity:** P1
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:1`
**Pattern:** The streaming method re-inlines all decomposed helpers from the non-streaming path. A shared inner loop with an `emitChunk` callback vs `emit result` callback would cut the file from 1,250 to ~400 LOC.
**Fix effort:** 4-8h
**Fix:** Extract `executeWithRecoveryCore(config, runFn, options)` where `runFn` is `() => Promise<T>` for non-streaming and `() => AsyncIterable<T>` for streaming. Both public methods delegate to the core.

---

### C-05: Floating Promise in agent finalizers journal write
**Severity:** P1
**File:** `packages/agent/src/agent/agent-finalizers.ts` (journal write call site, referenced from `dzip-agent.ts:787-794`)
**Pattern:** `maybeWriteBackMemory` contains an unawaited `journal.write(...)` call — a floating promise that silently discards write errors.
**Fix effort:** 1h
**Fix:** `await journal.write(...)` and propagate errors through the finalizer's error handler. Add test asserting write failures are surfaced.

---

### H-01: `DynamicToolRegistry` has 21 public methods — too many responsibilities
**Severity:** P2
**File:** `packages/agent/src/agent/tool-registry.ts`
**Pattern:** The registry owns: registration, deregistration, schema validation, scope filtering, owner filtering, approval-mode querying, timeout querying, serialization, and stats — all as public methods.
**Fix effort:** 4-8h
**Fix:** Extract a `ToolQuery` read-model (scope/owner/approval queries) and a `ToolSerializer` into separate classes. Registry retains only `register`, `deregister`, `get`, and `list`.

---

### H-02: Two exported `TeamCoordinator` / `TeamRuntime` classes implement the same patterns
**Severity:** P2
**Files:** `packages/agent/src/orchestration/team/team-runtime.ts:22` (1,281 LOC), `packages/agent/src/playground/team-coordinator.ts` (495 LOC)
**Pattern:** Both export the same supervisor / peer-to-peer / blackboard coordination via the same `AgentOrchestrator` calls. `TeamCoordinator` predates `TeamRuntime` and should be deprecated.
**Fix effort:** 4-8h
**Fix:** Annotate `TeamCoordinator` as `@deprecated` in JSDoc pointing to `TeamRuntime`. Remove `TeamCoordinator` from the main barrel export. Add a migration note.

---

### H-03: Triplicate skill-validator boilerplate across three adapter files
**Severity:** P2
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts`, `packages/agent-adapters/src/codex/codex-adapter.ts`, `packages/agent-adapters/src/gemini/gemini-adapter.ts`
**Pattern:** All three independently inline the same `validateSkillConfig(skill)` check: null-check name, description length, input schema presence. Identical 20-30 LOC block in each.
**Fix effort:** 2-4h
**Fix:** Extract to `packages/agent-adapters/src/base/validate-skill-config.ts`. Each adapter imports and calls it.

---

### H-04: Duplicated token-extraction logic in Claude and Codex adapters
**Severity:** P2
**Files:** `packages/agent-adapters/src/claude/claude-adapter.ts`, `packages/agent-adapters/src/codex/codex-adapter.ts`
**Pattern:** Both adapters independently parse `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` from provider responses. Identical 25 LOC utility in each.
**Fix effort:** 2-4h
**Fix:** Extract `extractTokenUsage(usage: unknown): TokenUsage` to `packages/agent-adapters/src/base/extract-token-usage.ts`.

---

### H-05: Dead `playground/ui/` module (zero imports)
**Severity:** P2
**File:** `packages/agent/src/playground/` (UI subdir)
**Pattern:** The playground UI module is exported from the package barrel but has zero imports in the entire monorepo. It contains Vue-style or React-style component stubs that cannot run in a Node agent context.
**Fix effort:** 1-2h
**Fix:** Verify with `grep -r "from '@dzupagent/agent.*playground/ui"` — if zero results, delete the UI subdir and remove from barrel.

---

### H-06: `void` suppression on timing variables hides potential race conditions
**Severity:** P2
**Files:** `packages/agent/src/agent/dzip-agent.ts` (3 sites), `packages/agent/src/orchestration/orchestrator.ts` (2 sites)
**Pattern:** `void someAsyncFn()` is used to suppress TypeScript's "floating promise" warning on timer/cleanup paths. This is a lint bypass, not correct async handling.
**Fix effort:** 2-4h
**Fix:** Audit each `void` suppressed call. For cleanup paths, propagate to a `shutdown()` method. For fire-and-forget event emissions, use `.catch(this.errorHandler)`.

---

### H-07: Swallowed errors in mailbox message handler
**Severity:** P2
**File:** `packages/agent/src/mailbox/mailbox.ts` (handler registration site)
**Pattern:** The mailbox dispatches incoming messages to handlers; if a handler throws, the error is caught and logged via `console.error` but never re-emitted on the event bus. Dead-letter queue logic is absent.
**Fix effort:** 2-4h
**Fix:** On handler error, emit `mailbox:error` event with `{messageId, error, handler}`. Add a dead-letter queue option (`config.deadLetterQueue?: boolean`) that accumulates failed messages for replay.

---

### H-08: Zero tests on `policy-enabled-tool-executor.ts`
**Severity:** P2
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts` (337 LOC — central tool enforcement function)
**Pattern:** This is the most critical gating function in the tool loop (policy check → approval → safety scan → execution → result transform → checkpoint detection) and has no dedicated test file. It is partially exercised via integration tests but no unit tests isolate its branches.
**Fix effort:** 4-8h
**Fix:** Create `packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts` with unit tests covering: policy deny → blocked, approval required → requested, safety scan fail-closed → blocked, successful execution → checkpoint event emitted.

---

### H-09: Zero tests on `daemon-launcher.ts` and `mailbox/` module
**Severity:** P2
**Files:** `packages/agent/src/agent/daemon-launcher.ts`, `packages/agent/src/mailbox/`
**Pattern:** Both modules handle process lifecycle and IPC — high-risk code with zero direct unit tests.
**Fix effort:** 4-8h
**Fix:** Create test files using `vitest` process mocking. For mailbox: test send/receive, dead-letter, rate-limit enforcement.

---

### H-10: Zero tests on `ucl/skill-loader.ts`
**Severity:** P2
**File:** `packages/agent-adapters/src/ucl/skill-loader.ts`
**Pattern:** UCL skill loading is a public API surface with no tests. Combined with the `ucl/` vs `dzupagent/` duplication issue (A-04), this is untested duplicate code.
**Fix effort:** 2-4h
**Fix:** Either add tests or delete the `ucl/` module per the architecture finding A-04. Prefer deletion.

---

### M-01: `team-runtime.ts` is 1,281 LOC with LLM invocations as stubs
**Severity:** P3
**File:** `packages/agent/src/orchestration/team/team-runtime.ts:22`
**Pattern:** Largest source file in the package. The file's own documentation states LLM invocations "do not yet invoke real LLMs." Exported as tier-1 public API with `@experimental` absent.
**Fix effort:** 1-2d (annotation + extraction); 5-10d (completing stubs)
**Fix:** Add `@experimental` JSDoc. Extract pattern-specific logic to separate files. Extract model constants to a `TeamRuntimeDefaults` config.

---

### M-02: Duplicated pipeline error tail across `run-engine.ts` and `pipeline-runtime.ts`
**Severity:** P3
**Files:** `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/pipeline/pipeline-runtime.ts`
**Pattern:** Both files implement nearly identical error-catch → emit `agent:failed` / `pipeline:failed` → re-throw tail logic. ~40 LOC duplication.
**Fix effort:** 2-4h
**Fix:** Extract `emitFailureAndRethrow(bus, runId, err, eventType)` helper to `packages/agent/src/utils/emit-failure.ts`.

---

### M-03: Three `void` suppressions in `md-parser.ts` hide silent failures
**Severity:** P3
**File:** `packages/agent-adapters/src/dzupagent/md-frontmatter-parser.ts` (3 `void` sites)
**Pattern:** Same pattern as H-06 but in the UCL markdown parser — errors in async parse steps are swallowed.
**Fix effort:** 1-2h
**Fix:** Replace `void asyncStep()` with `await asyncStep()` in the parser's public API path.

---

### M-04: Silently swallowed reflection-loop errors
**Severity:** P3
**File:** `packages/agent/src/reflection/reflection-loop.ts`
**Pattern:** The reflection loop catch block logs the error and returns the original output unchanged, with no event emitted. Callers have no visibility into whether reflection succeeded or was skipped.
**Fix effort:** 1-2h
**Fix:** Emit `reflection:failed` event on the event bus with `{runId, error}`. Return `{output: original, reflectionSkipped: true, reason: err.message}`.

---

### M-05: Wrong `approval:requested` payload shape
**Severity:** P3
**File:** `packages/agent/src/approval/approval-gate.ts:147-160`
**Pattern:** The `approval:requested` event emits `{contactId, plan}` but `AdapterApprovalHandler` downstream expects `{runId, plan, channel, requestedAt}`. Field mismatch causes handler to silently miss `runId`.
**Fix effort:** 1h
**Fix:** Add `runId` and `requestedAt: Date.now()` to the `approval:requested` event payload. Update both the emitter and any test stubs.

---

### M-06: Untested UCL memory-loader and agent-loader
**Severity:** P3
**Files:** `packages/agent-adapters/src/dzupagent/memory-loader.ts` (355 LOC), `packages/agent-adapters/src/dzupagent/agent-loader.ts` (349 LOC)
**Pattern:** Both are production loaders for the Unified Capability Layer with zero direct unit tests.
**Fix effort:** 4-8h
**Fix:** Create `__tests__/memory-loader.test.ts` and `__tests__/agent-loader.test.ts` using fixture `.dzupagent/` directories.

---

### M-07: `AgentOrchestrator.parallel` has no max-concurrency guard
**Severity:** P3
**File:** `packages/agent/src/orchestration/orchestrator.ts` (parallel execution path)
**Pattern:** `Promise.all(agents.map(a => run(a)))` — unbounded concurrency. 50 agents passed in will spawn 50 simultaneous LLM calls.
**Fix effort:** 2-4h
**Fix:** Add `maxConcurrency?: number` to `ParallelConfig`. Default to `Math.min(agents.length, 5)`. Implement a p-limit style queue.

---

### M-08: Structured output repair loop has no max-repair-attempts guard
**Severity:** P3
**File:** `packages/agent/src/agent/structured-generate.ts:285-310`
**Pattern:** The JSON repair loop that re-prompts the LLM on parse failure has no explicit iteration cap visible at the call site. If the LLM consistently returns malformed JSON, this loops until the `IterationBudget` fires.
**Fix effort:** 1-2h
**Fix:** Add `maxRepairAttempts?: number` (default 2) to `StructuredGenerateConfig`. Throw `StructuredOutputMaxAttemptsError` when exceeded.

---

### M-09: `OutputRefinementLoop` has no convergence check
**Severity:** P3
**File:** `packages/agent/src/self-correction/output-refinement-loop.ts`
**Pattern:** The loop runs for `maxIterations` regardless of whether the output quality improves between iterations. This wastes LLM calls when convergence is reached early.
**Fix effort:** 2-4h
**Fix:** Add a `converged(prev, curr): boolean` predicate to `OutputRefinementConfig` (default: cosine-similarity > 0.98 or identical string). Break early when converged; emit `refinement:converged` event.

---

### L-01: Redundant `void` cast in Claude adapter cleanup path
**Severity:** P4
**File:** `packages/agent-adapters/src/claude/claude-adapter.ts` (cleanup method)
**Pattern:** `void this.cleanup()` — the cleanup method is already a fire-and-forget destructor.
**Fix effort:** 15m
**Fix:** `this.cleanup().catch(() => {})` for explicit intent or simply `await this.cleanup()` if the caller is async.

---

### L-02: `void` cast in contract-net bidding path
**Severity:** P4
**File:** `packages/agent/src/orchestration/contract-net/contract-net-types.ts`
**Pattern:** `void bid.emit(...)` — bids are async but the result is discarded.
**Fix effort:** 15m
**Fix:** `.catch(this.logger.error)` to at least log failures.

---

### L-03: `void` cast in file-loader cleanup
**Severity:** P4
**File:** `packages/agent-adapters/src/dzupagent/agent-loader.ts`
**Pattern:** Same pattern; cleanup async disposal is voided.
**Fix effort:** 15m
**Fix:** Use `.catch(() => {})` with a comment or `await`.

---

### L-04: Inconsistent `console.error` vs event-bus error reporting
**Severity:** P4
**Files:** Multiple (`codex-adapter.ts:565,588,605`, `syncer.ts:610,615`, `agent-loader.ts:233`)
**Pattern:** ~55 bare `console.*` calls in production code paths bypass the structured event bus.
**Fix effort:** 1d (bulk replace)
**Fix:** Replace with `@datazup/logger` (`createLogger`). See architecture finding A-17.

---

## Quick Fix Prompts

### QF-C01: Fix `DzupEvent` union to dissolve `as never` casts
**Finding:** C-01, C-02
**Files:** `packages/core/src/event-bus.ts` (union definition), `packages/agent/src/agent/dzip-agent.ts` (emit sites)
**What to change:** Add missing optional fields `output?: unknown`, `errorMessage?: string`, `status?: 'success' | 'failed' | 'running'` to the relevant discriminated union members in `DzupEvent`. Then remove all `as never` and `as unknown as X` casts at emit sites in `dzip-agent.ts` and `orchestrator.ts`.
**Acceptance:** `yarn typecheck --filter=@dzupagent/agent` passes with zero suppressions.
**Validation:** `grep -r "as never\|as unknown as" packages/agent/src/ --include="*.ts"` returns 0 results.
**Agent:** `dzupagent-core-dev`

### QF-C05: Fix floating Promise in agent-finalizers journal write
**Finding:** C-05
**File:** `packages/agent/src/agent/agent-finalizers.ts`
**What to change:** `await journal.write(...)` instead of unawaited call. Add `.catch(err => this.eventBus.emit('agent:error', { runId, error: err }))`.
**Acceptance:** Journal write failures are observable via event bus. Test asserts error event emitted on write failure.
**Validation:** `yarn test --filter=@dzupagent/agent -- agent-finalizers` passes.
**Agent:** `dzupagent-agent-dev`

### QF-M05: Fix `approval:requested` payload shape
**Finding:** M-05
**File:** `packages/agent/src/approval/approval-gate.ts:147-160`
**What to change:** Add `runId` and `requestedAt: Date.now()` to the emitted event object.
**Acceptance:** `AdapterApprovalHandler` receives `runId` correctly. Existing approval gate tests pass.
**Validation:** `yarn test --filter=@dzupagent/agent -- approval` passes.
**Agent:** `dzupagent-agent-dev`

---

## Refactor Prompts

### RF-C03: Extract `executeStreamingToolCall` into testable helpers
**Finding:** C-03
**File:** `packages/agent/src/agent/run-engine.ts:523–919`
**What to change:** Extract `accumulateStreamChunks(stream, budget, signal): Promise<ChunkAccumulation>`, `dispatchToolResults(messages, executor): Promise<ToolResult[]>`, `handleStreamAbort(runId, budget): void`. The outer function delegates to all three.
**Acceptance:** `executeStreamingToolCall` is ≤100 LOC. Each helper has its own test file.
**Validation:** `yarn test --filter=@dzupagent/agent` passes. `wc -l packages/agent/src/agent/run-engine.ts` shows reduction.
**Agent:** `dzupagent-agent-dev`

### RF-C04: Deduplicate recovery execution loops
**Finding:** C-04
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts`
**What to change:** Extract `executeWithRecoveryCore<T>(runFn, traceStore, config)` parameterized on whether `runFn` is sync-result or streaming. Both `executeWithRecovery` and `executeWithRecoveryStream` delegate to it.
**Acceptance:** `adapter-recovery.ts` is ≤500 LOC. All existing recovery tests pass.
**Validation:** `yarn test --filter=@dzupagent/agent-adapters -- recovery` passes.
**Agent:** `dzupagent-connectors-dev`

### RF-H08: Add unit tests for `policy-enabled-tool-executor.ts`
**Finding:** H-08
**File:** `packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts` (create)
**What to change:** Write tests covering: (1) policy deny → tool blocked, (2) approval required → `approval:requested` emitted, (3) safety scan fail-closed → `tool:blocked` emitted, (4) successful execution → checkpoint event emitted when result matches checkpoint shape.
**Acceptance:** 100% branch coverage on `policy-enabled-tool-executor.ts`. Tests run in <5s.
**Validation:** `yarn test --filter=@dzupagent/agent -- policy-enabled` passes with coverage.
**Agent:** `dzupagent-test-dev`

---

## Major Change Prompts

### MC-C04+A09: Decompose `AdapterRecoveryCopilot` god object
**Findings:** C-04, A-09
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts` (1,250 LOC)
**What to change:** Extract `ExecutionTraceStore` (in-memory Map + TTL eviction, injectable), `RecoveryLoopRunner` (non-stream + stream loops using the core from RF-C04). `AdapterRecoveryCopilot` injects both and owns only escalation + handoff decisions. Replace `setInterval` eviction with a `FinalizationRegistry` or explicit `dispose()` lifecycle contract.
**Acceptance:** `AdapterRecoveryCopilot` is ≤200 LOC. `ExecutionTraceStore` has its own tests. Eviction is testable without timing side effects.
**Validation:** `yarn test --filter=@dzupagent/agent-adapters -- recovery` passes.
**Agent:** `dzupagent-connectors-dev`
