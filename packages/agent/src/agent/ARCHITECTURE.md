# `src/agent` Architecture

## Scope
This document describes the implementation under `packages/agent/src/agent` in `@dzupagent/agent`.

In scope:
- core runtime class in `dzip-agent.ts`
- run orchestration helpers in `run-engine.ts`, `streaming-run.ts`, and `structured-generate.ts`
- loop/runtime primitives in `tool-loop.ts`, `parallel-executor.ts`, `tool-arg-validator.ts`, and `stuck-error.ts`
- context and instruction helpers in `instruction-resolution.ts`, `memory-context-loader.ts`, `memory-profiles.ts`, `message-utils.ts`, `middleware-runtime.ts`, and `resume-utils.ts`
- launch and run-control APIs in `daemon-launcher.ts`, `run-handle.ts`, and `run-handle-types.ts`
- supporting surfaces in `agent-types.ts`, `tool-loop-learning.ts`, `tool-registry.ts`, `agent-state.ts`, `agent-factory.ts`, and `agent-finalizers.ts`

Out of scope:
- sibling subsystems under `src/orchestration/**`, `src/pipeline/**`, templates, approval, replay, and other package-level modules that consume this runtime

## Responsibilities
`src/agent` is the execution kernel for top-level agent runs.

It is responsible for:
- constructing and configuring `DzupAgent` from `DzupAgentConfig`
- model resolution from direct model, tier, or registry name with provider-fallback selection behavior
- preparing run inputs with instruction resolution, phase windowing, memory context, and conversation summary
- executing the ReAct loop (`runToolLoop`) with budgets, stuck detection, tool invocation, token accounting, and stop reasons
- streaming and non-streaming execution paths with shared preparation and post-run finalization
- structured-output generation with native structured output first, then text+JSON correction fallback
- optional mailbox tool wiring (`send_mail`, `check_mail`) when mailbox config is present
- optional memory write-back of final output
- optional background runs via `launch()` and `RunHandle`
- runtime telemetry emission through `eventBus`

## Structure
Primary files by concern:
- entrypoint runtime: `dzip-agent.ts`, `agent-types.ts`
- run execution: `run-engine.ts`, `tool-loop.ts`, `streaming-run.ts`, `structured-generate.ts`
- runtime helpers: `instruction-resolution.ts`, `memory-context-loader.ts`, `memory-profiles.ts`, `middleware-runtime.ts`, `message-utils.ts`, `resume-utils.ts`
- tooling/state helpers: `tool-arg-validator.ts`, `parallel-executor.ts`, `stuck-error.ts`, `tool-loop-learning.ts`, `tool-registry.ts`, `agent-state.ts`
- background run support: `daemon-launcher.ts`, `run-handle.ts`, `run-handle-types.ts`
- factory/finalizer helpers: `agent-factory.ts`, `agent-finalizers.ts`

## Runtime and Control Flow
1. Construction
- `DzupAgent` resolves model via `resolveModel()`.
- Model resolution rules: direct `BaseChatModel` uses the instance; tier strings use `registry.getModelWithFallback(...)`; name strings use `registry.getModelByName(...)`.
- Constructor initializes optional mailbox, instruction resolver, memory context loader, and middleware runtime.

2. `generate()`
- Calls `prepareRunState(...)` to resolve iteration limits and optional `IterationBudget`, prepare messages, bind tools, initialize stuck detection, and optionally rehydrate from journal (`options._resume.lastStateSeq`).
- Calls `executeGenerateRun(...)`, which delegates to `runToolLoop(...)`, applies optional tool-execution policy forwarding (`toolExecution.*`), emits telemetry, applies optional `guardrails.outputFilter`, updates summary, and runs optional reflection callback.
- Returns `GenerateResult` with content, messages, usage, stop reason, tool stats, and optional memory/compression fields.
- On non-failed runs, optionally writes final content to memory when write-back is enabled.

3. `stream()`
- Uses `streamRun(...)`.
- Fallback mode is used when native streaming is unavailable or model-call middleware wrapping is enabled; fallback delegates to `executeGenerateRun(...)` and emits synthesized stream events.
- Native mode yields `text`, `tool_call`, `tool_result`, `budget_warning`, `stuck`, and `done` events while sharing preparation and finalization behavior.

4. Tool loop (`runToolLoop`)
- Performs per-iteration abort/budget checks and iteration warning handling.
- Optionally injects tool performance hint text before model calls.
- Tracks usage, optional compression (`maybeCompress`), and optional halt (`shouldHalt`).
- Executes tool calls sequentially or in parallel.
- Supports governance, approval-gating, permission policy checks, argument validation/repair, timeouts, safety scanning, tracing, and canonical lifecycle telemetry.
- Stop reasons include `complete`, `iteration_limit`, `budget_exceeded`, `aborted`, `error`, `stuck`, `token_exhausted`, and `approval_pending`.

5. Background runs
- `launchDaemon(...)` creates an in-memory journal and `ConcreteRunHandle`, then starts async `generate(...)`.
- `ConcreteRunHandle` provides pause/resume/cancel/result/fork/checkpoint/resume-from-step semantics.

## Key APIs and Types
Runtime APIs:
- `DzupAgent` with `generate`, `stream`, `generateStructured`, `asTool`, and `launch`
- `runToolLoop(model, messages, tools, config)`
- `executeToolsParallel(...)`
- `validateAndRepairToolArgs(...)` and `formatSchemaHint(...)`
- `createAgentWithMemory(...)`
- `launchDaemon(...)`
- `ConcreteRunHandle`
- `DynamicToolRegistry` and `OwnershipPermissionPolicy`
- legacy adapters: `serializeMessages(...)` and `deserializeMessages(...)`

Core types:
- `DzupAgentConfig`
- `GenerateOptions`
- `GenerateResult`
- `AgentStreamEvent`
- `ToolExecutionConfig`, `PerToolTimeoutMap`, `ArgumentValidator`, `ToolTracer`
- `ToolLoopConfig`, `ToolLoopResult`, `StopReason`, `ToolStat`
- `RunHandle`, `RunResult`, `LaunchOptions`, `CheckpointInfo`

## Dependencies
External dependencies used directly by `src/agent`:
- `@langchain/core` (`messages`, `chat_models`, `tools`)
- `zod`
- `@dzupagent/core`
- `@dzupagent/context`
- `@dzupagent/memory`
- `@dzupagent/memory-ipc` (dynamically imported in memory loader)
- `@dzupagent/agent-types`
- `node:crypto`

Internal dependencies in `packages/agent/src`:
- `guardrails`
- `instructions`
- `mailbox`
- `reflection`
- `token-lifecycle-wiring`
- `tools/agent-as-tool`

## Integration Points
Internal package integrations:
- `src/orchestration/**` consumes `DzupAgent` and related exports from this module
- `src/__tests__/**` exercises both direct `agent/*` internals and orchestrator paths that depend on `DzupAgent`

Operational integration hooks via `eventBus` include:
- `agent:context_fallback`
- `agent:stuck_detected`
- `agent:stop_reason`
- `run:halted:token-exhausted`
- `llm:invoked`
- `tool:latency`
- `agent:structured_schema_prepared`
- `agent:structured_native_rejected`
- `agent:structured_fallback_used`
- `agent:structured_validation_failed`
- `tool:called`
- `tool:result`
- `tool:error`
- `approval:requested`

## Testing and Observability
Representative tests for this module:
- core runtime: `dzip-agent.test.ts`, `dzip-agent-run-parity.test.ts`, `dzip-agent-concurrency.test.ts`, `dzip-agent-provider-fallback.test.ts`, `dzip-agent-tool-policy.test.ts`
- loop/tool behavior: `tool-loop-core.test.ts`, `tool-loop-deep.test.ts`, `tool-loop-approval.test.ts`, `tool-loop-token-halt.test.ts`, `parallel-tool-loop.test.ts`, `parallel-tool-governance-parity.test.ts`, `tool-loop-canonical-audit.test.ts`, `tool-timeout.test.ts`, `tool-permission.test.ts`
- run engine/memory/middleware: `run-engine.test.ts`, `run-engine-resume.test.ts`, `memory-context-loader.test.ts`, `memory-context-loader-branches.test.ts`, `memory-context-fallback-detail.test.ts`, `middleware-runtime.test.ts`
- launch/run handle: `run-handle.test.ts`, `run-handle-terminal-branches.test.ts`

Observability outputs include:
- event-bus telemetry listed above
- run-return telemetry in `GenerateResult`: usage, stopReason, toolStats, optional compression log, optional memory frame

## Risks and TODOs
- `streaming-run.ts` builds and passes a `policy` object into `executeStreamingToolCall(...)`, but `executeStreamingToolCall` in `run-engine.ts` currently does not accept/use that policy object. This is a drift risk for native streaming policy parity.
- `GenerateResult` defines optional `learnings`, but `executeGenerateRun(...)` currently does not populate that field. Self-learning setup is partially initialized without result projection.
- `agent-finalizers.ts` duplicates summary and memory write-back behavior that currently also exists as private methods in `DzupAgent`. This raises maintenance drift risk unless one path is made canonical.
- `src/index.ts` exports `dzupagent_AGENT_VERSION = '0.1.0'` while `packages/agent/package.json` is `0.2.0`. This version-surface mismatch can mislead consumers.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: refreshed against current `packages/agent/src/agent` implementation (runtime flow, policy surfaces, stop reasons, run-handle integration, testing, and observability).

