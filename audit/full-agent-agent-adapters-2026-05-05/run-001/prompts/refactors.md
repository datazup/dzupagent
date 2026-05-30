# Refactors (P2 — 4-8h each)

---

## RF-01: Fix 15 `as never` spread-narrowing casts across agent [CODE-002]
**Target agent:** dzupagent-core-dev

In `packages/core/src/events/event-types.ts`, audit `DzupEvent` union members and make the following fields optional (with comments explaining the invariant):
- `provider:run_attempt.maxAttempts?: number` (currently required but not always present at the emit site)
- Any other non-optional fields that force conditional spreads

Then remove all 15 `as never` casts from:
- `packages/agent/src/agent/dzip-agent.ts:514`
- `packages/agent/src/agent/streaming-run.ts:145`
- `packages/agent/src/agent/run-engine.ts:741,895`
- `packages/agent/src/agent/tool-lifecycle-policy.ts:130,180,242,288`
- `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:148,353,398,556,571`
- `packages/agent/src/approval/approval-gate.ts:88,144,161`

Replace each cast with a direct object literal that satisfies the union without coercion.

**Acceptance:** `yarn typecheck --filter=@dzupagent/agent` passes; `grep -n "as never" packages/agent/src/` returns 0 hits.

**Validate:** `yarn workspace @dzupagent/agent test`

---

## RF-02: Fix `as unknown as X` double-casts [CODE-003]
**Target agent:** dzupagent-agent-dev

Fix the following double-casts by adding typed interfaces or getter methods:

1. `packages/agent/src/mailbox/agent-mailbox.ts:91,93` — Add `RateLimiterConfig { maxMessages: number; windowMs: number }` to the `RateLimiter` interface, or expose a `getConfig(): RateLimiterConfig` method. Remove the `as unknown as { maxMessages?: number }` cast.

2. `packages/agent/src/agent/dzip-agent.ts:463` — Add the probed fields to the `ModelRegistry` interface or use a typed getter. Remove the `as unknown as { ... }` cast.

3. `packages/agent/src/self-correction/recovery-feedback.ts:126,152,192` — Make `MemoryStore.get()` generic (`get<T>(key): Promise<T | undefined>`) so the return type is narrowed at call site. Remove `serialized as unknown as Record<string, unknown>`.

4. `packages/agent/src/orchestration/delegating-supervisor.ts:552` — Follows from RF-01 (same event-bus cast pattern). Fix via DzupEvent union extension.

5. `packages/agent-adapters/src/output/structured-output.ts:542`, `packages/agent-adapters/src/persistence/run-manager.ts:358`, `packages/agent-adapters/src/session/session-registry.ts:527` — Audit each; add typed interfaces or narrow via runtime checks instead of casts.

**Acceptance:** `grep -n "as unknown as" packages/agent/src packages/agent-adapters/src | grep -v ".test.ts"` returns ≤2 hits (the Gemini dynamic-import cast is acceptable).

**Validate:** `yarn workspace @dzupagent/agent test && yarn workspace @dzupagent/agent-adapters test`

---

## RF-03: Decompose `runToolLoop` outer body into staged helpers [CODE-010, AGENT-002]
**Target agent:** dzupagent-agent-dev

In `packages/agent/src/agent/tool-loop.ts:489-825`, the outer `for` body is 268 lines mixing 6 concerns.

Extract these helpers from the `for` loop body:

```typescript
function injectToolStatsHint(
  messages: AgentMessage[],
  tracker: ToolCallTracker,
  intent: string | undefined,
): void

function recordTurnUsage(
  state: ToolLoopState,
  usage: TokenUsage | undefined,
  budget: IterationBudget,
  callbacks: ToolLoopCallbacks,
): void

function maybeCompressTurn(
  state: ToolLoopState,
  config: DzupAgentConfig,
): Promise<void>  // non-fatal, emits event on failure

function handleToolResults(
  results: ToolCallResult[],
  state: ToolLoopState,
  config: DzupAgentConfig,
): LoopTransition  // { continue: true } | { halt: StopReason }
```

Each helper takes a `ToolLoopState` value object and returns a typed transition.

The sub-modules `tool-loop/model-turn-kernel.ts` and `tool-loop/tool-scheduler-kernel.ts` exist as stubs — move relevant code into them.

**Acceptance:** Final `tool-loop.ts` ≤350 LOC; all existing tool-loop tests pass; each extracted function is callable without constructing a full `DzupAgent`.

**Validate:** `yarn workspace @dzupagent/agent test`

---

## RF-04: Extract shared `attemptWithFailover<T>` + fix streaming `recordProviderSuccess` gap [CODE-006]
**Target agent:** dzupagent-agent-dev

Create `packages/agent/src/agent/provider-failover.ts`:
```typescript
export async function attemptWithFailover<T>(
  attempts: ProviderAttempt[],
  invoke: (attempt: ProviderAttempt, index: number) => Promise<T>,
  ctx: {
    registry?: ModelRegistry
    emit: (event: DzupEvent) => void
    shouldFailover: (err: Error) => boolean
  },
): Promise<T>
```

The function implements:
- Iterate over `attempts`
- Emit `provider:run_attempt` before each attempt
- Catch failure → emit `provider:run_failure` → check `shouldFailover` → continue or break
- On success → call `ctx.registry?.recordProviderSuccess(attempt.provider)`

Wire both callers:
- `packages/agent/src/agent/dzip-agent.ts:766-815` → `invokeModelWithProviderFailover`
- `packages/agent/src/agent/streaming-run.ts:148-207` → `openStreamWithProviderFailover`

The streaming path currently does NOT call `registry?.recordProviderSuccess()` — this is a bug that must be fixed in this refactor.

**Acceptance:** Both paths call `recordProviderSuccess` on success; new test `streaming-run-failover.test.ts` covers: first-provider-fail → second-succeeds; all-fail → throws; streaming records success.

**Validate:** `yarn workspace @dzupagent/agent test`

---

## RF-05: Decompose `BaseCliAdapter` into composition of focused modules [ARCH-009]
**Target agent:** dzupagent-connectors-dev

Split `packages/agent-adapters/src/base/base-cli-adapter.ts` (821 LOC, 4 concerns) into:

1. `packages/agent-adapters/src/base/governance-emitter.ts` — `onGovernanceEvent`, `emitGovernanceEvent`, `emitRuleViolation`, `validateAndEmitRules`
2. `packages/agent-adapters/src/base/artifact-watcher-host.ts` — `startArtifactWatcher`, `stopArtifactWatcher`, artifact event piping
3. `packages/agent-adapters/src/base/env-builder.ts` — `buildEnv`, `buildSpawnEnv`, `EnvFilterConfig`
4. `packages/agent-adapters/src/base/adapter-error-normalizer.ts` — `normalizeError`, `shouldRethrow`

`BaseCLIAdapter` becomes a thin composition class (~250 LOC) that wires the four collaborators. All concrete adapter subclass public APIs must remain unchanged.

**Acceptance:** All 9 adapter tests pass unchanged; `BaseCLIAdapter` ≤300 LOC.

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## RF-06: Decompose `CodexAdapter.runStreamedThread` (291 LOC) [CODE-013]
**Target agent:** dzupagent-connectors-dev

In `packages/agent-adapters/src/codex/codex-adapter.ts`, extract:

1. `classifyCodexItem(item: CodexItem, state: StreamState): AgentEvent | null` — the 12+ item-type dispatch table (partially started via `mapEvent`/`mapItemCompleted`)
2. `createThreadAbortController(timeoutMs: number | undefined, callerSignal: AbortSignal): { signal: AbortSignal; cleanup: () => void }` — timeout + multi-signal combine logic
3. `buildCompletedPayload(state: StreamState): AdapterCompletedEvent` — final response assembly + token usage capture

Target: `runStreamedThread` ≤100 LOC after extraction.

**Acceptance:** All codex-adapter tests pass; new `codex-classify-item.test.ts` covers all 12+ item types.

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run codex`

---

## RF-07: Extract SSE parser to shared utility [AGENT-058/M-09]
**Target agent:** dzupagent-connectors-dev

Create `packages/agent-adapters/src/utils/sse-parser.ts`:
```typescript
export async function* parseSSE<TChunk>(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  deserialize: (line: string) => TChunk | null,
  signal: AbortSignal,
): AsyncGenerator<TChunk>
```

Handle: multi-line events, `data:` prefix stripping, `[DONE]` terminator, malformed JSON skip, abort signal.

Refactor `packages/agent-adapters/src/openai/openai-adapter.ts` and `packages/agent-adapters/src/openrouter/openrouter-adapter.ts` to use the shared parser.

**Acceptance:** Unit tests covering all edge cases; both adapter test files pass unchanged.

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## RF-08: Add `RecoveryAttemptHandler` unit tests [CODE-015/M-12]
**Target agent:** dzupagent-test-dev

Create `packages/agent-adapters/src/__tests__/recovery-attempt-handler.test.ts`.

Required scenarios (minimum 5):
1. Happy path: `runAttempt` succeeds on first attempt → `CompletedResult`
2. Escalation path: `attempt >= maxAttempts` → returns `ExhaustedResult`, emits escalation event
3. Trace-store failure: `executionTraceStore.save()` throws → does NOT abort the run, emits warning
4. Aborted signal: signal already aborted before `runAttempt` starts → returns `CancelledResult`
5. Cross-provider handoff: first provider exhausted, second provider succeeds

**Acceptance:** ≥5 test cases; ≥75% branch coverage on `recovery-attempt-handler.ts`.

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run recovery-attempt-handler`

---

## RF-09: Add `BaseCliAdapter.execute` path-level tests [CODE-018/M-11]
**Target agent:** dzupagent-test-dev

Create `packages/agent-adapters/src/__tests__/base-cli-adapter-execute.test.ts`.

Create a concrete `TestCliAdapter extends BaseCLIAdapter` with a minimal binary mock (a Node.js script that echoes lines).

Required scenarios (minimum 6):
1. Happy path: process exits 0, events collected, `adapter:completed` emitted
2. Abort signal already aborted before spawn → `adapter:failed` emitted immediately
3. Abort signal fires mid-stream → process killed, partial events, `adapter:failed`
4. Process exits non-zero → `normalizeError` called, `adapter:failed` emitted
5. Governance listener registered → receives `GovernanceEvent` on rule violation
6. Interaction detection: process outputs a question pattern → `interaction:detected` emitted

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run base-cli-adapter-execute`

---

## RF-10: Add streaming-run provider failover + fix recordProviderSuccess gap [CODE-017]
**Target agent:** dzupagent-test-dev

After RF-04 is done, create `packages/agent/src/__tests__/streaming-run-failover.test.ts`:

Required scenarios:
1. First provider fails → second succeeds → verify `provider:run_selected` emitted
2. All providers fail → verify `lastError` thrown
3. `recordProviderSuccess` called after streaming success (regression test for CODE-006 bug)
4. `shouldRunStreamFailover = false` → no retry on non-retryable error

**Validate:** `yarn workspace @dzupagent/agent test --run streaming-run-failover`

---

## RF-11: Unify stuck detection under @dzupagent/core [AGENT-031/H-24]
**Target agent:** dzupagent-agent-dev

The agent package has a 5-mode `StuckDetector` (`packages/agent/src/guardrails/stuck-detector.ts`); the adapter guardrails has a separate 3-mode implementation (`packages/agent-adapters/src/guardrails/adapter-guardrails.ts`).

1. Move the canonical 5-mode `StuckDetector` to `packages/core/src/guardrails/stuck-detector.ts` and export from `packages/core/src/index.ts`
2. Extend `AdapterStuckDetector` in `agent-adapters` to be a thin wrapper around the core `StuckDetector` that adapts `AgentEvent` streams to `recordToolCall`/`recordError`/`recordIteration` calls
3. Delete the standalone `AdapterStuckDetector` class; replace with the wrapper

**Acceptance:** Parity test confirms both surfaces report identical detection for the same event sequence; agent tests and adapter tests all pass.

**Validate:** `yarn workspace @dzupagent/core test && yarn workspace @dzupagent/agent test && yarn workspace @dzupagent/agent-adapters test`

---

## RF-12: Add LLM-call audit log [AGENT-030/H-25]
**Target agent:** dzupagent-agent-dev

1. Create `packages/agent/src/observability/llm-call-audit.ts` with:
   ```typescript
   export interface LLMCallAuditEntry {
     runId: string; agentId: string; tenantId?: string; model: string
     prompt: string; completion: string; usage: TokenUsage; ts: Date
     success: boolean; error?: string
   }
   export interface LLMCallAuditStore {
     record(entry: LLMCallAuditEntry): Promise<void>
   }
   export class InMemoryAuditStore implements LLMCallAuditStore { ... }
   ```

2. Add `auditStore?: LLMCallAuditStore` to `DzupAgentConfig`

3. In `packages/agent/src/agent/run-engine.ts`, after each model invocation (both success and failure paths), call `config.auditStore?.record(...)` — fire-and-forget with local error swallow

**Acceptance:** Integration test with `InMemoryAuditStore` confirms every LLM call (successful + failed) produces an audit entry with correct fields.

**Validate:** `yarn workspace @dzupagent/agent test`

---

## RF-13: Decompose `executeWithFallback` (215 LOC) in adapter-registry [AGENT-056/M-10]
**Target agent:** dzupagent-connectors-dev

In `packages/agent-adapters/src/registry/adapter-registry.ts:251-466`, extract:

1. `runOneAttempt(adapter, input, attempt, signal)` — the per-attempt execution block
2. `setupAttemptTimeout(timeoutMs, baseSignal)` — timeout AbortController setup
3. `synthesizeFailureEvents(attempts, lastError)` — builds terminal failure event sequence

Target: `executeWithFallback` ≤80 LOC after extraction.

**Acceptance:** All adapter-registry tests pass; `executeWithFallback` ≤80 LOC.

**Validate:** `yarn workspace @dzupagent/agent-adapters test --run adapter-registry`

---

## RF-14: Add AdapterWorkflowBuilder execution helpers split [CODE-014]
**Target agent:** dzupagent-connectors-dev

In `packages/agent-adapters/src/workflow/adapter-workflow.ts` (1128 LOC), move the following to `packages/agent-adapters/src/workflow/adapter-workflow-execution.ts` (which already partially exists):

- `executeLoop(...)` (lines 887–943, 57 LOC)
- `executeAdapterStep(...)` (lines 943–1091, 149 LOC)
- `consumeAdapterEvents(...)` (lines 1091–1128, 38 LOC)

Extract the `build()` pipeline-assembly logic (lines 476–826, ~350 LOC) into a new `PipelineAssembler` class in `packages/agent-adapters/src/workflow/pipeline-assembler.ts`.

Target: `adapter-workflow.ts` ≤500 LOC.

**Acceptance:** All existing adapter-workflow tests pass; new files individually importable.

**Validate:** `yarn workspace @dzupagent/agent-adapters test`

---

## RF-15: Add prompt-injection scan on tool results path [AGENT-032]
**Target agent:** dzupagent-agent-dev

Currently, prompt-injection scanning (`ContentScanner`) runs only on incoming `HumanMessage` content and final write-back. Tool outputs are not scanned before entering the LLM context.

In `packages/agent/src/agent/run-engine.ts:259-307` (the tool result handling path), after receiving a tool result and before appending it to the message history:

1. If `config.scanToolResults !== false` and `contentScanner` is configured
2. Call `contentScanner.scan({ content: result.output, type: 'tool_result', toolName })` 
3. On `BLOCK` verdict: emit `safety:tool_result_blocked` event and replace tool result with a safe placeholder
4. On `WARN` verdict: emit `safety:tool_result_warning` event and continue with the original result

**Acceptance:** Test with a tool that returns a prompt-injection payload (e.g. `"Ignore previous instructions and..."`); verify that `scanToolResults` mode `'block'` prevents it from entering context.

**Validate:** `yarn workspace @dzupagent/agent test`
