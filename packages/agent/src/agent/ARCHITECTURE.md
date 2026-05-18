# `src/agent` Architecture

## Scope
This document describes the implementation under `packages/agent/src/agent` in `@dzupagent/agent`.

In scope:
- Core runtime and configuration surfaces in `dzip-agent.ts`, `agent-types*.ts`, and constructor wiring helpers.
- Generate/stream execution machinery in `run-engine*.ts`, `streaming-run*.ts`, and `tool-loop*.ts`.
- Policy/governance and tool execution support (`tool-lifecycle-policy.ts`, `tool-arg-validator.ts`, `production-tool-governance-preset.ts`, `tool-registry.ts`, `parallel-executor.ts`).
- Memory/instruction/message preparation and finalization (`instruction-resolution.ts`, `memory-context-loader*.ts`, `message-preparation.ts`, `agent-finalizers.ts`, `consolidation-coordinator.ts`).
- Background-run controls (`daemon-launcher.ts`, `run-handle.ts`, `run-handle-types.ts`, `resume-utils.ts`).

Out of scope:
- Sibling module families such as `src/orchestration/**`, `src/pipeline/**`, `src/workflow/**`, `src/replay/**`, and package-wide barrel design beyond direct integration points from this runtime.

## Responsibilities
`src/agent` is the package’s single-agent execution kernel. It is responsible for:
- Constructing `DzupAgent` from `DzupAgentConfig`, including early config validation and model/tokenizer/rate-limiter resolution.
- Resolving model/provider strategy from direct model, model tier, or registry model name.
- Preparing run inputs: instructions, optional AGENTS.md merge, phase-aware windowing, memory context loading, and conversation summary threading.
- Enforcing guardrails and governance around model/tool execution (iteration and token budgets, stuck detection, permission policies, governance approvals, argument validation, per-tool timeouts, safety scans).
- Coordinating both non-streaming (`generate`) and streaming (`stream`) loops with shared lifecycle semantics.
- Supporting structured output via native structured-output path when available, with text+JSON parse/correction fallback.
- Emitting runtime telemetry to `eventBus` for tool lifecycle, stop reasons, fallback events, provider failover, and token halt scenarios.
- Optional run-state snapshot persistence (`runStateStore`) and optional memory write-back/consolidation.
- Providing asynchronous background run control via `RunHandle` (`pause`, `resume`, `cancel`, `fork`, `resumeFromStep`, `result`).

## Structure
Primary files by concern:
- Core agent class and composition: `dzip-agent.ts`, `agent-construction.ts`, `event-bus-installer.ts`, `provider-selection.ts`, `model-invocation.ts`, `rate-limit-coordinator.ts`.
- Run engine and generation: `run-engine.ts`, `run-engine-generate-tool-loop.ts`, `run-engine-generate-process.ts`, `run-engine-generate-audit.ts`, `run-engine-generate-snapshot.ts`, `run-engine-defaults.ts`.
- Streaming execution: `streaming-run.ts`, `streaming-run-iteration.ts`, `streaming-run-provider.ts`, `streaming-run-tool-handler.ts`, `streaming-run-policy.ts`, `streaming-run-fallback.ts`.
- Tool loop kernel and policy stages: `tool-loop.ts`, `tool-loop/model-turn-kernel.ts`, `tool-loop/tool-scheduler-kernel.ts`, `tool-loop/policy-checks.ts`, `tool-loop/policy-enabled-tool-executor.ts`, `tool-loop/tool-invoker.ts`, `tool-loop/result-pipeline.ts`, `tool-loop/loop-stages.ts`.
- Context/instruction/memory preparation: `instruction-resolution.ts`, `message-preparation.ts`, `memory-context-loader.ts`, `memory-context-loader-*.ts`, `memory-profiles.ts`.
- Finalization and persistence helpers: `agent-finalizers.ts`, `consolidation-coordinator.ts`, `resume-utils.ts`.
- Background run control: `daemon-launcher.ts`, `run-handle-types.ts`, `run-handle.ts`.
- Public support utilities: `production-tool-governance-preset.ts`, `tool-arg-validator.ts`, `parallel-executor.ts`, `tool-registry.ts`, `agent-factory.ts`.

## Runtime and Control Flow
1. Construction: `DzupAgent` runs `validateConfig`, `resolveModel`, `resolveRateLimiter`, `resolveTokenizer`, and `installEventBus`; tool visibility is constrained via permission tier filtering (`filterToolsByTier`) with `agent:tools-filtered` audit emission.
2. Pre-run preparation (`prepareRunState`): computes guardrail defaults, runs `prepareMessages`, optionally rehydrates from journal (`options._resume.lastStateSeq`), scans/sanitizes human input using `config.security`, injects prompt-cache markers, and applies issuance-time permission-policy tool filtering before model binding.
3. Non-streaming run (`generate` -> `executeGenerateRun`): `setupModelCall` builds `ToolLoopConfig` with policy/telemetry/token-lifecycle wiring, `runToolLoop` executes model+tool turns, `processGeneratedRun` emits terminal telemetry and post-filters output, and non-failed runs can write back memory.
4. Streaming run (`stream` -> `streamRun`): reuses `prepareRunState`, chooses native stream or fallback mode, then handles chunk emission, usage accounting, compression adoption, tool-call handling, and terminal finalization.
5. Tool execution policy stack: `executePolicyEnabledToolCall` applies permission/governance/approval checks, validation, timeout/retry, safety scan, output validation, lifecycle telemetry, and stuck escalation behavior.
6. Provider failover behavior: construction-time resolution may use registry fallback, same-run failover may use provider attempts from `getModelFallbackCandidates` through `attemptWithFailover`, and retry behavior is gated by tool-result-aware failover policy.
7. Structured output: `generateStructured` emits schema telemetry, attempts native `withStructuredOutput`, and falls back to text+JSON extraction with correction retries and enriched error context.
8. Background runs: `launchDaemon` creates `InMemoryRunJournal` + `ConcreteRunHandle`, starts async execution, and maps completion/failure into run-handle result state.

## Key APIs and Types
Public runtime APIs exported via `src/agent.ts` and root exports:
- `DzupAgent`
- `createAgentWithMemory`
- `runToolLoop`
- `executeToolsParallel`
- `ConcreteRunHandle`
- `validateAndRepairToolArgs`, `formatSchemaHint`
- `createProductionToolGovernancePreset`, `withProductionToolGovernancePreset`, `createAllowlistPermissionPolicy`
- `DynamicToolRegistry`, `OwnershipPermissionPolicy`
- `ToolOutputValidator`

Primary runtime types:
- `DzupAgentConfig`
- `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`
- `ToolExecutionConfig`, `PerToolTimeoutMap`, `ArgumentValidator`, `ToolTracer`
- `ToolLoopConfig`, `ToolLoopResult`, `StopReason`, `ToolStat`
- `RunHandle`, `RunResult`, `LaunchOptions`, `CheckpointInfo`
- `ProviderFailoverPolicy`, `MemoryProfilePreset`, `ArrowMemoryConfig`

Notable internal coordinators (not main external API):
- `prepareRunState`, `executeGenerateRun`, `streamRun`, `generateStructured`
- `invokeModelWithMiddleware`, `attemptWithFailover`
- `runConsolidation`, `launchDaemon`

## Dependencies
Package-level dependencies from `package.json` that this module family relies on:
- `@dzupagent/core`
- `@dzupagent/context`
- `@dzupagent/memory`
- `@dzupagent/memory-ipc`
- `@dzupagent/security`
- `@dzupagent/agent-types`
- `@dzupagent/adapter-types`
- `@dzupagent/runtime-contracts`

Peer dependencies used by this runtime surface:
- `@langchain/core`
- `@langchain/langgraph` (peer surface for package, though `src/agent` itself primarily uses `@langchain/core`)
- `zod`

Direct Node/runtime primitives used in this scope:
- `node:crypto` (`randomUUID` and related helpers)

## Integration Points
Internal package integration points:
- `src/tools/agent-as-tool.ts` wraps `DzupAgent.generate` into LangChain tool form.
- `src/guardrails/**`, `src/approval/**`, `src/observability/**`, `src/reflection/**` are called from this runtime path.
- `src/orchestration/**` and `src/workflow/**` consume the `DzupAgent` runtime and run-handle semantics rather than re-implementing loops.

Cross-package contracts:
- Model registry and provider fallback (`@dzupagent/core/llm`) for model selection and circuit-breaker accounting.
- Event bus (`@dzupagent/core/events`) for lifecycle and audit telemetry.
- Memory service and consolidation (`@dzupagent/memory`) plus optional Arrow runtime loader (`@dzupagent/memory-ipc`).
- Security scanners (`@dzupagent/security`) for input and memory-write sanitation controls.
- Persistence (`@dzupagent/core/persistence`) for run journals and optional `runStateStore` snapshots.

## Testing and Observability
Testing coverage in this package includes dedicated runtime tests under `src/__tests__`, with agent-focused suites such as:
- `dzip-agent.test.ts`, `dzip-agent-run-parity.test.ts`, `dzip-agent-provider-fallback.test.ts`, `dzip-agent-tool-policy.test.ts`
- `run-engine.test.ts`, `run-engine-resume.test.ts`, `run-engine-generate-helpers.test.ts`, `run-engine-streaming-helpers.test.ts`
- `tool-loop-core.test.ts`, `tool-loop-deep.test.ts`, `tool-loop-approval.test.ts`, `tool-loop-token-halt.test.ts`, `tool-loop-retry.test.ts`, `policy-enabled-tool-executor.test.ts`
- `streaming.test.ts`, `streaming-run-failover.test.ts`, `stream-tool-guardrail-parity.test.ts`
- `memory-context-loader.test.ts`, `memory-context-loader-branches.test.ts`, `memory-context-fallback-detail.test.ts`
- `run-handle.test.ts`, `run-handle-terminal-branches.test.ts`, `run-state-store.test.ts`

Observed telemetry/event surfaces emitted directly from this runtime:
- Agent lifecycle and fallback: `agent:tools-filtered`, `agent:context_fallback`, `agent:stuck_detected`, `agent:stop_reason`, `agent:rate_limited`
- Token and model flow: `llm:invoked`, `run:halted:token-exhausted`
- Tool lifecycle: `tool:called`, `tool:result`, `tool:error`, `tool:latency`, `tool:cancel_requested`, `tool:output:invalid`
- Governance/provider: `approval:requested`, `provider:run_attempt`, `provider:run_selected`, `provider:run_failure`
- Structured output: `agent:structured_schema_prepared`, `agent:structured_native_rejected`, `agent:structured_fallback_used`, `agent:structured_validation_failed`
- Memory write-back path: `memory:written`, `memory:error`

## Risks and TODOs
- `GenerateResult` includes optional `learnings`, but current generate path does not populate that field. `prepareRunState` initializes learning-hook loading only.
- `launchDaemon` currently uses `InMemoryRunJournal`; background-run control is process-local unless callers build a separate durable resume pattern.
- Streaming and non-streaming paths intentionally share policy concepts but are implemented in separate coordinators; parity depends on continued synchronized updates to both stacks.
- Legacy and modern summarization/finalizer helpers coexist (`message-preparation.ts` and `agent-finalizers.ts` include overlapping concerns). Functional behavior is preserved, but ownership boundaries should stay explicit to avoid drift.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: refreshed against current `packages/agent/src/agent` runtime, streaming, policy, and run-handle implementation.