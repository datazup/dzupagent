# CODE-AUDIT: @dzupagent/agent + @dzupagent/agent-adapters

**Date:** 2026-05-03  
**Auditor:** Claude (automated deep-dive)  
**Scope:** `packages/agent` (397 .ts files) + `packages/agent-adapters` (289 .ts files)  
**Baseline:** 0 TS errors, 0 lint warnings before this audit

---

## Summary

| Severity | Count |
|---|---|
| P1 (Critical) | 5 |
| P2 (High) | 10 |
| P3 (Medium) | 9 |
| P4 (Low) | 4 |
| **Total** | **28** |

---

## Findings

---

### C-01: `as never` cast on every `DzupEventBus.emit()` call in agent core

**Severity:** P1  
**Files:**
- `packages/agent/src/agent/tool-lifecycle-policy.ts:130,180,242,288`
- `packages/agent/src/agent/dzip-agent.ts:494`
- `packages/agent/src/agent/run-engine.ts:630,784`
- `packages/agent/src/agent/streaming-run.ts:145`
- `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:116,261,433,448`
- `packages/agent/src/approval/approval-gate.ts:83,139,156`

**Pattern:** Every call to `eventBus.emit({ type: '...', ... })` in these files uses `} as never)` to bypass the TypeScript discriminated-union type check. The objects being emitted are structurally valid at runtime, but the cast hides two real problems: (1) some emitted shapes include extra fields (`output`, `errorMessage`, `status: 'success'`) that are not in the `DzupEvent` union variants, and (2) future changes to the union can silently break the emit payload without a TS error.

**Fix effort:** 2-4h  
**Fix:** Extend the relevant `DzupEvent` union variants in `packages/core/src/events/event-types.ts` to include the missing optional fields (`output?: unknown`, `errorMessage?: string` on `tool:result`/`tool:error`, `status: 'success'` on `tool:result`). Once the type union accepts these shapes, remove all `as never` casts. The affected payloads are already correct at runtime; this is purely a type gap.

---

### C-02: `as unknown as X` unsafe casts at runtime boundaries — registry and event-bus bridges

**Severity:** P1  
**Files:**
- `packages/agent/src/agent/dzip-agent.ts:443` — `registry as unknown as { getModelFallbackCandidates: ... }`
- `packages/agent/src/agent/mailbox/agent-mailbox.ts:91,93` — `rateLimiter as unknown as { maxMessages?: number }`
- `packages/agent/src/orchestration/delegating-supervisor.ts:552` — `event as unknown as Parameters<DzupEventBus['emit']>[0]`
- `packages/agent-adapters/src/facade/orchestrator-facade.ts:864` — `event as unknown as DzupEvent`
- `packages/agent-adapters/src/registry/event-bus-bridge.ts:185` — `} as unknown as DzupEvent`
- `packages/agent-adapters/src/output/structured-output.ts:741` — `event as unknown as Parameters<DzupEventBus['emit']>[0]`
- `packages/agent-adapters/src/persistence/run-manager.ts:358` — same pattern
- `packages/agent-adapters/src/session/session-registry.ts:527` — same pattern

**Pattern:** `as unknown as T` is a double-cast that completely bypasses TypeScript's type system. In `dzip-agent.ts:443` the `ModelRegistry` interface does not expose `getModelFallbackCandidates`, so the cast hides a missing API contract. In the event-bus bridges the cast papers over an impedance mismatch between adapter-local event shapes and the `DzupEvent` union.

**Fix effort:** 2-4h  
**Fix:** For the registry cast: add `getModelFallbackCandidates` to the `ModelRegistry` interface in `@dzupagent/core` (it is already implemented — the type just doesn't declare it). For the event-bus casts: see C-01 — fixing the union type resolves these casts as a side-effect. For the `rateLimiter` cast in `agent-mailbox.ts`: add a typed `RateLimiter` interface that exposes `maxMessages` and `windowMs`.

---

### C-03: `executeStreamingToolCall` is a 396-line god function with 7-level nesting

**Severity:** P1  
**File:** `packages/agent/src/agent/run-engine.ts:523–919`

**Pattern:** The single exported function `executeStreamingToolCall` is 396 lines long and contains the entire streaming-tool lifecycle: permission checks, budget gating, governance access, tool arg validation, timeout wiring, tool invocation, result scanning, OTel span management, approval-pending path, and `ToolMessage` construction. Nesting reaches 7 levels deep (lines 759–766) inside the result-scan block. The function is not tested directly — its coverage is only incidental via integration-level tests through `streamRun`.

**Fix effort:** 4-8h  
**Fix:** Extract into a pipeline of smaller functions following the existing `emitToolCalled` / `emitToolResult` decomposition pattern already used by `tool-lifecycle-policy.ts`:
1. `checkToolAccess(...)` — permission + governance block check (lines 556–640)
2. `runToolWithTimeout(...)` — invocation + timeout wiring (lines 641–720)
3. `scanAndFilterResult(...)` — result scanner + span (lines 721–810)
4. Keep `executeStreamingToolCall` as a thin orchestrator calling those three. Each extracted function is independently unit-testable.

---

### C-04: `executeWithRecovery` and `executeWithRecoveryStream` are 441/449-line near-duplicates

**Severity:** P1  
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:359–800` and `801–1250`

**Pattern:** The two methods share the same retry loop, backoff, trace recording, failure-context construction, strategy selection, escalation, and event emission logic. `diff` shows that the streaming variant inlines all 149 lines of the decomposed `runRecoveryAttempt`/`handleAttemptFailure` helpers used by the non-streaming variant, meaning changes to recovery logic must be applied in two places. The file is already 1250 lines.

**Fix effort:** 4-8h  
**Fix:** Extract the shared recovery loop into a private helper that takes a `tryOnce: (attempt: RecoveryLoopState) => AsyncGenerator<AgentEvent> | Promise<RecoverySuccessResult>` callback. Both public methods become thin wrappers that pass their adapter-execute call as the callback. The `RecoveryLoopState` struct is already defined and threaded through the non-streaming path — use it in the streaming path too.

---

### C-05: `daemon-launcher.ts` fires a floating `void journal.append(...)` write

**Severity:** P1  
**File:** `packages/agent/src/agent/daemon-launcher.ts:51`

**Pattern:** The `run_started` journal entry is written with `void journal.append(...)` (fire-and-forget). If the journal write fails (e.g., storage error) the run continues with no `run_started` record. Resume operations that depend on the journal for message-history reconstruction (`rehydrateMessagesFromJournal`) will silently fall back to the raw `prepareMessages` path, silently losing the resume context. There is no test for this file.

**Fix effort:** 1h  
**Fix:** `await journal.append(runId, { type: 'run_started', ... })` before starting background execution. If the journal write must be non-blocking, catch and log the error explicitly rather than discarding it.

---

### H-01: `ProviderAdapterRegistry` has 21 public methods — god-object surface

**Severity:** P2  
**File:** `packages/agent-adapters/src/registry/adapter-registry.ts:98–750`

**Pattern:** The class combines adapter lifecycle management (`register`, `unregister`, `disable`, `enable`, `isEnabled`, `registerProductionAdapters`, `registerExperimentalAdapters`), routing (`getForTask`, `setRouter`), execution with fallback (`executeWithFallback`, `executeWithFallbackWithRaw` — 207 lines combined), health monitoring (`getHealthStatus`, `getDetailedHealth` — 80 lines combined), circuit-breaker accounting (`recordSuccess`, `recordFailure`), session management (`respondInteraction`), observability (`warmupAll`, `setEventBus`), and admin (`listAdapters`). The `executeWithFallbackWithRaw` method alone is 207 lines. The class has 21 public methods plus private helpers.

**Fix effort:** 4-8h  
**Fix:** Extract `RegistryHealthMonitor` (health/circuit-breaker state) and `RegistryFallbackExecutor` (the fallback-chain execution loop) as separate internal classes composed by `ProviderAdapterRegistry`. The registry retains the adapter map and delegation. The split reduces each class to ≤10 public methods and makes `executeWithFallbackWithRaw` independently testable.

---

### H-02: `TeamCoordinator` (playground) and `TeamRuntime` (orchestration) both exported and overlap

**Severity:** P2  
**Files:**
- `packages/agent/src/playground/team-coordinator.ts:31–495` (495 lines, exported at `index.ts:384`)
- `packages/agent/src/orchestration/team/team-runtime.ts:269–1281` (1281 lines, exported at `index.ts`)

**Pattern:** Both classes implement `supervisor`, `peer-to-peer`/`peer_to_peer`, and `blackboard` coordination patterns by calling the same underlying `AgentOrchestrator.supervisor(...)`. The playground coordinator uses `CoordinationPattern` (with `-` separators), the team-runtime uses `CoordinatorPattern` (with `_` separators). Consumers face two APIs for the same patterns. `TeamCoordinator` requires a pre-built `Map<string, SpawnedAgent>` while `TeamRuntime` uses a `ParticipantResolver` — but the core loops and `AgentOrchestrator` calls are near-identical.

**Fix effort:** 4-8h  
**Fix:** Mark `TeamCoordinator` as `@deprecated` in its JSDoc and in `index.ts`. Add a one-paragraph migration note pointing consumers to `TeamRuntime`. The playground coordinator is a thin wrapper — a migration shim (2 exported functions: `runSupervisor`, `runPeerToPeer`, `runBlackboard`) wrapping `TeamRuntime` can satisfy current callers. Remove in the next major version.

---

### H-03: `skill compiler validate()` body duplicated across three files

**Severity:** P2  
**Files:**
- `packages/agent-adapters/src/skills/compilers/claude-skill-compiler.ts:62–85`
- `packages/agent-adapters/src/skills/compilers/codex-skill-compiler.ts:45–56`
- `packages/agent-adapters/src/skills/compilers/cli-skill-compiler.ts:80–120`

**Pattern:** All three `validate()` implementations share identical boilerplate checks:
```ts
if (compiled.providerId !== this.providerId) { errors.push('Expected providerId...') }
if (typeof compiled.runtimeConfig['systemPrompt'] !== 'string') { errors.push('Missing...systemPrompt') }
if (!compiled.hash || typeof compiled.hash !== 'string') { errors.push('Missing...hash') }
if (!compiled.projectionVersion || typeof compiled.projectionVersion !== 'string') { errors.push('Missing...projectionVersion') }
```
The CLI compiler adds provider-specific warnings on top of this base. A new compiler must re-copy this boilerplate.

**Fix effort:** 2-4h  
**Fix:** Extract `validateCompiledSkillBase(compiled: CompiledAdapterSkill): string[]` into `compiler-utils.ts`. Each compiler's `validate()` calls `validateCompiledSkillBase(compiled)` and appends its own checks. This is already the pattern used by `buildSystemPrompt` and `deterministicHash` in that file.

---

### H-04: `token-usage extraction` duplicated in `claude-adapter.ts` and `codex-adapter.ts`

**Severity:** P2  
**Files:**
- `packages/agent-adapters/src/claude/claude-adapter.ts:147–159` (`extractTokenUsage`)
- `packages/agent-adapters/src/codex/codex-adapter.ts:207–216` (`toTokenUsage`)

**Pattern:** Both functions map a raw SDK usage object `{ input_tokens, output_tokens, cached_input_tokens }` to the canonical `TokenUsage` type. The logic is structurally identical; the functions differ only in their handling of the `cost_cents` field (Claude includes it, Codex does not). Both are file-private helpers.

**Fix effort:** 1h  
**Fix:** Add `extractTokenUsage(usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; cost_cents?: number } | undefined): TokenUsage | undefined` to `packages/agent-adapters/src/utils/provider-event-normalization.ts` (the shared normalization util that already normalises provider events). Replace both private functions with imports.

---

### H-05: `normalizeCodex` (140 lines) and `normalizeClaude` (124 lines) in `normalize.ts` — inlined switch dispatch

**Severity:** P2  
**File:** `packages/agent-adapters/src/normalize.ts:90–215` and `214–355`

**Pattern:** Each per-provider normalize function is a large `switch` or `if/else if` block handling 8–12 event types. Adding support for a new event type on any provider requires scanning 100+ lines of inline logic mixed with field access helpers. The `getFirstChoice`/`getOpenAIChoiceMessageContent` helpers at lines 486–501 are only used by `normalizeOpenAI` but live at file scope.

**Fix effort:** 4-8h  
**Fix:** Split into `normalize/claude.ts`, `normalize/codex.ts`, `normalize/openai.ts`, `normalize/gemini.ts` — each exporting a single `normalize(raw, provider)` function and its private helpers. The top-level `normalize.ts` becomes a 40-line router that imports and dispatches. This is the pattern already used by the `pipeline-runtime/` subdirectory.

---

### H-06: `playground/ui/utils.ts` (462 lines) is never imported outside of its own tests

**Severity:** P2  
**Files:**
- `packages/agent/src/playground/ui/utils.ts` (462 lines)
- `packages/agent/src/playground/ui/types.ts`
- `packages/agent/src/playground/ui/index.ts`

**Pattern:** The `playground/ui/` sub-module exports 20+ functions and types (`traceUiStyles`, `traceToneStyles`, `getTraceStatusTone`, etc.), all of which are marked `@deprecated` in the `index.ts` docblock and explicitly null-exported in `package.json` (`"./playground/ui": null`). The only imports are from source-internal maintenance tests (`playground-ui-utils.test.ts`). No consumer in the broader monorepo references these exports (confirmed by monorepo-wide grep). These files ship in the compiled output but serve no consumer.

**Fix effort:** 2-4h  
**Fix:** Delete `packages/agent/src/playground/ui/utils.ts`, `types.ts`, and `index.ts`. Delete the corresponding test file `src/__tests__/playground-ui-utils.test.ts`. Remove the `"./playground/ui"` null entries from `package.json`. The exports do not appear in `index.ts`'s public surface (already null-pathed), so there is no breaking change.

---

### H-07: `void _draftDuration` and `void revisionStart` — suppressed timing variables with no purpose

**Severity:** P2  
**File:** `packages/agent/src/self-correction/reflection-loop.ts:232–233` and `310,320`

**Pattern:**
```ts
const _draftDuration = Date.now() - draftStart   // line 232
void _draftDuration                                // line 233

const revisionStart = Date.now()                   // line 310
// ... code that uses revisionStart to compute cost ...
void revisionStart                                 // line 320
```
`_draftDuration` is computed and immediately discarded — the draft generation duration is never used in metrics, history, or telemetry. `revisionStart` is similarly captured but then the value is discarded via `void`. This suggests intended-but-unfinished per-iteration timing instrumentation.

**Fix effort:** 1h  
**Fix:** Either (a) wire both values into the `IterationRecord` that is pushed to `history[]` so per-iteration timing appears in `ReflectionLoopResult.history`, or (b) remove the dead assignments entirely if timing is not required. Do not suppress via `void`.

---

### H-08: `mailbox/agent-mailbox.ts` — `void handler(event.message)` swallows async handler errors

**Severity:** P2  
**File:** `packages/agent/src/mailbox/agent-mailbox.ts:136`

**Pattern:**
```ts
return this.eventBus.on('mail:received', (event) => {
  if (event.message.to === this.agentId) {
    void handler(event.message as MailMessage)   // ← unhandled rejection
  }
})
```
When a subscriber's async `handler` throws, the rejection is silently swallowed. The `subscribe` API signature says the handler can return `Promise<void>`, but there is no mechanism to surface errors to the caller. Additionally, `event.message as MailMessage` uses a widening cast — `event.message` is already typed but the cast hides whether the `MailMessage` type is actually assignable.

**Fix effort:** 1h  
**Fix:** Wrap the `void handler(...)` in `.catch((err) => this.config.onError?.(err) ?? console.error('[AgentMailbox] subscriber error', err))`. Add an optional `onError?: (err: unknown) => void` to the mailbox config. Remove the redundant `as MailMessage` cast.

---

### H-09: `policy-enabled-tool-executor.ts` (453 lines) has zero direct test coverage

**Severity:** P2  
**File:** `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts`

**Pattern:** `executePolicyEnabledToolCall` (lines 39–376) is the central function that enforces governance, permission, arg-validation, timeout, result-scanning, and OTel spans for the non-streaming tool path. It is tested only indirectly through `tool-loop.ts` integration tests. No test file imports it directly. The function is 337 lines long with at least 6 independent decision branches (governance block, permission deny, budget block, arg-validation failure, result-scan block, tool-timeout), none of which have isolated unit tests.

**Fix effort:** 4-8h  
**Fix:** Add `src/__tests__/policy-enabled-tool-executor.test.ts` covering: (a) governance block → returns `[blocked: <reason>]`, (b) permission deny → throws `TOOL_PERMISSION_DENIED`, (c) budget block → returns `[blocked by budget]`, (d) arg validation failure → returns error `ToolMessage`, (e) result scan block → returns blocked content, (f) OTel span opened/closed on success. Use the existing `FakeTool` + `mockEventBus` helpers from `tool-loop-telemetry.test.ts`.

---

### H-10: `daemon-launcher.ts` and `structured-generate.ts` have zero test coverage

**Severity:** P2  
**Files:**
- `packages/agent/src/agent/daemon-launcher.ts` (no test exists anywhere)
- `packages/agent/src/agent/structured-generate.ts` (no dedicated test; only incidental coverage via `dzip-agent.test.ts`)

**Pattern:** `daemon-launcher.ts` implements `launch()` — the primary async-background-run entry point that creates `RunHandle` and wires the journal. It has no test at all. `structured-generate.ts:54` exports `generateStructured<T>()` which is the typed output path (schema parsing, retry on parse failure, usage merging) — tested only via high-level `dzip-agent.test.ts`, not its retry/fallback branches.

**Fix effort:** 4-8h  
**Fix:**
- `daemon-launcher.test.ts`: test that `launch()` returns a `RunHandle`, that the journal receives a `run_started` entry, and that the handle's `_fail` is called when `runInBackground` throws.
- `structured-generate.test.ts`: test the retry-on-parse-failure branch (mocked LLM returns invalid JSON on first call, valid on second), the `extractJsonFromText` code-fence stripping, and the usage-merging path.

---

### M-01: `team-runtime.ts` is 1281 lines — 5 coordination-pattern methods inline all orchestration logic

**Severity:** P3  
**File:** `packages/agent/src/orchestration/team/team-runtime.ts`

**Pattern:** The five private pattern methods (`runSupervisor` lines 623–690, `runContractNet` lines 691–758, `runBlackboard` lines 759–899, `runPeerToPeer` lines 900–973, `runCouncil` lines 974–1040) each inline their full orchestration logic. `runBlackboard` is 140 lines with 3-round loop management. `runCouncil` is 66 lines that constructs a `ContractNetManager` inline. The circuit-breaker helper (`mapSettledWithConcurrency`) lives at line 1221 — far from where it is called.

**Fix effort:** 1-2d  
**Fix:** Extract each pattern into a dedicated strategy class in `orchestration/team/strategies/`: `SupervisorStrategy`, `ContractNetStrategy`, `BlackboardStrategy`, `PeerToPeerStrategy`, `CouncilStrategy` — each implementing `TeamStrategy { execute(task, runId, spawned, ...): Promise<TeamRunResult> }`. `TeamRuntime.execute()` becomes a dispatcher. This is the Strategy pattern and reduces `team-runtime.ts` to <400 lines.

---

### M-02: `pipeline-runtime.ts` — `execute()` and `resume()` share a 120-line common tail that is copy-pasted

**Severity:** P3  
**File:** `packages/agent/src/pipeline/pipeline-runtime.ts:130–259`

**Pattern:** Both `execute()` (lines 130–175) and `resume()` (lines 176–259) end with the same error-handling block:
```ts
} catch (err) {
  const errorMessage = err instanceof Error ? err.message : String(err)
  this.state = 'failed'
  this.emit(pipelineFailedEvent(runId, errorMessage))
  return { pipelineId, runId, state: 'failed', nodeResults, totalDurationMs }
}
```
Both methods call `this.executeFromNode(...)` with slightly different args and then apply identical completion/failure returns. The error branch is also replicated inside `executeFromNode` (lines 247–258) creating a third copy.

**Fix effort:** 2-4h  
**Fix:** Extract a private `runFromNodeOrFail(runId, startNodeId, runState, nodeResults, completedNodeIds, versionTracker, startTime): Promise<PipelineRunResult>` that wraps `executeFromNode` with the shared error handling. Both `execute()` and `resume()` call it, reducing duplication to zero.

---

### M-03: `md-frontmatter-parser.ts` — three `void parts; void lastIndex; void lastHeading` dead suppressions

**Severity:** P3  
**File:** `packages/agent-adapters/src/dzupagent/md-frontmatter-parser.ts:258–260`

**Pattern:**
```ts
void parts
void lastIndex
void lastHeading
```
These three identifiers are declared in the enclosing scope but are never used in the section-splitting logic that follows (lines 245–262). The `void` expressions suppress the "unused variable" warning without removing the variables, leaving dead state in the function.

**Fix effort:** 1h  
**Fix:** Remove the three `void` lines and the corresponding variable declarations (`parts`, `lastIndex`, `lastHeading`) if they are indeed unused. If they were placeholders for a refactor in progress, add a `// TODO` comment explaining the intent.

---

### M-04: `self-correction/reflection-loop.ts` swallows the entire iteration error with an empty `catch {}`

**Severity:** P3  
**File:** `packages/agent/src/self-correction/reflection-loop.ts:234,256,321`

**Pattern:** Three `catch { exitReason = 'error'; break }` blocks (lines 234, 256, 321) swallow all errors during draft generation, scoring, and revision without logging or forwarding error detail. Callers receive `{ exitReason: 'error' }` with no indication of what failed. Distinguishing a model API error from a JSON parse error from a budget error is impossible post-hoc.

**Fix effort:** 1h  
**Fix:** Capture the error and include it in the result: `catch (err: unknown) { lastError = err instanceof Error ? err : new Error(String(err)); exitReason = 'error'; break }`. Add `lastError?: Error` to `ReflectionLoopResult`. Emit the error via `this.config.onError?.(lastError)` if configured.

---

### M-05: `run-engine.ts` approval event uses `as never` — `approval:requested` payload mismatch

**Severity:** P3  
**File:** `packages/agent/src/agent/run-engine.ts:624–638`

**Pattern:**
```ts
policy.eventBus?.emit({
  type: 'approval:requested',
  runId: correlationId,
  plan: { toolName, args: toolCall.args },
} as never)
```
The `DzupEvent` union variant for `approval:requested` requires `plan: unknown`, `runId: string`, and optionally `contactId`, `channel`, `request`. The emitted shape is structurally compatible but the `as never` hides it. Additionally, the `runId` here is set to `policy.runId ?? toolCallId` — using a `toolCallId` string as a run ID is semantically incorrect.

**Fix effort:** 1h  
**Fix:** Remove `as never`. Set `runId: policy.runId ?? ''` and pass `toolCallId` via the optional `request` field: `request: { toolCallId, toolName }`. This aligns with the `approval:requested` event contract in `event-types.ts:189`.

---

### M-06: `adapter-recovery.ts` — `executeWithRecoveryStream` inlines 150-line recovery logic already decomposed in `executeWithRecovery`

**Severity:** P3  
**File:** `packages/agent-adapters/src/recovery/adapter-recovery.ts:801–1250`

**Pattern:** Already noted in C-04. The structural duplication spans 449 lines. The streaming method re-implements the `runRecoveryAttempt` + `handleAttemptFailure` internal helpers inline instead of extracting a shared abstract loop. The `RecoveryLoopState` type (lines 296–301) exists but is only used in the non-streaming path.

**Fix effort:** 4-8h (tied to C-04 fix)  
**Fix:** See C-04. Once the shared loop is extracted, `executeWithRecoveryStream` becomes a 30-line wrapper.

---

### M-07: `UCL skill-loader` (`ucl/skill-loader.ts`) has zero test coverage

**Severity:** P3  
**File:** `packages/agent-adapters/src/ucl/skill-loader.ts`

**Pattern:** The UCL (Unified Capability Layer) `skill-loader` module is responsible for loading `.dzupagent/skills/*.md` files into `AdapterSkillBundle` objects. No test file imports it or exercises its loading, parsing, or error paths. The `dzupagent/` parallel (which is tested) uses a different parsing path; the UCL loader has its own frontmatter and section handling.

**Fix effort:** 2-4h  
**Fix:** Add `src/__tests__/ucl-skill-loader.test.ts` covering: (a) loading a single skill from a mock file system, (b) handling missing `frontmatter`, (c) handling a corrupted YAML block, (d) returning an empty array when the skills directory does not exist.

---

### M-08: `AgentMailbox` module (`mailbox/`) has zero test coverage

**Severity:** P3  
**Files:**
- `packages/agent/src/mailbox/agent-mailbox.ts`
- `packages/agent/src/mailbox/rate-limiter.ts`
- `packages/agent/src/mailbox/mail-tools.ts`
- `packages/agent/src/mailbox/in-memory-mailbox-store.ts`
- `packages/agent/src/mailbox/dead-letter-store.ts`

**Pattern:** The entire `mailbox/` sub-module — send, receive, subscribe, dead-letter queue, rate limiting — has no tests. `AgentMailbox` is exported from `index.ts` and is part of the `DzupAgentConfig.mailbox` configuration surface. The dead-letter path (lines 160–178 in `agent-mailbox.ts`) is completely exercised only by the DLQ flush path, which has no test.

**Fix effort:** 4-8h  
**Fix:** Add `src/__tests__/agent-mailbox.test.ts` covering: send, receive, subscribe (sync + async handler), dead-letter queue overflow, rate-limiting rejection, and the `void handler(...)` error path from H-08's fix.

---

### M-09: `streamRun` in `streaming-run.ts` is 422 lines — the non-streaming fallback and streaming paths are not independently testable

**Severity:** P3  
**File:** `packages/agent/src/agent/streaming-run.ts:215–637`

**Pattern:** `streamRun` is an exported async generator that first checks whether the model supports native streaming; if not, it falls back to `executeGenerateRun` and yields synthetic events. This non-streaming fallback is ~80 lines inside the generator that is never tested in isolation — tests always use a streaming model. The streaming path itself goes through a 300-line loop handling tool calls, chunk buffering, and usage tracking. The function has three observable termination paths (`stopReason`, `hitIterationLimit`, cancellation) but tests cover only the happy path.

**Fix effort:** 4-8h  
**Fix:** Extract `runWithNonStreamingFallback(ctx, runState, options)` (the `if (!('stream' in model))` branch, ~80 lines) and `runStreamingLoop(ctx, stream, runState, options)` (the main chunk loop, ~200 lines) as private functions called by `streamRun`. Add tests for the fallback branch using a model stub that lacks `.stream`, and for the streaming loop's cancellation and tool-call paths.

---

### L-01: `reflection-loop.ts` — `void revisionStart` / `void _draftDuration` are unfinished timing probes

**Severity:** P4  
**File:** `packages/agent/src/self-correction/reflection-loop.ts:233,320` (also covered in H-07)

**Pattern:** These variables were clearly intended to measure per-iteration latency (draft generation time and revision time). They are assigned but never used. Marking as Low because the correctness impact is zero (they are purely local variables) but the code reads confusingly.

**Fix effort:** 1h  
**Fix:** See H-07.

---

### L-02: `void iterate()` in `claude-adapter.ts` without error handling

**Severity:** P4  
**File:** `packages/agent-adapters/src/claude/claude-adapter.ts:631`

**Pattern:**
```ts
void iterate()
```
The `iterate` function is the inner async loop of `forkSession()`. Rejections from `iterate()` are swallowed. The enclosing `new Promise<ForkSessionResult>((resolve, reject) => {...})` is closed by this point (line 640 calls `resolve`), so a thrown error from `iterate` after resolution has no channel to surface.

**Fix effort:** 1h  
**Fix:** Add `.catch((err) => { if (!settled) reject(err) })` — where `settled` is a boolean flipped to `true` when the outer `Promise` resolves or rejects. This pattern is used correctly in the `daemon-launcher.ts` background runner.

---

### L-03: `contract-net.ts` — `void bidPromise.then(() => { clearTimeout(handle) })` is redundant

**Severity:** P4  
**File:** `packages/agent-adapters/src/orchestration/contract-net.ts:441`

**Pattern:**
```ts
void bidPromise.then(() => { clearTimeout(handle) })
```
The `Promise.race([bidPromise, timeoutPromise])` at line 444 already resolves to whichever settles first. If `bidPromise` wins the race, the `finally` block on the outer `try` does NOT clear the timeout (there is no outer `finally`). The `void .then()` is attempting to clear the timeout outside the race, but it fires after the race has already returned, creating a memory leak if `bidPromise` rejects (the `.then` never runs, the handle stays alive). 

**Fix effort:** 1h  
**Fix:** Replace the pattern with:
```ts
try {
  return await Promise.race([bidPromise, timeoutPromise])
} finally {
  clearTimeout(handle)
}
```

---

### L-04: `file-loader.ts` — three `void watchDir(...)` calls without error propagation

**Severity:** P4  
**File:** `packages/agent-adapters/src/dzupagent/file-loader.ts:295,297,299`

**Pattern:**
```ts
void watchDir(join(this.paths.globalDir, 'skills'))
void watchDir(join(this.paths.workspaceDir, 'skills'))
void watchDir(join(this.paths.projectDir, 'skills'))
```
The `watchDir` function contains a `try/catch { /* Directory may not exist — ignore */ }` internally, so unhandled rejections are already suppressed. The `void` casts are therefore defensive-but-redundant. However, using `void` on a function that itself swallows errors makes the intent opaque to future maintainers.

**Fix effort:** <1h  
**Fix:** No correctness change needed. Add a brief inline comment explaining that `watchDir` already handles directory-not-found errors internally, so the `void` is intentional for fire-and-forget lifecycle semantics.

---

## Quick Fix Prompts (P1 — under 2h each)

---

### PROMPT-C01: Fix `as never` casts on `DzupEventBus.emit()` calls

**Finding:** C-01  
**Target files:**
- `packages/core/src/events/event-types.ts` — extend the `tool:result` and `tool:error` union variants
- `packages/agent/src/agent/tool-lifecycle-policy.ts:130,180,242,288`
- `packages/agent/src/agent/dzip-agent.ts:494`
- `packages/agent/src/agent/run-engine.ts:630,784`
- `packages/agent/src/agent/streaming-run.ts:145`
- `packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:116,261,433,448`
- `packages/agent/src/approval/approval-gate.ts:83,139,156`

**What to change:**
1. In `event-types.ts`, add to the `tool:result` variant: `output?: unknown` (optional, for audit consumers).
2. Add `errorMessage?: string` and `status?: 'error' | 'timeout' | 'denied' | 'cancelled'` to `tool:error` (they are already optional in the type — verify and confirm).
3. Remove all `} as never)` casts, replacing with `})` in each call site.
4. Run `yarn typecheck --filter=@dzupagent/agent --filter=@dzupagent/agent-adapters --filter=@dzupagent/core` — expect 0 errors.

**Acceptance criteria:**
- Zero `as never` casts on `eventBus.emit(...)` calls
- `yarn typecheck` passes with 0 errors
- No runtime behaviour changes

**Validation command:**
```bash
grep -rn "as never" packages/agent/src packages/agent-adapters/src --include="*.ts" | grep -v ".test.ts"
yarn typecheck --filter=@dzupagent/agent --filter=@dzupagent/agent-adapters
```

---

### PROMPT-C05: Fix floating `void journal.append()` in `daemon-launcher.ts`

**Finding:** C-05  
**Target file:** `packages/agent/src/agent/daemon-launcher.ts:51`

**What to change:**
1. Change `void journal.append(runId, { ... })` to `await journal.append(runId, { ... })`.
2. The enclosing function `launch()` already returns `Promise<RunHandle>` — the `await` is safe.
3. Wrap in a `try/catch` that calls `handle._fail(message)` if the journal write fails, consistent with the existing error handling on line 62.

**Acceptance criteria:**
- `journal.append()` is awaited before background execution starts
- A failed journal write causes `handle._fail(...)` to be called
- `yarn typecheck --filter=@dzupagent/agent` passes

**Validation command:**
```bash
grep -n "void journal.append" packages/agent/src/agent/daemon-launcher.ts
yarn typecheck --filter=@dzupagent/agent
yarn test --filter=@dzupagent/agent -- --testPathPattern=daemon
```

---

### PROMPT-H07: Remove dead timing variables in `reflection-loop.ts`

**Finding:** H-07  
**Target file:** `packages/agent/src/self-correction/reflection-loop.ts:232–233,310,320`

**What to change:**
1. Either:
   - **Option A (instrument):** Add `draftDurationMs` and `revisionDurationMs` fields to the `IterationRecord` interface. Populate them from the computed values. Remove the `void` suppression lines.
   - **Option B (delete):** Remove `const _draftDuration = ...` (line 232), `void _draftDuration` (line 233), and `void revisionStart` (line 320). Keep `const revisionStart = Date.now()` only if it is actually used (it is not — confirm and delete if so).

**Acceptance criteria:**
- No `void _draftDuration` or `void revisionStart` in the file
- `yarn typecheck --filter=@dzupagent/agent` passes
- `yarn test --filter=@dzupagent/agent -- --testPathPattern=reflection-loop` passes

**Validation command:**
```bash
grep -n "void _draftDuration\|void revisionStart" packages/agent/src/self-correction/reflection-loop.ts
yarn test --filter=@dzupagent/agent -- --testPathPattern=reflection-loop
```

---

### PROMPT-H08: Fix `void handler(...)` in `AgentMailbox.subscribe()`

**Finding:** H-08  
**Target file:** `packages/agent/src/mailbox/agent-mailbox.ts:136`

**What to change:**
1. Add `onError?: (err: unknown) => void` to `AgentMailboxConfig` (in `agent-types.ts` or `mailbox/types.ts`).
2. Change line 136 from:
   ```ts
   void handler(event.message as MailMessage)
   ```
   to:
   ```ts
   Promise.resolve(handler(event.message as MailMessage)).catch((err) => {
     this.config.onError?.(err)
   })
   ```
3. Remove the redundant `as MailMessage` cast — `event.message` should already have the correct type from the event bus listener.

**Acceptance criteria:**
- Async handler errors are surfaced via `config.onError` (if set)
- `as MailMessage` cast removed
- `yarn typecheck --filter=@dzupagent/agent` passes

**Validation command:**
```bash
grep -n "void handler" packages/agent/src/mailbox/agent-mailbox.ts
yarn typecheck --filter=@dzupagent/agent
```

---

### PROMPT-L03: Fix `contract-net.ts` timeout-handle leak

**Finding:** L-03  
**Target file:** `packages/agent-adapters/src/orchestration/contract-net.ts:436–453`

**What to change:**
Replace:
```ts
void bidPromise.then(() => { clearTimeout(handle) })
try {
  return await Promise.race([bidPromise, timeoutPromise])
} catch (err) { ... }
```
With:
```ts
try {
  return await Promise.race([bidPromise, timeoutPromise])
} catch (err) {
  ...
} finally {
  clearTimeout(handle)
}
```
Remove the `void bidPromise.then(...)` line.

**Acceptance criteria:**
- `clearTimeout(handle)` is always called (success + error path)
- No `void .then(...)` on `bidPromise`
- `yarn typecheck --filter=@dzupagent/agent-adapters` and test suite pass

**Validation command:**
```bash
grep -n "void bidPromise" packages/agent-adapters/src/orchestration/contract-net.ts
yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=contract-net
```

---

## Refactor Prompts (P2 — 4-8h each)

---

### PROMPT-H01: Split `ProviderAdapterRegistry` (21 public methods)

**Finding:** H-01  
**Target file:** `packages/agent-adapters/src/registry/adapter-registry.ts`

**What to change:**
1. Create `packages/agent-adapters/src/registry/registry-health-monitor.ts` — extract `recordSuccess`, `recordFailure`, `getHealthStatus`, `getDetailedHealth`, circuit-breaker state (`breakers`, `consecutiveFailures`, `lastSuccess`). Expose as `RegistryHealthMonitor`.
2. Create `packages/agent-adapters/src/registry/registry-fallback-executor.ts` — extract `executeWithFallback`, `executeWithFallbackWithRaw`, `buildFallbackOrder`, `buildRoutingProgressEvent`, `buildAttemptProgressEvent` (the whole fallback loop). Expose as `RegistryFallbackExecutor`.
3. `ProviderAdapterRegistry` retains: `register`, `unregister`, `disable/enable/isEnabled`, `get/getHealthy/listAdapters`, `getForTask`, `setRouter`, `setEventBus`, `warmupAll`, `respondInteraction`. Compose `RegistryHealthMonitor` and `RegistryFallbackExecutor` via constructor injection (pass the adapter map reference).
4. Re-export both new classes from `src/index.ts` for testing.

**Acceptance criteria:**
- `ProviderAdapterRegistry` has ≤12 public methods
- All existing tests in `adapter-registry*.test.ts` still pass
- `executeWithFallbackWithRaw` is independently importable for unit testing

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=adapter-registry
yarn typecheck --filter=@dzupagent/agent-adapters
```

---

### PROMPT-H02: Deprecate `TeamCoordinator` in favour of `TeamRuntime`

**Finding:** H-02  
**Target files:**
- `packages/agent/src/playground/team-coordinator.ts`
- `packages/agent/src/index.ts:384`

**What to change:**
1. Add `@deprecated Use TeamRuntime from orchestration/team/team-runtime.ts instead.` JSDoc to `TeamCoordinator` class.
2. Update `index.ts:384` export:
   ```ts
   /** @deprecated Use {@link TeamRuntime} instead */
   export { TeamCoordinator } from './playground/team-coordinator.js'
   ```
3. Add a migration shim in `team-coordinator.ts` that wraps `TeamRuntime` for the three supported patterns (`supervisor`, `peer-to-peer`, `blackboard`), so existing consumers can migrate without code changes by switching from `TeamCoordinator` to `TeamRuntime` with a `ParticipantResolver` adapter.
4. Add `MIGRATION_GUIDE.md` inline comment at the top of `team-coordinator.ts`.

**Acceptance criteria:**
- `TeamCoordinator` is marked deprecated
- Existing tests pass
- `TeamRuntime` supports equivalent functionality

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent -- --testPathPattern=team
yarn typecheck --filter=@dzupagent/agent
```

---

### PROMPT-H03: Extract shared `validate()` boilerplate to `compiler-utils.ts`

**Finding:** H-03  
**Target files:**
- `packages/agent-adapters/src/skills/compilers/compiler-utils.ts`
- `packages/agent-adapters/src/skills/compilers/claude-skill-compiler.ts`
- `packages/agent-adapters/src/skills/compilers/codex-skill-compiler.ts`
- `packages/agent-adapters/src/skills/compilers/cli-skill-compiler.ts`

**What to change:**
1. Add to `compiler-utils.ts`:
   ```ts
   export function validateCompiledSkillBase(
     compiled: CompiledAdapterSkill,
     providerId: AdapterProviderId,
   ): string[] {
     const errors: string[] = []
     if (compiled.providerId !== providerId) errors.push(`Expected providerId '${providerId}', got '${compiled.providerId}'`)
     if (typeof compiled.runtimeConfig['systemPrompt'] !== 'string') errors.push('Missing or invalid runtimeConfig.systemPrompt')
     if (!compiled.hash || typeof compiled.hash !== 'string') errors.push('Missing or invalid hash')
     if (!compiled.projectionVersion || typeof compiled.projectionVersion !== 'string') errors.push('Missing or invalid projectionVersion')
     return errors
   }
   ```
2. Replace the duplicated block in each compiler's `validate()` with a call to `validateCompiledSkillBase(compiled, this.providerId)`.

**Acceptance criteria:**
- Duplicate 4-line check block removed from all three compilers
- `yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=adapter-skill` passes
- `yarn typecheck --filter=@dzupagent/agent-adapters` passes

**Validation command:**
```bash
grep -rn "Expected providerId" packages/agent-adapters/src/skills/compilers/ --include="*.ts"
yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=skill
```

---

### PROMPT-H04: Extract shared `extractTokenUsage` to `provider-event-normalization.ts`

**Finding:** H-04  
**Target files:**
- `packages/agent-adapters/src/utils/provider-event-normalization.ts`
- `packages/agent-adapters/src/claude/claude-adapter.ts:147–159`
- `packages/agent-adapters/src/codex/codex-adapter.ts:207–216`

**What to change:**
1. Add to `provider-event-normalization.ts`:
   ```ts
   export function extractTokenUsage(
     usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; cost_cents?: number } | undefined
   ): TokenUsage | undefined {
     if (!usage) return undefined
     const result: TokenUsage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
     if (usage.cached_input_tokens !== undefined) result.cachedInputTokens = usage.cached_input_tokens
     if (usage.cost_cents !== undefined) result.costCents = usage.cost_cents
     return result
   }
   ```
2. In `claude-adapter.ts:147–159` delete `extractTokenUsage` and import it from `../utils/provider-event-normalization.js`.
3. In `codex-adapter.ts:207–216` delete `toTokenUsage` and replace its call site with `extractTokenUsage`.

**Acceptance criteria:**
- Single `extractTokenUsage` in `provider-event-normalization.ts`
- Both adapters import it from there
- `yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=claude-adapter|codex-adapter` passes

**Validation command:**
```bash
grep -rn "function extractTokenUsage\|function toTokenUsage" packages/agent-adapters/src --include="*.ts"
yarn typecheck --filter=@dzupagent/agent-adapters
```

---

### PROMPT-H06: Delete `playground/ui/` dead-code module

**Finding:** H-06  
**Target files:**
- `packages/agent/src/playground/ui/utils.ts`
- `packages/agent/src/playground/ui/types.ts`
- `packages/agent/src/playground/ui/index.ts`
- `packages/agent/src/__tests__/playground-ui-utils.test.ts`
- `packages/agent/package.json` (remove `"./playground/ui": null` entries)

**What to change:**
1. Confirm via monorepo grep that no consumer imports from `@dzupagent/agent/playground/ui`:
   ```bash
   grep -rn "playground/ui\|@dzupagent/agent.*playground" --include="*.ts" . | grep -v "packages/agent/src/playground/ui"
   ```
2. Delete the three source files and the test file.
3. Remove the two null entries from `package.json`'s `exports` map.

**Acceptance criteria:**
- Files deleted
- `yarn build --filter=@dzupagent/agent` succeeds
- No import errors across the monorepo

**Validation command:**
```bash
grep -rn "playground/ui" . --include="*.ts" | grep -v "node_modules\|dist"
yarn build --filter=@dzupagent/agent
yarn typecheck --filter=@dzupagent/agent
```

---

### PROMPT-H09: Add unit tests for `policy-enabled-tool-executor.ts`

**Finding:** H-09  
**Target file (new):** `packages/agent/src/__tests__/policy-enabled-tool-executor.test.ts`

**What to change:** Create test file covering the 6 decision branches:

```ts
// Test structure:
describe('executePolicyEnabledToolCall', () => {
  it('blocks when governance.check() returns { allowed: false }')
  it('denies when permissionPolicy.hasPermission() returns false — throws TOOL_PERMISSION_DENIED')
  it('blocks when budget.isToolBlocked() returns true — returns [blocked by guardrails]')
  it('returns error ToolMessage when arg validation fails')
  it('blocks when result scanner returns hard-block — returns [blocked: unsafe tool output]')
  it('opens and closes OTel span on successful execution')
  it('closes span with error on tool timeout')
})
```

Use the mock helpers from `tool-loop-telemetry.test.ts` (`createMockTool`, `createMockEventBus`) and stub `ToolGovernance`, `ToolPermissionPolicy`, `SafetyMonitor`.

**Acceptance criteria:**
- 7 new test cases, all passing
- `executePolicyEnabledToolCall` imported directly (not through `tool-loop.ts`)
- `yarn test --filter=@dzupagent/agent -- --testPathPattern=policy-enabled` passes

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent -- --testPathPattern=policy-enabled-tool-executor
```

---

### PROMPT-H10: Add tests for `daemon-launcher.ts` and `structured-generate.ts`

**Finding:** H-10  
**Target files (new):**
- `packages/agent/src/__tests__/daemon-launcher.test.ts`
- `packages/agent/src/__tests__/structured-generate-branches.test.ts`

**What to change:**

`daemon-launcher.test.ts`:
```ts
describe('launch()', () => {
  it('returns a RunHandle immediately without waiting for completion')
  it('writes a run_started journal entry before starting background work')
  it('calls handle._fail() when background execution throws')
  it('forwards generateOptions.runId into the journal run_started entry')
})
```

`structured-generate-branches.test.ts`:
```ts
describe('generateStructured', () => {
  it('returns parsed output when model returns valid JSON on first try')
  it('retries when model returns invalid JSON, succeeds on second attempt')
  it('throws after maxRetries exhausted with parse failures')
  it('strips markdown code fences from model output before parsing')
  it('merges usage from multiple attempts in the result')
})
```

**Acceptance criteria:**
- All test cases passing
- No real LLM calls (stub models)
- `yarn test --filter=@dzupagent/agent -- --testPathPattern=daemon-launcher|structured-generate-branches` passes

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent -- --testPathPattern=daemon-launcher|structured-generate-branches
```

---

## Major Change Prompts (P3 — 16h+)

---

### PROMPT-M01: Decompose `team-runtime.ts` using the Strategy pattern

**Finding:** M-01  
**Target files:**
- `packages/agent/src/orchestration/team/team-runtime.ts` (1281 lines)
- New directory: `packages/agent/src/orchestration/team/strategies/`

**What to change:**

1. Define `TeamStrategy` interface in `strategies/types.ts`:
   ```ts
   export interface TeamStrategy {
     execute(
       task: string,
       runId: string,
       spawned: SpawnedAgent[],
       context: TeamStrategyContext,
     ): Promise<TeamRunResult>
   }
   export interface TeamStrategyContext {
     emitParticipantStart: (p: ParticipantDefinition, runId: string) => void
     emitParticipantComplete: (p: ParticipantDefinition, runId: string, success: boolean, durationMs: number, error?: string) => void
     isCircuitOpen: (participantId: string) => boolean
     recordSuccess: (participantId: string) => void
     recordFailure: (participantId: string) => boolean
     tracer?: TeamRuntimeTracer
   }
   ```

2. Create `strategies/supervisor-strategy.ts` (extract `runSupervisor`, ~68 lines).
3. Create `strategies/contract-net-strategy.ts` (extract `runContractNet`, ~67 lines).
4. Create `strategies/blackboard-strategy.ts` (extract `runBlackboard` + `runBlackboardRound`, ~144 lines).
5. Create `strategies/peer-to-peer-strategy.ts` (extract `runPeerToPeer`, ~73 lines).
6. Create `strategies/council-strategy.ts` (extract `runCouncil`, ~66 lines).
7. Refactor `TeamRuntime.execute()` to dispatch to the appropriate strategy class.
8. `team-runtime.ts` should be ≤400 lines after the extraction.

**Acceptance criteria:**
- `team-runtime.ts` ≤400 lines
- Each strategy independently importable and unit-testable
- `yarn test --filter=@dzupagent/agent -- --testPathPattern=team-runtime` passes
- `yarn typecheck --filter=@dzupagent/agent` passes

**Validation command:**
```bash
wc -l packages/agent/src/orchestration/team/team-runtime.ts
yarn test --filter=@dzupagent/agent -- --testPathPattern=team
yarn typecheck --filter=@dzupagent/agent
```

---

### PROMPT-M02: Extract `execute()` / `resume()` shared tail in `pipeline-runtime.ts`

**Finding:** M-02  
**Target file:** `packages/agent/src/pipeline/pipeline-runtime.ts`

**What to change:**

1. Add private method:
   ```ts
   private async runFromNodeOrFail(
     runId: string,
     startNodeId: string,
     runState: Record<string, unknown>,
     nodeResults: Map<string, NodeResult>,
     completedNodeIds: string[],
     versionTracker: { version: number },
     startTime: number,
   ): Promise<PipelineRunResult> {
     try {
       return await this.executeFromNode(startNodeId, runId, runState, nodeResults, completedNodeIds, versionTracker)
     } catch (err) {
       const errorMessage = err instanceof Error ? err.message : String(err)
       this.state = 'failed'
       this.emit(pipelineFailedEvent(runId, errorMessage))
       return { pipelineId: this.config.definition.id, runId, state: 'failed', nodeResults, totalDurationMs: Date.now() - startTime }
     }
   }
   ```
2. Refactor `execute()` and `resume()` to call `runFromNodeOrFail(...)` instead of inlining the try/catch.
3. Remove the duplicate error block inside `resume()`'s existing try/catch (lines 247–258).

**Acceptance criteria:**
- `execute()` and `resume()` error-handling are DRY
- All pipeline-runtime tests pass
- `yarn typecheck --filter=@dzupagent/agent` passes

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent -- --testPathPattern=pipeline-runtime
yarn typecheck --filter=@dzupagent/agent
```

---

### PROMPT-M05: Add `AgentMailbox` test suite

**Finding:** M-08  
**Target file (new):** `packages/agent/src/__tests__/agent-mailbox.test.ts`

**What to change:** Create comprehensive test covering:
```ts
describe('AgentMailbox', () => {
  describe('send()', () => {
    it('saves message to store')
    it('emits mail:received event on event bus')
    it('retries on store failure up to maxDeliveryAttempts')
    it('pushes to DLQ after all delivery attempts exhausted')
    it('throws when no DLQ is configured and all attempts fail')
  })
  describe('receive()', () => {
    it('returns messages for this agent ID from the store')
  })
  describe('subscribe()', () => {
    it('throws when no event bus is configured')
    it('invokes sync handler when message arrives for this agent')
    it('invokes async handler and surfaces errors via config.onError')
    it('does not invoke handler for messages to other agents')
    it('returns an unsubscribe function that stops handler invocation')
  })
  describe('rate limiting', () => {
    it('rejects messages that exceed rate limit')
  })
  describe('AgentRateLimiter', () => {
    it('allows messages within window')
    it('rejects after maxMessages in window')
    it('resets after window elapses')
  })
})
```

**Acceptance criteria:**
- All test cases passing
- No real DLQ or external store (use `InMemoryMailboxStore`)
- `yarn test --filter=@dzupagent/agent -- --testPathPattern=agent-mailbox` passes

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent -- --testPathPattern=agent-mailbox
```

---

### PROMPT-M07: Add `UCL skill-loader` and `UCL agent-loader` test suite

**Finding:** M-07  
**Target file (new):** `packages/agent-adapters/src/__tests__/ucl-loaders.test.ts`

**What to change:** Create test covering all UCL loaders:

```ts
describe('UCL SkillLoader', () => {
  it('loads a well-formed skill .md file')
  it('returns null for missing frontmatter')
  it('handles corrupted YAML in frontmatter gracefully')
  it('returns empty array when skills directory does not exist')
})
describe('UCL AgentLoader', () => {
  it('loads a well-formed agent .md file')
  it('surfaces parse errors as structured error results')
})
describe('UCL MemoryLoader', () => {
  it('loads a memory .md file and returns MemoryClaim[]')
})
```

Use `mock-fs` or node's `memfs` for filesystem mocking, consistent with `dzupagent-file-loader.test.ts`.

**Acceptance criteria:**
- All test cases passing
- `yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=ucl-loaders` passes
- `yarn typecheck --filter=@dzupagent/agent-adapters` passes

**Validation command:**
```bash
yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=ucl-loaders
yarn typecheck --filter=@dzupagent/agent-adapters
```

---

### PROMPT-M09: Decompose `normalizeCodex`/`normalizeClaude` in `normalize.ts` into per-provider files

**Finding:** H-05 (elevated to Major due to file size and impact)  
**Target file:** `packages/agent-adapters/src/normalize.ts` (601 lines)

**What to change:**

1. Create `packages/agent-adapters/src/normalize/` directory.
2. Create `normalize/claude.ts` — move `normalizeClaude` (lines 90–213) and its helpers.
3. Create `normalize/codex.ts` — move `normalizeCodex` (lines 214–352) and helpers.
4. Create `normalize/openai.ts` — move `normalizeOpenAI` (lines 353–485) and `getFirstChoice`, `getOpenAIChoiceMessageContent`.
5. Create `normalize/gemini.ts` — move `normalizeGemini` (lines 502–543) and helpers.
6. Create `normalize/goose.ts` and `normalize/cli.ts` for remaining providers.
7. Reduce `normalize.ts` to a 40-line router:
   ```ts
   export function normalizeEvent(raw: unknown, provider: Provider): AgentEvent | null {
     switch (provider) {
       case 'claude': return normalizeClaude(raw)
       case 'codex': return normalizeCodex(raw)
       ...
     }
   }
   ```

**Acceptance criteria:**
- `normalize.ts` ≤60 lines
- All existing normalize tests pass
- `yarn typecheck --filter=@dzupagent/agent-adapters` passes
- New per-provider files are individually importable

**Validation command:**
```bash
wc -l packages/agent-adapters/src/normalize.ts
yarn test --filter=@dzupagent/agent-adapters -- --testPathPattern=normalize
yarn typecheck --filter=@dzupagent/agent-adapters
```

---

*End of audit report.*
