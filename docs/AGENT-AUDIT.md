# Agent Pattern Audit

## Findings

### AGENT-001 - High - Tool audit events leak raw tool inputs despite the metadata-only contract

Impact: Tool arguments can contain secrets, credentials, customer data, file contents, or prompt payloads. The canonical event contract says tool telemetry should record only top-level input keys, but both the event bus and governance audit bridge still receive full argument values. Any attached `ComplianceAuditLogger`, run trace bridge, or custom event subscriber can persist sensitive tool input into audit stores.

Evidence: `packages/core/src/events/event-types.ts:45` documents that `inputMetadataKeys` records keys only and "never the values", but the same event type still includes `input: unknown` at `packages/core/src/events/event-types.ts:51`. The non-streaming emitter sends `input` into `tool:called` at `packages/agent/src/agent/tool-loop.ts:686` and also forwards the same `input` into `toolGovernance.audit()` at `packages/agent/src/agent/tool-loop.ts:701`. The streaming mirror does the same at `packages/agent/src/agent/run-engine.ts:581` and `packages/agent/src/agent/run-engine.ts:596`. `ComplianceAuditLogger.attach()` records event details wholesale after removing only the `type` field at `packages/core/src/security/audit/audit-logger.ts:74`.

Remediation: Remove raw `input` from canonical `tool:called` events and audit details, or replace it with an explicitly redacted/sized preview under a different opt-in field. Keep `inputMetadataKeys`, `toolName`, `toolCallId`, `agentId`, and durable run IDs as the default audit payload. Add tests that attach `ComplianceAuditLogger` and assert secret-like argument values are not stored.

### AGENT-002 - High - Native streaming does not hard-gate approval-required tools

Impact: An agent using `stream()` can execute a side-effecting tool that `ToolGovernance.checkAccess()` marks as `requiresApproval`. This bypasses the human-in-the-loop hard gate implemented in the non-streaming tool loop, so approval semantics differ by execution mode.

Evidence: The non-streaming path treats `access.requiresApproval` as a hard gate, emits `approval:requested`, does not invoke the tool, and returns `approvalPending` at `packages/agent/src/agent/tool-loop.ts:1002`. The streaming executor checks `policy.toolGovernance.checkAccess()` at `packages/agent/src/agent/run-engine.ts:822`, blocks only `!access.allowed`, and has a comment stating approval-required tools are not handled at `packages/agent/src/agent/run-engine.ts:844`. Execution then continues to `tool.invoke(validatedArgs)` at `packages/agent/src/agent/run-engine.ts:910`.

Remediation: Implement the same approval-pending branch in `executeStreamingToolCall()` as `executeSingleToolCall()`: emit `approval:requested`, append an approval-pending tool message, stop the streaming run with `stopReason: 'approval_pending'`, and do not call the tool. Add stream/generate parity tests for approval-required tools.

### AGENT-003 - Medium - Native streaming token lifecycle omits auto-compression and halt checks

Impact: A streaming run with a `tokenLifecyclePlugin` records usage but does not apply the same compression/halt behavior as `generate()`. Under critical or exhausted pressure, native streaming can continue into tool calls and additional model turns instead of compacting or halting before more work is scheduled.

Evidence: `streamRun()` wraps `options.onUsage` so the token plugin receives usage at `packages/agent/src/agent/streaming-run.ts:109`, and forwards the usage at `packages/agent/src/agent/streaming-run.ts:266`. The native streaming path then records budget warnings at `packages/agent/src/agent/streaming-run.ts:270` and immediately inspects tool calls at `packages/agent/src/agent/streaming-run.ts:278`; there is no call to `tokenPlugin.maybeCompress()` or `tokenPlugin.shouldHalt()` in that branch. The non-streaming tool loop explicitly runs `maybeCompress` before the halt check at `packages/agent/src/agent/tool-loop.ts:458` and checks `shouldHalt()` before executing tool calls at `packages/agent/src/agent/tool-loop.ts:476`.

Remediation: Mirror the non-streaming lifecycle in native streaming: after each full streamed response and usage recording, call `maybeCompress()`, adopt compressed messages when returned, emit compression telemetry, then call `shouldHalt()` before executing tool calls. Add a streaming regression test where the plugin reports exhausted after usage and assert no tool invocation occurs.

### AGENT-004 - Medium - Tool timeouts do not cancel the underlying tool work

Impact: The agent reports a timeout, but the underlying tool promise continues running if the tool implementation ignores cancellation. Side effects can still land after the timeout and can overlap with retries, resumed runs, or subsequent tool calls. This is especially risky for write, deploy, payment, notification, and external API tools.

Evidence: The non-streaming timeout helper races `invoke()` with a timer and clears only the timer in `finally` at `packages/agent/src/agent/tool-loop.ts:1481`; it does not pass an `AbortSignal` or cancellation context to `tool.invoke()` at `packages/agent/src/agent/tool-loop.ts:1109`. The streaming helper has the same `Promise.race` pattern at `packages/agent/src/agent/run-engine.ts:722` and invokes the tool without a cancellation channel at `packages/agent/src/agent/run-engine.ts:910`.

Remediation: Extend the tool execution contract to pass a per-call `AbortSignal` or context object to tools that support it, abort that signal on timeout or run cancellation, and document that side-effecting tools must honor it. Until then, classify timeout as an observational deadline, not guaranteed cancellation, in docs and audit events.

### AGENT-005 - Medium - Safety scanner failures fail open for tool results

Impact: If the safety monitor throws because of a parser bug, provider outage, or malformed content, the tool output is passed back to the LLM unblocked. That creates a fail-open prompt-injection path exactly where the scanner is intended to protect the model from hostile tool output.

Evidence: In the non-streaming tool loop, `safetyMonitor.scanContent()` is wrapped in a `try` and all scanner errors are swallowed at `packages/agent/src/agent/tool-loop.ts:1122` and `packages/agent/src/agent/tool-loop.ts:1167`. The streaming executor repeats the same pattern at `packages/agent/src/agent/run-engine.ts:926` and `packages/agent/src/agent/run-engine.ts:969`. In both paths, execution continues to create a successful `ToolMessage` when scanning fails.

Remediation: Add an explicit policy knob such as `scanFailureMode: 'fail-open' | 'fail-closed'`, default side-effecting or untrusted tools to fail-closed, and emit a distinct `tool:error`/`safety:scan_failed` event when scanning cannot complete. Add tests for scanner exceptions in both stream and generate modes.

### AGENT-006 - Medium - Arrow memory failure falls back to unbudgeted load-all memory context

Impact: When Arrow memory selection fails, the loader emits fallback telemetry but then retrieves all records via the standard memory path. A runtime outage in the budgeting layer can therefore degrade into oversized prompts, higher cost, context truncation, or model rejection instead of a bounded degraded mode.

Evidence: `AgentMemoryContextLoader.load()` catches Arrow failures and emits `arrow_runtime_failure` at `packages/agent/src/agent/memory-context-loader.ts:125`, then continues to `memory.get(namespace, scope)` and `memory.formatForPrompt(records)` at `packages/agent/src/agent/memory-context-loader.ts:145`. The standard fallback path has no limit, phase selection, or token budget cap. The Arrow path computes a bounded `memoryBudget` at `packages/agent/src/agent/memory-context-loader.ts:199`.

Remediation: Preserve a bounded fallback when Arrow selection fails: pass a limit to the memory service where available, estimate and trim formatted records to the same memory budget, or return no memory context when the budget layer is unavailable and `arrowMemory` was explicitly requested. Add a test that simulates Arrow import/export failure with many records and asserts bounded prompt size.

### AGENT-007 - Medium - Memory write-back failures are invisible to event and audit consumers

Impact: Runs can appear complete while learned memory was not persisted. Because write-back errors are swallowed without telemetry, operators cannot distinguish "no memory written" from "memory unavailable", and audit trails miss a key state transition in memory-enabled agents.

Evidence: `DzupAgent.generate()` calls `maybeWriteBackMemory(result.content)` for non-failed runs at `packages/agent/src/agent/dzip-agent.ts:243`. `maybeWriteBackMemory()` persists to `config.memory.put()` at `packages/agent/src/agent/dzip-agent.ts:639`, but catches all errors and only comments that failures are non-fatal at `packages/agent/src/agent/dzip-agent.ts:652`. There is no `memory:error`, `agent:context_fallback`, or `memory:written` emission in this method.

Remediation: Keep write-back non-fatal, but emit `memory:error` with namespace and sanitized message on failure and `memory:written` with namespace/key on success. Route these events through the existing compliance audit path so memory persistence status is observable without exposing record contents.

### AGENT-008 - Medium - Provider fallback is selection-time only, not run-level failover

Impact: The registry can skip providers whose circuit is already open, but a transient invocation or stream failure during a run is surfaced to the caller instead of retrying the same request on the next configured provider. Product code that assumes "fallback" means same-run resilience can still fail user-visible runs during short provider outages.

Evidence: `ModelRegistry.getModelWithFallback()` selects the first provider whose circuit can execute and returns one model/provider pair at `packages/core/src/llm/model-registry.ts:330`. `DzupAgent.resolveModel()` calls it once during construction for tier-based models at `packages/agent/src/agent/dzip-agent.ts:391`. Invocation failures record provider failure and rethrow at `packages/agent/src/agent/dzip-agent.ts:609`; native stream failures do the same at `packages/agent/src/agent/streaming-run.ts:209` and `packages/agent/src/agent/streaming-run.ts:231`. The comments in `dzip-agent.ts` correctly document this selection-time-only behavior at `packages/agent/src/agent/dzip-agent.ts:197`.

Remediation: Keep the current behavior documented, but expose a distinct run-level retry/failover wrapper for callers that need it. The wrapper should reconstruct a fresh agent or model per attempt, preserve idempotency constraints for tool calls, and emit attempt/provider metadata so audit consumers can distinguish fallback from duplicate execution.

### AGENT-009 - Medium - Orchestration circuit-breaker attribution is too coarse

Impact: Multi-agent orchestration can mark specialists healthy even when no specialist actually ran successfully, and generic failures do not trip the breaker. This weakens routing quality over time and makes supervisor health metrics unreliable under partial failure.

Evidence: In `AgentOrchestrator.supervisor()`, a successful manager run records success for every available specialist at `packages/agent/src/orchestration/orchestrator.ts:357`, even though the manager may not have called all specialist tools. In the catch branch, only timeout-looking failures are recorded at `packages/agent/src/orchestration/orchestrator.ts:373`. The parallel path similarly records successes and timeout failures, but ignores non-timeout rejected outcomes for breaker state at `packages/agent/src/orchestration/orchestrator.ts:126`.

Remediation: Record breaker outcomes from actual specialist tool invocation events or delegation results, not from manager-level completion. Add a generic failure path to the breaker interface or map non-timeout failures to a degraded state. Include tests for "manager succeeds without using specialist" and "specialist throws non-timeout error".

```json
{
  "domain": "agent patterns",
  "counts": { "critical": 0, "high": 2, "medium": 7, "low": 0, "info": 0 },
  "findings": [
    { "id": "AGENT-001", "severity": "high", "title": "Tool audit events leak raw tool inputs despite the metadata-only contract", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-002", "severity": "high", "title": "Native streaming does not hard-gate approval-required tools", "file": "packages/agent/src/agent/run-engine.ts" },
    { "id": "AGENT-003", "severity": "medium", "title": "Native streaming token lifecycle omits auto-compression and halt checks", "file": "packages/agent/src/agent/streaming-run.ts" },
    { "id": "AGENT-004", "severity": "medium", "title": "Tool timeouts do not cancel the underlying tool work", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-005", "severity": "medium", "title": "Safety scanner failures fail open for tool results", "file": "packages/agent/src/agent/tool-loop.ts" },
    { "id": "AGENT-006", "severity": "medium", "title": "Arrow memory failure falls back to unbudgeted load-all memory context", "file": "packages/agent/src/agent/memory-context-loader.ts" },
    { "id": "AGENT-007", "severity": "medium", "title": "Memory write-back failures are invisible to event and audit consumers", "file": "packages/agent/src/agent/dzip-agent.ts" },
    { "id": "AGENT-008", "severity": "medium", "title": "Provider fallback is selection-time only, not run-level failover", "file": "packages/core/src/llm/model-registry.ts" },
    { "id": "AGENT-009", "severity": "medium", "title": "Orchestration circuit-breaker attribution is too coarse", "file": "packages/agent/src/orchestration/orchestrator.ts" }
  ]
}
```

## Scope Reviewed

Reviewed the prepared repo snapshot first: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md`.

Current-code inspection focused on the agent patterns domain:

- Tool loop and tool policy stack: `packages/agent/src/agent/tool-loop.ts`, `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/streaming-run.ts`
- Guardrails and token lifecycle: `packages/agent/src/guardrails/stuck-detector.ts`, `packages/agent/src/guardrails/iteration-budget.ts`, `packages/agent/src/token-lifecycle-wiring.ts`, `packages/context/src/message-manager.ts`
- Memory and context management: `packages/agent/src/agent/memory-context-loader.ts`, `packages/agent/src/agent/memory-profiles.ts`, `packages/agent/src/agent/dzip-agent.ts`
- Provider fallback: `packages/core/src/llm/model-registry.ts`, `packages/agent/src/agent/dzip-agent.ts`
- Orchestration: `packages/agent/src/orchestration/orchestrator.ts`, `packages/agent/src/orchestration/delegating-supervisor.ts`, `packages/agent/src/orchestration/map-reduce.ts`
- Audit logging and telemetry contracts: `packages/core/src/events/event-types.ts`, `packages/core/src/security/audit/audit-logger.ts`, `packages/agent/src/observability/event-bus-bridge.ts`

No build, typecheck, lint, test, browser, or runtime validation command was run for this audit. Findings are based on static source review only.

Baseline review is separate from implementation status: prior audit documents and generated/dependency artifacts were not used as evidence of current behavior. Comparison to the local audit command taxonomy is structural only: the requested domain maps to tool loop, guardrails, memory, context management, orchestration, provider fallback, and audit logging, and this document follows that structure without treating the taxonomy as runtime evidence.

## Strengths

- The non-streaming tool loop has a consolidated policy stack for permission checks, governance blocking, approval-pending behavior, argument validation, tool timeouts, result transformation, safety scanning, stuck detection, tool stats, and canonical lifecycle events.
- Recent parity work is visible: the streaming executor has mirrored many policy checks, and the parallel non-streaming tool path delegates to the shared `executeSingleToolCall()` stack instead of maintaining a separate partial implementation.
- Guardrails are explicit and composable: iteration/cost/token budgets, blocked tool lists, stuck detection, token lifecycle plugins, and output filters are all package-level primitives.
- Context management has multiple layers: memory loading, Arrow-based memory budgeting, phase-aware retention, tool-result pruning, orphaned tool-pair repair, summarization, and token lifecycle compression.
- Provider fallback and circuit breaker state are documented honestly as selection-time behavior, reducing hidden semantics for framework consumers.
- Audit logging primitives exist at the core event and compliance-store layers, with typed events for LLM invocation and tool lifecycle.

## Open Questions Or Assumptions

- I assume side-effecting tools may receive sensitive arguments and may not uniformly honor cancellation, because the current `StructuredToolInterface.invoke()` call sites do not pass a cancellation context.
- I assume `stream()` is a supported production execution path equivalent to `generate()` for policy purposes, because `DzupAgentConfig.toolExecution` documents both `generate()` and `stream()` as governed surfaces.
- I did not verify whether downstream applications attach `ComplianceAuditLogger` in production; the audit-leak finding is based on the framework event payloads and logger behavior when attached.
- I did not verify external provider SDK behavior or retry semantics beyond the registry and agent wrapper code in this repository.

## Recommended Next Actions

1. Fix AGENT-002 first: make streaming approval-required tools a hard stop before any tool invocation, then add stream/generate parity tests.
2. Fix AGENT-001 next: remove raw tool input values from canonical events and compliance audit details, then add redaction regression tests against `ComplianceAuditLogger`.
3. Align streaming token lifecycle with the non-streaming tool loop by adding compression and halt checks before streaming tool execution.
4. Decide scanner failure policy for untrusted tool results and implement fail-closed mode where tool output can influence subsequent model behavior.
5. Add cancellation-capable tool execution context and document timeout semantics until existing tools adopt cancellation.
6. Bound Arrow memory fallback and emit success/failure memory write-back events so memory behavior is visible in audit and operations.
7. Treat run-level provider failover as a separate primitive from registry selection-time fallback, with explicit idempotency and audit metadata.
