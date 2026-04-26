## Findings

### High: Public `DzupAgent` runs cannot consistently enforce the tool-loop policy surface

Impact: The reusable tool loop contains meaningful controls for tool governance, safety scanning, per-tool timeouts, argument validation, tracing, and tool permissions, but the top-level agent configuration and normal `generate()` path do not expose or thread most of those controls. Consumers using `DzupAgent` as the framework abstraction can run tools without the policy controls that exist in `runToolLoop()` unless they bypass the agent and call the lower-level loop directly.

Evidence: `ToolLoopConfig` defines policy and enforcement controls such as `toolGovernance`, `safetyMonitor`, `scanToolResults`, `toolTimeouts`, `tracer`, `agentId`, and `toolPermissionPolicy` in `packages/agent/src/agent/tool-loop.ts:157`. The sequential executor enforces permission checks, governance decisions, validation, timeout racing, and tool-result safety scanning in `packages/agent/src/agent/tool-loop.ts:668`, `packages/agent/src/agent/tool-loop.ts:694`, `packages/agent/src/agent/tool-loop.ts:736`, `packages/agent/src/agent/tool-loop.ts:764`, and `packages/agent/src/agent/tool-loop.ts:775`. `DzupAgentConfig` exposes `guardrails`, `eventBus`, memory, middleware, and token lifecycle fields but does not expose corresponding fields for those tool-loop controls in `packages/agent/src/agent/agent-types.ts:27`. `executeGenerateRun()` passes budget, stuck detection, usage, result transform, latency, and compression callbacks into `runToolLoop()`, but not governance, safety monitor, tool timeouts, permissions, validation, tracer, or agent identity in `packages/agent/src/agent/run-engine.ts:192`.

Remediation: Promote the active tool-execution controls into `DzupAgentConfig` through a nested `toolExecution` or `toolPolicy` object, then thread them through `prepareRunState()` and `executeGenerateRun()` into `runToolLoop()`. Add `DzupAgent.generate()` tests that prove blocked tools, approval-required tools, invalid args, unsafe tool output, permission denial, and per-tool timeout behavior are enforceable from the public agent API.

### High: Native streaming tool execution bypasses non-streaming guardrails

Impact: Agents using native model streaming can execute tools through a separate helper that does not mirror the non-streaming executor. The same agent can therefore enforce one set of policy in `generate()` or stream fallback mode, but a weaker set in native `stream()` mode.

Evidence: `streamRun()` takes the native streaming branch when the bound model has `stream()` and middleware does not wrap model calls in `packages/agent/src/agent/streaming-run.ts:104`. In that branch, tool calls are delegated to `executeStreamingToolCall()` in `packages/agent/src/agent/streaming-run.ts:245`. The streaming helper checks only budget-blocked tools and tool existence before invoking `tool.invoke(toolCall.args)` in `packages/agent/src/agent/run-engine.ts:414`, `packages/agent/src/agent/run-engine.ts:425`, and `packages/agent/src/agent/run-engine.ts:440`. It does not apply `ToolGovernance`, `toolPermissionPolicy`, argument validation, `toolTimeouts`, `safetyMonitor`, or tracing. The non-streaming path has those enforcement points in `packages/agent/src/agent/tool-loop.ts:668`, `packages/agent/src/agent/tool-loop.ts:694`, `packages/agent/src/agent/tool-loop.ts:736`, `packages/agent/src/agent/tool-loop.ts:764`, and `packages/agent/src/agent/tool-loop.ts:775`.

Remediation: Extract a shared single-tool executor and use it from sequential, parallel, and native streaming paths. Add generate-vs-stream parity tests with a streaming-capable mock model for denied tools, invalid args, timeout, unsafe result, stuck detection, and telemetry output.

### High: Parallel tool execution bypasses governance and safety scanning

Impact: Even callers that invoke `runToolLoop()` directly with policy controls can lose enforcement when parallel tool execution is enabled. A tool that would be blocked, approval-marked, or safety-filtered in the sequential path can run in the parallel path because the parallel preflight and registry wrapper implement a different subset of the policy stack.

Evidence: The parallel pre-validation loop checks `toolPermissionPolicy`, budget-blocked tools, tool existence, and argument validation in `packages/agent/src/agent/tool-loop.ts:914`. It does not call `config.toolGovernance.checkAccess()`, unlike the sequential path in `packages/agent/src/agent/tool-loop.ts:694`. The parallel `wrappedRegistry` enforces timeout and result transformation only in `packages/agent/src/agent/tool-loop.ts:987`; result mapping appends the returned result and calls `onToolResult` without `safetyMonitor.scanContent()` in `packages/agent/src/agent/tool-loop.ts:1027`. The sequential path scans tool results and blocks unsafe output in `packages/agent/src/agent/tool-loop.ts:775`.

Remediation: Move all pre-call and post-call policy checks into the shared tool executor, then have the parallel executor schedule that executor rather than reimplementing a partial version. Add tests that run the same two-tool plan with `parallelTools: true` and `parallelTools: false` and assert identical governance, approval, validation, timeout, and safety outcomes.

### Medium: Approval-required tools emit an event but continue without an in-loop gate

Impact: `ToolGovernance` can classify a tool as requiring approval, but the agent loop treats that as notification-only. A write, deploy, or external-action tool can still execute immediately after `approval:requested` is emitted unless every caller has added a separate blocking layer around the loop.

Evidence: `ToolGovernanceConfig.approvalRequired` is a first-class policy input in `packages/core/src/tools/tool-governance.ts:10`. `checkAccess()` returns `{ allowed: true, requiresApproval: true }` for those tools in `packages/core/src/tools/tool-governance.ts:95`. The sequential executor emits `approval:requested` and then continues toward tool lookup and execution in `packages/agent/src/agent/tool-loop.ts:708`. The inline comment explicitly says the loop does not block and that the wait is the caller's responsibility in `packages/agent/src/agent/tool-loop.ts:709`. The event uses the local tool call ID as `runId` in `packages/agent/src/agent/tool-loop.ts:713`, which is weaker than a durable enclosing run/session correlation ID.

Remediation: Decide whether approval is a hard gate or notification. If it is a hard gate, return a suspended or blocked `ToolMessage` until an `ApprovalGate` decision is supplied, and use a real run ID for correlation. If notification-only is intended, rename or document it as such and avoid implying human-in-the-loop enforcement.

### Medium: Tool audit logging primitives are not wired to complete framework execution provenance

Impact: The repo has audit-log abstractions and OTel event mappings for tool lifecycle events, but the primary agent tool path does not emit the canonical tool events or call the governance audit methods. Operators may get LLM invocation and latency telemetry without enough provenance to reconstruct which tool ran, with what sanitized input, under which run, and whether it succeeded or failed.

Evidence: `ComplianceAuditLogger` maps `tool:called` and `tool:error` to audit actions in `packages/core/src/security/audit/audit-logger.ts:28`. The OTel audit trail maps `tool:called`, `tool:result`, and `tool:error` in `packages/otel/src/audit-trail.ts:168`. `ToolGovernance` exposes `audit()` and `auditResult()` callbacks in `packages/core/src/tools/tool-governance.ts:103`, but the tool loop only calls `checkAccess()` and does not call those audit methods in `packages/agent/src/agent/tool-loop.ts:694`. `executeGenerateRun()` emits `llm:invoked` and `tool:latency`, while `onToolResult` only charges token lifecycle accounting and does not emit `tool:result` or `tool:error` in `packages/agent/src/agent/run-engine.ts:224` and `packages/agent/src/agent/run-engine.ts:239`.

Remediation: Define one canonical tool execution telemetry contract and emit it from the shared executor. Include agent ID, durable run ID when available, tool call ID, tool name, sanitized input metadata, result status, duration, and error code/message. Either wire `ToolGovernance.audit()`/`auditResult()` into that executor or deprecate those methods in favor of the canonical event path.

### Medium: Provider fallback is selection-time only and native streaming misses provider outcome recording

Impact: Tier-based model resolution skips providers with open circuits and records failures for future selection, but it does not retry the current run on the next healthy provider after an invocation failure. Native streaming also calls the model stream directly, so provider success/failure recording used by the circuit breaker is not applied there.

Evidence: `DzupAgent` resolves the model once in the constructor in `packages/agent/src/agent/dzip-agent.ts:100`. Tier strings call `registry.getModelWithFallback()` once and store the selected provider in `packages/agent/src/agent/dzip-agent.ts:341`. `invokeModelWithMiddleware()` records success or failure for only that selected provider and then rethrows failures in `packages/agent/src/agent/dzip-agent.ts:485`. `ModelRegistry.getModelWithFallback()` itself documents selection-time fallback and says invocation outcomes should be recorded afterward in `packages/core/src/llm/model-registry.ts:319`. Native streaming calls `streamModel.stream(allMessages)` directly in `packages/agent/src/agent/streaming-run.ts:180` rather than using `invokeModelWithMiddleware()`, so the success/failure recording in `packages/agent/src/agent/dzip-agent.ts:494` is bypassed for that path.

Remediation: Clarify whether fallback means provider selection for future runs or same-run recovery. If same-run failover is intended, move tier resolution and invocation into a registry method that can retry the ordered provider chain for both invoke and stream. If selection-only is intended, rename or document the behavior and ensure native streaming still records provider success/failure.

### Low: Memory and context fallback behavior loses diagnostic detail

Impact: Non-fatal memory and context failures protect run availability, but several fallback paths suppress the cause or report only zeroed token counts. This makes it hard for operators to distinguish "no memory configured" from "memory configured but unavailable" or "context was dropped due to budget."

Evidence: Arrow memory load failures are caught and reported only as `arrow_fallback` with `0, 0` before falling back to the standard memory path in `packages/agent/src/agent/memory-context-loader.ts:95` and `packages/agent/src/agent/memory-context-loader.ts:110`. A zero memory budget reports `budget_zero` with `0, 0` in `packages/agent/src/agent/memory-context-loader.ts:155`. Standard memory load failures during `prepareMessages()` are swallowed without a fallback event in `packages/agent/src/agent/dzip-agent.ts:383`. Summary-compression failures are also swallowed in `packages/agent/src/agent/dzip-agent.ts:433`.

Remediation: Preserve non-fatal behavior, but emit structured fallback events with reason, provider/path, namespace, redacted scope metadata, and before/after token estimates when available. Add tests for Arrow runtime failure, standard memory load failure, zero budget, and summary failure so dashboards can separate absence, outage, and truncation.

## Scope Reviewed

This is a static current-code review of the agent-pattern domain. I reviewed current repository code for:

- Tool loop and tool execution: `packages/agent/src/agent/tool-loop.ts`, `packages/agent/src/agent/run-engine.ts`, `packages/agent/src/agent/streaming-run.ts`, `packages/agent/src/agent/dzip-agent.ts`
- Guardrails and safety surfaces: `packages/agent/src/guardrails/**`, `packages/core/src/tools/tool-governance.ts`, `packages/core/src/security/**`
- Memory and context management: `packages/agent/src/agent/memory-context-loader.ts`, `packages/context/**`, `packages/memory*/**`
- Orchestration and adapter patterns: `packages/agent/src/orchestration/**`, `packages/agent-adapters/src/orchestration/**`, `packages/agent-adapters/src/recovery/**`, `packages/agent-adapters/src/registry/**`
- Provider fallback and LLM integration: `packages/core/src/llm/model-registry.ts`, `packages/agent/src/agent/dzip-agent.ts`, `packages/agent/src/agent/streaming-run.ts`
- Audit logging and observability: `packages/core/src/security/audit/audit-logger.ts`, `packages/otel/src/audit-trail.ts`, `packages/otel/src/safety-monitor.ts`, `packages/agent-adapters/src/registry/event-bus-bridge.ts`

No build, typecheck, lint, test, or runtime validation command was run for this audit document. The evidence above is static source review only.

Baseline review is kept separate from implementation status: existing audit documents under `docs/` and the run directory were treated as comparison context only, not as evidence that fixes are implemented.

Comparison to the local audit command taxonomy is structural only. The prepared manifest declares `/audit:full dzupagent` with domains `code`, `security`, `architecture`, `agent`, and `design` in `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/manifest.json:10`. The local agent command defines the agent domain structurally around tool loops, memory, context, guardrails, orchestration, and LLM integration in `/media/ninel/Second/code/datazup/ai-internal-dev/.claude/commands/audit/agent.md:136`. Those taxonomy files were not used as evidence of runtime behavior.

## Strengths

- The core ReAct loop has a clear stop-reason model, iteration and token/cost budgets, stuck detection, usage accounting, per-tool stats, optional compression, and result transformation hooks.
- Guardrail primitives are decomposed into focused modules such as iteration budget, stuck detection, token lifecycle plugins, and output filtering instead of being one opaque policy block.
- Memory context loading supports standard memory retrieval, Arrow-backed token-budgeted selection, frozen snapshots, and non-fatal fallback behavior.
- Orchestration and adapters cover several useful patterns: sequential and parallel execution, supervisor and map-reduce patterns, contract-net style coordination, checkpoint stores, recovery policies, event bus bridges, and provider-specific adapter normalization.
- Provider selection uses a circuit-breaker-aware registry and records provider success/failure in the normal non-streaming invocation path.
- Audit and observability building blocks exist across core and OTel layers, including compliance audit logging, audit trail mapping, safety monitoring, cost attribution, and adapter event bridging.

## Consistency Failures

- The prepared manifest lists `implementation/implementation-task-manifest.json` as an expected output in `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/manifest.json:32`, but that file is not present under the prepared prompt pack. I did not infer implementation task totals or reconcile implementation status from missing material.
- The local command taxonomy exists at the workspace level under `/media/ninel/Second/code/datazup/ai-internal-dev/.claude/commands/audit/`, while this `dzupagent` checkout does not contain a repo-local `.claude/commands/audit` directory. I used the workspace-level taxonomy structurally and did not treat it as current-code evidence.

## Open Questions Or Assumptions

- I assumed `docs/AGENT-AUDIT.md` is the requested repository-local target path for this step, not the audit run directory copy.
- It is unclear whether `ToolGovernance.requiresApproval` is intended to be a hard human-in-the-loop gate or only an event notification.
- It is unclear whether provider fallback is intended to recover within the same run or only influence future model selection after circuit-breaker state changes.
- I did not verify whether downstream server or application wrappers add the missing tool provenance events around `DzupAgent` runs; findings are scoped to the framework and adapter paths reviewed above.
- I did not run the existing test suite, so I did not verify whether any tests already encode the desired behavior for these gaps.

## Recommended Next Actions

1. Make `DzupAgent` the authoritative public contract for tool policy by exposing and threading governance, permissions, validation, timeouts, safety scanning, tracing, and run identity into all execution modes.
2. Extract a single shared tool-call executor and route sequential, parallel, and native streaming tool execution through it.
3. Decide approval semantics and either enforce a blocking approval gate or rename/document the current event-only behavior.
4. Define canonical tool lifecycle audit events and emit them from the shared executor with durable run correlation and sanitized input/result metadata.
5. Clarify provider fallback semantics, then implement same-run failover for both invoke and stream or document selection-only fallback and close the native-stream provider-recording gap.
6. Improve memory/context fallback telemetry while keeping memory failures non-fatal.
