# Agent Pattern Audit

Baseline current-code review for the agent patterns domain. Evidence was gathered from `context/repo-snapshot.md` first, then from selected current source and tests. No runtime validation was run for this audit.

## Findings

### AGENT-001 - High - Tool audit events leak raw tool inputs despite the metadata-only contract

Impact: Tool arguments can contain secrets, credentials, customer data, file contents, or prompt payloads. The canonical event contract says tool telemetry should record only top-level input keys, but both the event bus and governance audit bridge still receive full argument values. Any attached compliance logger, run trace bridge, or custom event subscriber can persist sensitive tool input into audit stores.

Evidence: `packages/core/src/events/event-types.ts:45` documents that `inputMetadataKeys` records keys only and "never the values", but the same event type still includes `input: unknown` at `packages/core/src/events/event-types.ts:51`. The non-streaming emitter sends `input` into `tool:called` at `packages/agent/src/agent/tool-loop.ts:762` and forwards the same `input` into `toolGovernance.audit()` at `packages/agent/src/agent/tool-loop.ts:779`. The streaming mirror does the same at `packages/agent/src/agent/run-engine.ts:581` and `packages/agent/src/agent/run-engine.ts:596`. `ComplianceAuditLogger.attach()` records event details wholesale after removing only the `type` field at `packages/core/src/security/audit/audit-logger.ts:74`.

Remediation: Remove raw `input` from canonical `tool:called` events and audit details, or replace it with an explicitly redacted/sized preview under a separate opt-in field. Keep `inputMetadataKeys`, `toolName`, `toolCallId`, `agentId`, and durable run IDs as the default audit payload. Add tests that attach `ComplianceAuditLogger` and assert secret-like argument values are not stored.

### AGENT-002 - High - Native streaming does not hard-gate approval-required tools

Impact: An agent using `stream()` can execute a side-effecting tool that `ToolGovernance.checkAccess()` marks as `requiresApproval`. This bypasses the human-in-the-loop hard gate implemented in the non-streaming tool loop, so approval semantics differ by execution mode.

Evidence: The non-streaming path treats `access.requiresApproval` as a hard gate, emits `approval:requested`, does not invoke the tool, and returns `approvalPending` at `packages/agent/src/agent/tool-loop.ts:1157`. The streaming executor checks `policy.toolGovernance.checkAccess()` at `packages/agent/src/agent/run-engine.ts:822`, blocks only `!access.allowed`, and has a comment stating approval-required tools are not handled at `packages/agent/src/agent/run-engine.ts:844`. Execution then continues to `tool.invoke(validatedArgs)` at `packages/agent/src/agent/run-engine.ts:910`.

Remediation: Implement the same approval-pending branch in `executeStreamingToolCall()` as `executeSingleToolCall()`: emit `approval:requested`, append an approval-pending tool message, stop the streaming run with `stopReason: 'approval_pending'`, and do not call the tool. Add stream/generate parity tests for approval-required tools.

### AGENT-003 - High - Native streaming bypasses final output filtering before completion and memory write-back

Impact: `guardrails.outputFilter` can redact or block final text in `generate()`, but native `stream()` finalizes and writes memory without applying that filter. A caller that enables output filtering for policy, PII, or safety cleanup can still stream and persist unfiltered final output.

Evidence: The non-streaming run applies `params.config.guardrails?.outputFilter` before returning content at `packages/agent/src/agent/run-engine.ts:405`. The native streaming finalizer writes memory directly when `stopReason === 'complete'` at `packages/agent/src/agent/streaming-run.ts:172`, and the final no-tool response calls `finalizeRun('complete', chunks.join(''))` then yields that same content at `packages/agent/src/agent/streaming-run.ts:284`. The fallback streaming branch that delegates to `executeGenerateRun()` benefits from the filter, but the native branch has no corresponding output-filter call.

Remediation: Route native streaming final content through the same output-filter helper used by `executeGenerateRun()` before `maybeWriteBackMemory()` and before the final `done` event. Add a native-stream test with `guardrails.outputFilter` that proves streamed final content and memory write-back use the filtered value.

### AGENT-004 - Medium - Native streaming token lifecycle omits auto-compression and halt checks

Impact: A streaming run with a `tokenLifecyclePlugin` records usage but does not apply the same compression/halt behavior as `generate()`. Under critical or exhausted pressure, native streaming can continue into tool calls and additional model turns instead of compacting or halting before more work is scheduled.

Evidence: `streamRun()` wraps `options.onUsage` so the token plugin receives usage at `packages/agent/src/agent/streaming-run.ts:109`, and forwards usage at `packages/agent/src/agent/streaming-run.ts:266`. The native streaming path then records budget warnings at `packages/agent/src/agent/streaming-run.ts:270` and immediately inspects tool calls at `packages/agent/src/agent/streaming-run.ts:278`; there is no call to `tokenPlugin.maybeCompress()` or `tokenPlugin.shouldHalt()` in that branch. The non-streaming tool loop runs `maybeCompress` before the halt check at `packages/agent/src/agent/tool-loop.ts:504` and checks `shouldHalt()` before executing tool calls at `packages/agent/src/agent/tool-loop.ts:525`.

Remediation: Mirror the non-streaming lifecycle in native streaming: after each full streamed response and usage recording, call `maybeCompress()`, adopt compressed messages when returned, emit compression telemetry, then call `shouldHalt()` before executing tool calls. Add a streaming regression test where the plugin reports exhausted after usage and assert no tool invocation occurs.

### AGENT-005 - Medium - Tool timeouts do not cancel the underlying tool work

Impact: The agent reports a timeout, but the underlying tool promise continues running if the tool implementation ignores cancellation. Side effects can still land after the timeout and can overlap with retries, resumed runs, or subsequent tool calls. This is especially risky for write, deploy, payment, notification, and external API tools.

Evidence: The non-streaming timeout helper races `invoke()` with a timer and clears only the timer in `finally` at `packages/agent/src/agent/tool-loop.ts:1643`; it does not pass an `AbortSignal` or cancellation context to `tool.invoke()` at `packages/agent/src/agent/tool-loop.ts:1264`. The streaming helper has the same `Promise.race` pattern at `packages/agent/src/agent/run-engine.ts:722` and invokes the tool without a cancellation channel at `packages/agent/src/agent/run-engine.ts:910`.

Remediation: Extend the tool execution contract to pass a per-call `AbortSignal` or context object to tools that support it, abort that signal on timeout or run cancellation, and document that side-effecting tools must honor it. Until then, classify timeout as an observational deadline, not guaranteed cancellation, in docs and audit events.

### AGENT-006 - Medium - Safety scanner failures fail open for tool results

Impact: If the safety monitor throws because of a parser bug, provider outage, or malformed content, the tool output is passed back to the LLM unblocked. That creates a fail-open prompt-injection path exactly where the scanner is intended to protect the model from hostile tool output.

Evidence: In the non-streaming tool loop, `safetyMonitor.scanContent()` is wrapped in a `try` and scanner errors are swallowed at `packages/agent/src/agent/tool-loop.ts:1277`. The streaming executor repeats the same pattern at `packages/agent/src/agent/run-engine.ts:926` and swallows errors at `packages/agent/src/agent/run-engine.ts:969`. In both paths, execution continues to create a successful `ToolMessage` when scanning fails.

Remediation: Add an explicit policy knob such as `scanFailureMode: 'fail-open' | 'fail-closed'`, default side-effecting or untrusted tools to fail-closed, and emit a distinct `tool:error`/`safety:scan_failed` event when scanning cannot complete. Add tests for scanner exceptions in both stream and generate modes.

### AGENT-007 - Medium - Arrow memory failure falls back to unbudgeted load-all memory context

Impact: When Arrow memory selection fails, the loader emits fallback telemetry but then retrieves all records via the standard memory path. A runtime outage in the budgeting layer can therefore degrade into oversized prompts, higher cost, context truncation, or model rejection instead of a bounded degraded mode.

Evidence: `AgentMemoryContextLoader.load()` catches Arrow failures and emits `arrow_runtime_failure` at `packages/agent/src/agent/memory-context-loader.ts:125`, then continues to `memory.get(namespace, scope)` and `memory.formatForPrompt(records)` at `packages/agent/src/agent/memory-context-loader.ts:145`. The standard fallback path has no limit, phase selection, or token budget cap. The Arrow path computes a bounded `memoryBudget` at `packages/agent/src/agent/memory-context-loader.ts:199`.

Remediation: Preserve a bounded fallback when Arrow selection fails: pass a limit to the memory service where available, estimate and trim formatted records to the same memory budget, or return no memory context when the budget layer is unavailable and `arrowMemory` was explicitly requested. Add a test that simulates Arrow import/export failure with many records and asserts bounded prompt size.

### AGENT-008 - Medium - Memory write-back failures are invisible to event and audit consumers

Impact: Runs can appear complete while learned memory was not persisted. Because write-back errors are swallowed without telemetry, operators cannot distinguish "no memory written" from "memory unavailable", and audit trails miss a key state transition in memory-enabled agents.

Evidence: `DzupAgent.generate()` calls `maybeWriteBackMemory(result.content)` for non-failed runs at `packages/agent/src/agent/dzip-agent.ts:243`. `maybeWriteBackMemory()` persists to `config.memory.put()` at `packages/agent/src/agent/dzip-agent.ts:639`, but catches all errors and only comments that failures are non-fatal at `packages/agent/src/agent/dzip-agent.ts:652`. There is no `memory:error`, `agent:context_fallback`, or `memory:written` emission in this method.

Remediation: Keep write-back non-fatal, but emit `memory:error` with namespace and sanitized message on failure and `memory:written` with namespace/key on success. Route these events through the existing compliance audit path so memory persistence status is observable without exposing record contents.

### AGENT-009 - Medium - Provider fallback is selection-time only, not run-level failover

Impact: The registry can skip providers whose circuit is already open, but a transient invocation or stream failure during a run is surfaced to the caller instead of retrying the same request on the next configured provider. Product code that assumes "fallback" means same-run resilience can still fail user-visible runs during short provider outages.

Evidence: `ModelRegistry.getModelWithFallback()` selects the first provider whose circuit can execute and returns one model/provider pair at `packages/core/src/llm/model-registry.ts:330`. `DzupAgent.resolveModel()` calls it once during construction for tier-based models at `packages/agent/src/agent/dzip-agent.ts:391`. Invocation failures record provider failure and rethrow at `packages/agent/src/agent/dzip-agent.ts:609`; native stream failures do the same at `packages/agent/src/agent/streaming-run.ts:209` and `packages/agent/src/agent/streaming-run.ts:231`. The comments in `dzip-agent.ts` correctly document this selection-time-only behavior at `packages/agent/src/agent/dzip-agent.ts:197`.

Remediation: Keep the current behavior documented, but expose a distinct run-level retry/failover wrapper for callers that need it. The wrapper should reconstruct a fresh agent or model per attempt, preserve idempotency constraints for tool calls, and emit attempt/provider metadata so audit consumers can distinguish fallback from duplicate execution.

### AGENT-010 - Medium - Orchestration circuit-breaker attribution is too coarse

Impact: Multi-agent orchestration can mark specialists healthy even when no specialist actually ran successfully, and generic failures do not trip the breaker. This weakens routing quality over time and makes supervisor health metrics unreliable under partial failure.

Evidence: In `AgentOrchestrator.supervisor()`, a successful manager run records success for every available specialist at `packages/agent/src/orchestration/orchestrator.ts:357`, even though the manager may not have called all specialist tools. In the catch branch, only timeout-looking failures are recorded at `packages/agent/src/orchestration/orchestrator.ts:373`. The parallel path similarly records successes and timeout failures, but ignores non-timeout rejected outcomes for breaker state at `packages/agent/src/orchestration/orchestrator.ts:126`.

Remediation: Record breaker outcomes from actual specialist tool invocation events or delegation results, not from manager-level completion. Add a generic failure path to the breaker interface or map non-timeout failures to a degraded state. Include tests for "manager succeeds without using specialist" and "specialist throws non-timeout error".

### AGENT-011 - Low - Approval waits can be unbounded by default

Impact: `ApprovalGate` can hold a promise forever when no grant/reject event arrives and no timeout is configured. This can pin worker resources and leave operational state ambiguous, especially because the example and several tests allow required approval without `timeoutMs`.

Evidence: `ApprovalGate.waitForApproval()` returns a new promise waiting for `approval:granted` or `approval:rejected` at `packages/agent/src/approval/approval-gate.ts:87`. The timeout branch is only installed when `this.config.timeoutMs` is set at `packages/agent/src/approval/approval-gate.ts:111`. Tests explicitly cover "no timeout when timeoutMs is not set" for required mode at `packages/agent/src/__tests__/approval-gate-deep.test.ts:133`.

Remediation: Provide a conservative default timeout for required approvals, or make `timeoutMs` mandatory for `mode: 'required'` unless a durable external approval store/resume mechanism is configured. Add cancellation support so callers can abandon an approval wait cleanly during run cancellation or shutdown.

### AGENT-012 - Low - Team execution policies are declared but not enforced by TeamRuntime

Impact: Team definitions expose policy knobs for max parallelism, timeout, retries, memory, isolation, mailbox delivery, and evaluation, but several runtime paths ignore them. Consumers can configure policies and believe they are active while peer-to-peer, blackboard, council, and resume flows run with hard-coded behavior.

Evidence: `ExecutionPolicy` declares `maxParallelParticipants`, `timeoutMs`, `retryOnFailure`, and `maxRetries` at `packages/agent/src/orchestration/team/team-policy.ts:11`; `TeamPolicies` also declares memory/isolation/mailbox/evaluation policies at `packages/agent/src/orchestration/team/team-policy.ts:75`. `TeamRuntime.runPeerToPeer()` still fans out every participant with `Promise.allSettled(spawned.map(...))` at `packages/agent/src/orchestration/team/team-runtime.ts:677`. Blackboard rounds are hard-coded to 3 via `resolveMaxRounds()` at `packages/agent/src/orchestration/team/team-runtime.ts:946`. The `resume()` path temporarily mutates `this.definition.participants` around `execute()` at `packages/agent/src/orchestration/team/team-runtime.ts:835`, without policy-level isolation.

Remediation: Either enforce the declared policies or narrow the public policy surface until supported. At minimum, implement max parallelism and run timeout in `TeamRuntime.execute()`, wire retry semantics per participant, and document memory/isolation/mailbox/evaluation as pending if they remain non-enforced.

### AGENT-013 - Low - Orchestration emits some routing diagnostics to console instead of the event/audit path

Impact: Routing and circuit-breaker decisions can disappear in production environments where `console.debug` is disabled or uncollected. That leaves gaps in audit trails and makes structural comparisons to the local audit taxonomy harder because relevant decisions are not represented as events.

Evidence: `AgentOrchestrator.supervisor()` logs circuit-breaker filtering with `console.debug` at `packages/agent/src/orchestration/orchestrator.ts:270` and routing decisions with `console.debug` at `packages/agent/src/orchestration/orchestrator.ts:297`. In contrast, `DelegatingSupervisor` uses `eventBus` events for delegation, merge, plan, fallback, and routing decisions at `packages/agent/src/orchestration/delegating-supervisor.ts:189`, `packages/agent/src/orchestration/delegating-supervisor.ts:342`, `packages/agent/src/orchestration/delegating-supervisor.ts:382`, and `packages/agent/src/orchestration/delegating-supervisor.ts:503`.

Remediation: Replace console-only diagnostics with typed `DzupEventBus` events or an injected logger that can feed audit sinks. Keep console logging as an optional adapter, not the only emission path.

### AGENT-014 - Info - Tool governance is opt-in by design, so default agents run without permission, scan, timeout, or canonical tool telemetry

Impact: Backward compatibility is preserved, but consumers must know to configure `toolExecution` before expecting production controls. This creates a structural gap between the framework's advanced guardrail primitives and the default top-level agent behavior.

Evidence: `DzupAgentConfig.toolExecution` documents that all fields are optional and omitted fields preserve legacy behavior at `packages/agent/src/agent/agent-types.ts:232`. `executeGenerateRun()` forwards governance, safety, timeout, validation, permission, and event bus only when `toolExecution` is provided at `packages/agent/src/agent/run-engine.ts:260` and `packages/agent/src/agent/run-engine.ts:291`. The stream parity test documents that without `toolExecution`, the loop does not route policy events to the bus at `packages/agent/src/__tests__/stream-tool-guardrail-parity.test.ts:537`.

Remediation: Keep compatibility, but provide a secure preset/factory for production agents that wires governance, safety scanning, timeouts, argument validation, permission policy, tracer, event bus, and run ID propagation together. Update docs to distinguish "primitive available" from "enabled by default".

## Scope Reviewed

Reviewed current source and relevant tests for:

- Tool loop and streaming execution: `packages/agent/src/agent/tool-loop.ts`, `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/streaming-run.ts`, `packages/agent/src/agent/agent-types.ts`.
- Guardrails and approval: `packages/agent/src/guardrails/*`, `packages/agent/src/approval/approval-gate.ts`.
- Memory and context management: `packages/agent/src/agent/memory-context-loader.ts`, `packages/agent/src/agent/dzip-agent.ts`, selected `packages/context/src/*` surfaces from the snapshot-guided search.
- Provider fallback: `packages/core/src/llm/model-registry.ts`, `packages/agent/src/agent/dzip-agent.ts`.
- Orchestration: `packages/agent/src/orchestration/orchestrator.ts`, `packages/agent/src/orchestration/delegating-supervisor.ts`, `packages/agent/src/orchestration/team/*`, `packages/agent/src/orchestration/delegation.ts`.
- Audit logging and event contracts: `packages/core/src/events/event-types.ts`, `packages/core/src/security/audit/audit-logger.ts`, `packages/core/src/tools/tool-governance.ts`, `packages/core/src/security/monitor/safety-monitor.ts`.
- Structural audit taxonomy context: `codex-prep/README.md` only for workflow rules; current source remains the evidence source.

Excluded generated/dependency/build output and old audit artifacts. Existing audit documents were not used as evidence.

## Strengths

- The ReAct tool loop has real production primitives: max iteration limits, cumulative token/cost budgeting, blocked tool lists, stuck detection, per-tool latency stats, optional parallel execution with a shared policy stack, and canonical terminal tool events.
- The non-streaming tool path now has a hard approval gate for approval-required tools and a clear `approval_pending` stop reason.
- Tool argument validation, result transformation, safety scanning, timeout labeling, OTel span hooks, and canonical tool lifecycle events are centralized enough that targeted parity fixes are feasible.
- Memory/context management includes structured fallback telemetry, Arrow-based budgeted memory selection, frozen snapshots, phase-aware message windowing, summarization, and token lifecycle integration.
- Provider fallback semantics are explicitly documented as selection-time-only, and circuit breaker state is updated on invocation/stream failures.
- Multi-agent orchestration has several reusable primitives: sequential, parallel, supervisor, debate, contract-net, delegating supervisor, team runtime, merge strategies, routing policies, and circuit breaker hooks.
- The audit/logging stack has a typed event union and a compliance audit logger that can subscribe broadly to security-relevant events.

## Open Questions Or Assumptions

- I did not run tests or a dev server; this is a static current-code audit only.
- I treated the local audit command taxonomy structurally, per the prompt pack rule that command files define workflow shape only. The findings above are evidenced from current repository code, not prior audit results.
- I assumed production consumers may use native `stream()` when a model exposes `.stream()` and no middleware wrapper forces fallback; that is the branch where several parity gaps appear.
- I assumed tool arguments and final agent outputs can contain sensitive or policy-regulated data, which is consistent with the framework's tool, memory, and audit surfaces.
- I did not inspect every connector implementation; connector-specific tool side effects may change the severity of timeout/cancellation gaps for particular tools.

## Recommended Next Actions

1. Patch high-severity stream/governance parity first: approval-required tools must hard-stop in native streaming, and final output filtering must apply before streamed completion and memory write-back.
2. Remove or redact raw tool inputs from canonical tool audit events and compliance audit details. Treat this as an audit contract change with compatibility notes.
3. Add focused parity tests for `generate()` versus native `stream()` across approval, output filtering, token halt/compression, scanner exception handling, and telemetry payload redaction.
4. Decide explicit failure policies for safety scanning and memory fallback: fail-open may remain available, but production presets should default to bounded or fail-closed behavior for untrusted content.
5. Make orchestration policy semantics honest: enforce `TeamPolicies.execution` or mark unsupported policy fields as declarative placeholders until implemented.
6. Add cancellation-aware tool execution contracts for side-effecting tools, then classify old timeout-only behavior as legacy best-effort timeout.
7. Move orchestration routing/filtering diagnostics into typed events so audit logging can capture decision paths consistently.

```json
{
  "domain": "agent patterns",
  "counts": { "critical": 0, "high": 3, "medium": 7, "low": 3, "info": 1 },
  "findings": [
    { "id": "AGENT-001", "severity": "high", "title": "Tool audit events leak raw tool inputs despite the metadata-only contract", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-002", "severity": "high", "title": "Native streaming does not hard-gate approval-required tools", "file": "packages/agent/src/agent/run-engine.ts" },
    { "id": "AGENT-003", "severity": "high", "title": "Native streaming bypasses final output filtering before completion and memory write-back", "file": "packages/agent/src/agent/streaming-run.ts" },
    { "id": "AGENT-004", "severity": "medium", "title": "Native streaming token lifecycle omits auto-compression and halt checks", "file": "packages/agent/src/agent/streaming-run.ts" },
    { "id": "AGENT-005", "severity": "medium", "title": "Tool timeouts do not cancel the underlying tool work", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-006", "severity": "medium", "title": "Safety scanner failures fail open for tool results", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-007", "severity": "medium", "title": "Arrow memory failure falls back to unbudgeted load-all memory context", "file": "packages/agent/src/agent/memory-context-loader.ts" },
    { "id": "AGENT-008", "severity": "medium", "title": "Memory write-back failures are invisible to event and audit consumers", "file": "packages/agent/src/agent/dzip-agent.ts" },
    { "id": "AGENT-009", "severity": "medium", "title": "Provider fallback is selection-time only, not run-level failover", "file": "packages/core/src/llm/model-registry.ts" },
    { "id": "AGENT-010", "severity": "medium", "title": "Orchestration circuit-breaker attribution is too coarse", "file": "packages/agent/src/orchestration/orchestrator.ts" },
    { "id": "AGENT-011", "severity": "low", "title": "Approval waits can be unbounded by default", "file": "packages/agent/src/approval/approval-gate.ts" },
    { "id": "AGENT-012", "severity": "low", "title": "Team execution policies are declared but not enforced by TeamRuntime", "file": "packages/agent/src/orchestration/team/team-runtime.ts" },
    { "id": "AGENT-013", "severity": "low", "title": "Orchestration emits some routing diagnostics to console instead of the event/audit path", "file": "packages/agent/src/orchestration/orchestrator.ts" },
    { "id": "AGENT-014", "severity": "info", "title": "Tool governance is opt-in by design, so default agents run without permission, scan, timeout, or canonical tool telemetry", "file": "packages/agent/src/agent/agent-types.ts" }
  ]
}
```
