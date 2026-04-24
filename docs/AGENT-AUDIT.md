## Findings

### High: Agent-level executions cannot consistently enforce the tool-loop policy surface

Impact: `runToolLoop()` has hooks for tool governance, safety scanning, per-tool timeouts, and tool permissions, but the public `DzupAgent` configuration and normal `generate()` run path do not expose or pass those controls. Consumers using the framework-level agent abstraction can reasonably believe these guardrails are available because they exist in the loop implementation, while their actual agent runs cannot enable them without bypassing `DzupAgent` and calling `runToolLoop()` directly.

Evidence: `ToolLoopConfig` declares `toolGovernance`, `safetyMonitor`, `scanToolResults`, `toolTimeouts`, `agentId`, and `toolPermissionPolicy` in `packages/agent/src/agent/tool-loop.ts:157`. The sequential tool path enforces permission checks, governance access, timeouts, and result scanning in `packages/agent/src/agent/tool-loop.ts:668`, `packages/agent/src/agent/tool-loop.ts:694`, `packages/agent/src/agent/tool-loop.ts:764`, and `packages/agent/src/agent/tool-loop.ts:775`. `DzupAgentConfig` does not define corresponding fields in `packages/agent/src/agent/agent-types.ts:27`, and `executeGenerateRun()` only passes budget, stuck detection, token lifecycle, telemetry callbacks, and transform hooks into `runToolLoop()` in `packages/agent/src/agent/run-engine.ts:192`.

Remediation: Promote the active policy controls into `DzupAgentConfig` or a nested `toolExecution`/`toolPolicy` config, then thread them through `prepareRunState()`/`executeGenerateRun()` into `runToolLoop()`. Add parity tests at the `DzupAgent.generate()` level proving a blocked tool, unsafe tool output, denied permission, and per-tool timeout are enforced from the public agent API.

### High: Native streaming tool execution bypasses non-streaming guardrails

Impact: Agents using native `stream()` can execute tools through a simpler helper that does not mirror the non-streaming loop's validation and security behavior. This creates mode-dependent behavior for the same agent: fallback streaming reuses `executeGenerateRun()`, but native streaming invokes tools directly without the same governance, permission, timeout, argument validation, or safety-result scanning.

Evidence: `streamRun()` takes the native streaming branch when `model.stream` is available and middleware does not wrap model calls in `packages/agent/src/agent/streaming-run.ts:104`. In that branch, each tool call is delegated to `executeStreamingToolCall()` in `packages/agent/src/agent/streaming-run.ts:245`. `executeStreamingToolCall()` only checks budget-blocked tools and existence before calling `tool.invoke(toolCall.args)` in `packages/agent/src/agent/run-engine.ts:414`, `packages/agent/src/agent/run-engine.ts:425`, and `packages/agent/src/agent/run-engine.ts:440`. By contrast, the non-streaming loop has separate policy, timeout, validation, and safety-scan paths in `packages/agent/src/agent/tool-loop.ts:631`, `packages/agent/src/agent/tool-loop.ts:668`, `packages/agent/src/agent/tool-loop.ts:694`, `packages/agent/src/agent/tool-loop.ts:764`, and `packages/agent/src/agent/tool-loop.ts:775`. The architecture note says streaming tool execution reuses the helper "to keep behavior consistent with generate mode" in `packages/agent/src/agent/ARCHITECTURE.md:65`, but the current helper is not behavior-equivalent.

Remediation: Route native streaming tool execution through the same single-call executor used by `runToolLoop()`, or extract one shared `executeToolCall()` implementation with all policy, validation, timeout, safety, stuck, stats, and telemetry behavior. Add a generate-vs-stream parity test that uses a streaming-capable mock model and asserts the same blocked/denied/timed-out/unsafe outcomes.

### Medium: Approval-required tools emit an event but continue without a gate

Impact: `ToolGovernance` can classify a tool as requiring approval, but the tool loop treats that as notification-only. A write, deploy, or external-action tool can still run immediately after `approval:requested` is emitted, so "requires approval" is not an enforcement boundary unless every caller has added an external blocking layer around the loop.

Evidence: `ToolGovernanceConfig.approvalRequired` is defined as a policy input in `packages/core/src/tools/tool-governance.ts:10`, and `checkAccess()` returns `{ allowed: true, requiresApproval: true }` in `packages/core/src/tools/tool-governance.ts:95`. In the sequential tool path, `requiresApproval` only emits `approval:requested` and then proceeds to tool lookup and execution in `packages/agent/src/agent/tool-loop.ts:708`. The inline comment states that the loop does not block and expects external wiring in `packages/agent/src/agent/tool-loop.ts:709`. The emitted `runId` is the generated tool call ID rather than an enclosing agent run ID in `packages/agent/src/agent/tool-loop.ts:713`.

Remediation: Either rename/document this as an approval notification hook, or make approval-required tools return a suspended/blocked `ToolMessage` until an `ApprovalGate` decision is supplied. If blocking is added, use a real run/session correlation ID instead of the local tool call ID and add tests for grant, reject, and timeout outcomes.

### Medium: Tool audit logging is structural but not wired to complete execution provenance

Impact: The repo has audit-log abstractions, event-to-audit mapping, and a `ToolGovernance` audit handler, but normal agent tool execution does not emit the canonical tool events or call the governance audit methods. This limits forensic reconstruction of which tool ran, with which input, for which agent run, and with what result.

Evidence: `ComplianceAuditLogger` maps `tool:called` and `tool:error` to audit actions in `packages/core/src/security/audit/audit-logger.ts:28`. The OTel audit trail maps `tool:called`, `tool:result`, and `tool:error` in `packages/otel/src/audit-trail.ts:168`. `ToolGovernance` defines `audit()` and `auditResult()` in `packages/core/src/tools/tool-governance.ts:103`, but `runToolLoop()` only uses `checkAccess()` and does not call those audit methods in `packages/agent/src/agent/tool-loop.ts:694`. `executeGenerateRun()` emits `llm:invoked`, `tool:latency`, stuck, halt, and stop-reason events, but does not configure `onToolCall` to emit `tool:called` or `onToolResult` to emit `tool:result`/`tool:error` in `packages/agent/src/agent/run-engine.ts:224` and `packages/agent/src/agent/run-engine.ts:239`.

Remediation: Define one canonical tool execution telemetry contract and emit it from the shared tool executor. Include `agentId`, run ID when available, tool call ID, tool name, sanitized input metadata, result status, duration, and error code/message. Wire `ToolGovernance.audit()`/`auditResult()` or replace them with the canonical event path so audit sinks do not depend on ad hoc callbacks.

### Medium: Provider fallback is selection-time only, not same-run recovery

Impact: Tier-based model resolution skips providers with open circuits and records invocation outcomes, but an invocation failure does not retry the same request on the next provider. A transient provider error can still fail the current agent run even when other providers for the same tier are configured and healthy.

Evidence: `DzupAgent` resolves the model once in the constructor in `packages/agent/src/agent/dzip-agent.ts:100`. Tier strings call `registry.getModelWithFallback()` once and store `resolvedModel` plus `resolvedProvider` in `packages/agent/src/agent/dzip-agent.ts:341`. `invokeModelWithMiddleware()` records provider success or failure around a single model call, then rethrows on failure in `packages/agent/src/agent/dzip-agent.ts:485`. `ModelRegistry.getModelWithFallback()` itself skips open circuits and returns the first creatable model, while documenting that invocation success/failure should be recorded after the call in `packages/core/src/llm/model-registry.ts:319`.

Remediation: Decide whether "fallback" means provider selection only or same-run failover. If same-run failover is intended, move tier resolution into the invocation path or add a registry method that invokes through an ordered provider chain with retry/fallback policy. If selection-only is intended, update docs/API names to avoid implying per-request recovery and expose clear telemetry for "failed on selected provider, next run may choose another provider."

### Low: Memory/context fallback loses diagnostic detail

Impact: Memory and context-management paths favor non-fatal behavior, which is good for availability, but some failures become invisible or under-described. Operators can see that memory was absent from a prompt only in limited cases, not why the standard load failed or how much context was lost.

Evidence: Arrow memory failures are caught and reported only as `arrow_fallback` with `0, 0` before falling back to the standard path in `packages/agent/src/agent/memory-context-loader.ts:95` and `packages/agent/src/agent/memory-context-loader.ts:110`. A zero memory budget reports `budget_zero` with `0, 0` in `packages/agent/src/agent/memory-context-loader.ts:155`. Standard memory failures during `prepareMessages()` are swallowed without emitting a fallback event in `packages/agent/src/agent/dzip-agent.ts:383`. Summary-compression failures are also swallowed in `packages/agent/src/agent/dzip-agent.ts:433`.

Remediation: Keep memory failures non-fatal, but emit structured fallback events with reason, provider/path, namespace, scoped redacted metadata, and before/after token estimates when available. Add tests for Arrow import failure, standard memory load failure, zero budget, and summary failure so dashboards can distinguish "no memory configured" from "memory configured but unavailable."

## Scope Reviewed

This is a static current-code review of the agent-pattern domain. I reviewed the tool loop, native streaming tool execution, guardrails, memory/context loading, orchestration, provider fallback, and audit logging surfaces under:

- `packages/agent/src/agent/**`
- `packages/agent/src/guardrails/**`
- `packages/agent/src/orchestration/**`
- `packages/agent/src/pipeline/**`
- `packages/core/src/llm/**`
- `packages/core/src/tools/**`
- `packages/core/src/security/**`
- `packages/otel/src/audit-trail.ts`

No build, test, typecheck, or runtime validation command was run for this audit document. A quick static scan helper was attempted but was unavailable in this environment (`exit 127`), so it is not treated as validation evidence.

Comparison to the local `/audit:full dzupagent` taxonomy is structural only: the prepared prompt pack defines the `agent` domain alongside code, security, architecture, and design domains, but prior/generated audit artifacts were not treated as evidence for these findings.

## Strengths

- The core ReAct loop has a well-defined stop-reason model, token/cost/iteration budgets, stuck detection, per-tool stats, optional compression, and callbacks for usage, latency, result transformation, and halt telemetry.
- The guardrail primitives are decomposed cleanly: `IterationBudget`, `StuckDetector`, `CascadingTimeout`, token lifecycle plugins, and output filters are separate concerns rather than one opaque policy object.
- Memory context loading supports both a simple memory service path and a token-budgeted Arrow path, with non-fatal fallback behavior that protects run availability.
- Orchestration includes multiple coordination patterns: sequential, parallel, supervisor, debate, routing policies, merge strategies, circuit breakers, contract-net, and team runtime surfaces.
- Provider selection has a circuit-breaker-aware registry and records provider success/failure after invocation for future routing decisions.
- Audit building blocks exist in both core compliance audit logging and OTel audit trail layers, including hash-chain verification concepts and event-bus integration.

## Consistency Failures

- The prepared manifest lists `implementation/implementation-task-manifest.json` as an expected output in `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/manifest.json:28`, but that file is missing under the prepared prompt pack. I did not infer implementation task totals or reconcile downstream implementation counts.
- The existing run-002 domain documents in the audit run directory are treated as comparison/context only. This document is a baseline review artifact and does not claim any implementation status.

## Open Questions Or Assumptions

- I assumed `docs/AGENT-AUDIT.md` is the repository-local target path under the current `dzupagent` checkout, not the audit run directory.
- It is unclear whether `ToolGovernance.requiresApproval` is intentionally notification-only or intended to become a hard human-in-the-loop gate.
- It is unclear whether provider fallback is intended to recover within the same run or only influence future model selection after circuit-breaker state changes.
- I did not verify whether server-level wrappers add missing tool audit/provenance events around `DzupAgent` runs; the finding is scoped to the framework agent paths reviewed above.

## Recommended Next Actions

1. Make the public `DzupAgent` execution contract authoritative for tool policy: expose and thread governance, permissions, timeouts, safety scanning, and argument validation from config into both generate and stream paths.
2. Extract a single shared tool-call executor and use it from sequential, parallel, and native streaming modes.
3. Decide and document approval semantics, then either enforce blocking approval or rename the current behavior as approval notification.
4. Define canonical tool execution audit events and emit them from the shared executor with run correlation.
5. Clarify provider fallback semantics and either implement same-run failover or rename/docs-adjust the selection-only behavior.
6. Improve memory/context fallback telemetry while preserving non-fatal run behavior.
