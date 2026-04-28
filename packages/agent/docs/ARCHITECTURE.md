# @dzupagent/agent Architecture

## Scope
This document describes the current implementation of `packages/agent` in `dzupagent` using the local codebase at `packages/agent/src/**`, `packages/agent/package.json`, `packages/agent/README.md`, and module docs under `packages/agent/src/*/ARCHITECTURE.md`.

It covers package-owned runtime behavior and public exports from `src/index.ts`. It does not restate internals of sibling packages such as `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, and `@dzupagent/memory-ipc`.

## Responsibilities
`@dzupagent/agent` is the main runtime/orchestration package in the framework. It currently owns the following:
- Agent runtime (`DzupAgent`) with `generate`, `generateStructured`, `stream`, `asTool`, and `launch`.
- ReAct-style tool-loop execution (`runToolLoop`) with iteration/cost/token controls, stuck handling, and optional governance/permission/safety hooks.
- Instruction assembly from static instructions plus optional AGENTS.md discovery/merge (`instructionsMode: 'static+agents'`).
- Memory context loading (standard memory service and Arrow-budgeted memory selection) plus optional memory write-back.
- Guardrails (`IterationBudget`, `StuckDetector`, `CascadingTimeout`) and token-lifecycle plugin wiring.
- Workflow DSL (`WorkflowBuilder`) compiled into pipeline definitions and executed through `PipelineRuntime`.
- Pipeline runtime capabilities including validation, retries, loops, fork/join, suspend/resume, checkpoint stores, recovery hooks, and runtime events.
- Multi-agent orchestration patterns including sequential/parallel/supervisor, delegation/planning, contract-net, topology, routing, merge strategies, circuit breaker, and team runtime.
- Structured output utilities (`generateStructuredOutput`, strategy detection/fallback chain).
- Supporting subsystems for tools/schema registry, streaming parser/run handles, replay, snapshot/message serialization, approval gate, security auth/signing, templates/presets, mailbox/cluster, self-correction/reflection/recovery, and skill-chain executor.

## Structure
Top-level source directories under `src/`:
- `agent/`: `DzupAgent` runtime, run engine, tool loop, run handles, middleware runtime, memory/instruction resolution, and tool execution helpers.
- `guardrails/`: budget, stuck detection, cascading timeouts, guardrail contracts.
- `workflow/`: fluent workflow builder and compiled workflow runner.
- `pipeline/`: pipeline runtime, validator, retry/backoff, loop executor, checkpoint stores (in-memory/Redis/Postgres), analytics, templates.
- `orchestration/`: orchestrator patterns, delegation/planning, contract-net, routing, topology, merge strategies, team runtime, provider execution port.
- `instructions/`: AGENTS.md parsing, loading, and merge logic.
- `tools/`: forge tool factory, tool schema registry, human contact tool.
- `structured/`: structured output engine and strategy detection.
- `streaming/`: stream action parser, text delta buffering, streaming run handle.
- `recovery/`, `reflection/`, `self-correction/`: failure analysis/recovery execution, run reflection, self-learning and correction utilities.
- `replay/`: trace capture, replay engine/controller/inspector, serializer.
- `snapshot/`: state snapshot integrity/compression and message serialization/migration.
- `approval/`: event-bus approval gate.
- `security/`: `AgentAuth` credentials/signing/verification.
- `templates/`, `presets/`: built-in template/preset registries and composition.
- `mailbox/`, `cluster/`, `playground/`: inter-agent mailbox primitives, in-memory cluster, and team/playground coordination helpers.
- `context/`: compatibility re-export layer over `@dzupagent/context`.
- `skill-chain-executor/`: textual workflow parser/executor and resolver contracts.

Current file footprint in `src/`:
- total files: 385
- TypeScript files: 362
- non-test/spec TypeScript files: 188
- test/spec TypeScript files: 174

## Runtime and Control Flow
1. Agent construction (`DzupAgent`) resolves the model from instance/tier/name, creates optional mailbox tooling, and initializes instruction, memory, and middleware runtimes.
2. `generate()` calls `prepareRunState()` to build prepared messages/tools/budget/stuck detector/memory frame, then calls `executeGenerateRun()` which forwards configured tool-execution policy options into `runToolLoop()`.
3. `stream()` delegates to `streamRun`; it uses native streaming only when supported and when no `wrapModelCall` middleware is active, otherwise it falls back to non-stream `executeGenerateRun()`.
4. `runToolLoop()` executes the ReAct loop until a terminal condition; stop reasons currently include `complete`, `iteration_limit`, `budget_exceeded`, `aborted`, `error`, `stuck`, `token_exhausted`, and `approval_pending`.
5. `WorkflowBuilder` compiles workflow nodes (`step`, `parallel`, `branch`, `suspend`) into canonical pipeline definitions; `PipelineRuntime` executes those definitions with retry, edge routing, checkpointing, suspension, and resume.
6. Orchestration flows layer on top of agent execution through `AgentOrchestrator`, delegation/planning modules, contract-net, topology, routing, merge strategies, team runtime, and optional provider-adapter execution ports.

## Key APIs and Types
Primary public API is the root export (`package.json` only exports `"."` -> `dist/index.js`).

Core runtime exports:
- `DzupAgent`, `createAgentWithMemory`, `runToolLoop`, `ConcreteRunHandle`, `executeToolsParallel`, `DynamicToolRegistry`.
- `DzupAgentConfig`, `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`, `ToolLoopConfig`, `ToolLoopResult`, `RunHandle`.

Guardrails and lifecycle exports:
- `IterationBudget`, `StuckDetector`, `CascadingTimeout`, `StuckError`, `createTokenLifecyclePlugin`.

Workflow and pipeline exports:
- `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`, `PipelineRuntime`, `validatePipeline`, `executeLoop`, `PipelineAnalytics`.
- Checkpoint stores and retry helpers (`InMemoryPipelineCheckpointStore`, retry policy utilities).

Orchestration exports:
- `AgentOrchestrator`, `DelegatingSupervisor`, `PlanningAgent`, `ContractNetManager`, `TopologyAnalyzer`, `TopologyExecutor`, routing/merge strategy classes, `TeamRuntime`.

Structured output and tools exports:
- `generateStructuredOutput`, `detectStrategy`, `createForgeTool`, `ToolSchemaRegistry`, `StreamActionParser`.

Additional supporting exports:
- `ApprovalGate`, `AgentAuth`, replay stack (`TraceCapture`, `ReplayEngine`, `ReplayController`, `ReplayInspector`), snapshot/message serialization helpers, template/preset registries, mailbox/cluster APIs, skill-chain executor APIs.

## Dependencies
Runtime dependencies (`package.json`):
- `@dzupagent/adapter-types`
- `@dzupagent/agent-types`
- `@dzupagent/context`
- `@dzupagent/core`
- `@dzupagent/memory`
- `@dzupagent/memory-ipc`

Peer dependencies:
- `@langchain/core >=1.0.0`
- `@langchain/langgraph >=1.0.0`
- `zod >=4.0.0`

Build/test toolchain:
- TypeScript (`strict: true`, NodeNext, target ES2022)
- `tsup` (ESM build from `src/index.ts`, target `node20`)
- Vitest (`node` env, v8 coverage, include `src/**/*.test.ts` and `src/**/*.spec.ts`)

## Integration Points
- LangChain integration through `BaseChatModel`, message types, and `StructuredToolInterface` tool contracts.
- Core runtime integration (`@dzupagent/core`) for model registry/fallback, event bus contracts, token usage/cost helpers, governance/safety interfaces, and run journal types.
- Context integration (`@dzupagent/context`) for summarization/trim, token lifecycle hooks, phase-aware windowing, and frozen snapshots.
- Memory integration via `@dzupagent/memory` (`get`, `formatForPrompt`, optional write-back) plus optional dynamic Arrow frame selection through `@dzupagent/memory-ipc`.
- AGENTS.md integration via instruction loader/parser/merger that scans directories and composes the final instruction text.
- Event-driven integration through emitted agent/tool/pipeline/approval/mailbox lifecycle events on configured event buses.
- Provider-adapter integration in orchestration through `ProviderExecutionPort` for supervisor execution mode.

## Testing and Observability
Testing status and shape:
- Vitest is the package runner (`vitest run`), with coverage through v8.
- Test coverage patterns include `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Test suite spans agent loop, streaming, orchestration, pipeline runtime, recovery/self-correction, mailbox, replay, and instruction handling.

Observability surfaces:
- Agent and tool-loop telemetry is emitted via configured event bus hooks, including stop reasons and stuck signals.
- Pipeline runtime emits typed lifecycle events for start/completion/failure, node lifecycle, retries, checkpointing, recovery attempts, stuck detection, and budget warnings.
- Streaming emits `AgentStreamEvent` updates (`text`, `tool_call`, `tool_result`, `budget_warning`, `done`, `error`).
- Replay subsystem captures event traces and exposes replay/inspection utilities.

## Risks and TODOs
- Version constant is aligned: `package.json` is `0.2.0` and exported constant `dzupagent_AGENT_VERSION` is `0.2.0`.
- Documentation/API drift exists: README quick-start still uses outdated config and call shapes (`systemPrompt`, `iterationBudget`, string-based `generate(...)`).
- Delegation aggregation risk remains: `DelegatingSupervisor` keys aggregated results by `specialistId`, and `PlanningAgent.executePlan()` reads by `specialistId`, which can collide when multiple plan nodes at the same level target one specialist.
- Root API surface is very large and mixed-stability, which increases maintenance and documentation drift risk.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
