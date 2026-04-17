# @dzupagent/agent Architecture

## Scope
This document describes the current implementation of `packages/agent` in `dzupagent`, based on:
- `packages/agent/src/**`
- `packages/agent/package.json`
- `packages/agent/README.md`
- existing module architecture docs under `packages/agent/src/*/ARCHITECTURE.md`

It covers the package-level runtime architecture and exported surface. It does not redefine internals of sibling packages such as `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory-ipc`, or external LangChain providers.

## Responsibilities
`@dzupagent/agent` is the execution/orchestration layer of the framework. In the current codebase it owns:
- Top-level agent runtime via `DzupAgent` (`generate`, `stream`, `launch`, `asTool`, `generateStructured`).
- ReAct-style tool-loop execution with iteration/cost/token guardrails.
- Instruction composition (`static` and `static+agents` via AGENTS.md loading/parsing/merging).
- Memory context injection, including optional token-budgeted Arrow memory selection.
- Workflow DSL and compilation into canonical pipeline definitions.
- Pipeline execution runtime with retries, checkpointing, fork/join, loops, suspend/approval gates, recovery hooks, and runtime events.
- Multi-agent orchestration patterns (supervisor, parallel/sequential, delegation, planning, contract-net, topology, routing, circuit breaker, merge strategies).
- Structured output utilities, streaming tool-call parser, tool schema/creation utilities.
- Replay and trace debugging stack (capture, session engine, controller, inspector, serializer).
- Supporting systems: templates, presets, mailbox/cluster/playground utilities, reflection and self-correction helpers, recovery copilot, snapshot serialization, and agent auth.

## Structure
Current top-level source layout under `src/`:
- `agent/`: core runtime (`DzupAgent`, run engine, tool loop, middleware runtime, instruction + memory resolution, run handles, tool arg validation, parallel tool executor).
- `guardrails/`: `IterationBudget`, `StuckDetector`, `CascadingTimeout`, guardrail types.
- `workflow/`: fluent workflow builder and `CompiledWorkflow` runtime wrapper.
- `pipeline/`: pipeline validator/runtime, checkpoint store, loop executor, retry policy, step type registry, templates, analytics.
- `orchestration/`: orchestration patterns, delegation/planning, contract-net, topology executor/analyzer, routing policies, merge strategies, provider adapter port, circuit breaker, telemetry helpers.
- `instructions/`: AGENTS.md parser/loader/merger.
- `tools/`: `createForgeTool`, tool schema registry, human contact tool.
- `structured/`: strategy-based structured output engine.
- `streaming/`: incremental tool-call parser and streaming run-handle helpers.
- `recovery/`: failure analysis, strategy ranking, recovery execution/copilot.
- `self-correction/`: reflection, error analysis, iteration control, learning/optimization utilities.
- `reflection/`: run reflection scoring, analyzer, in-memory store, learning bridge.
- `replay/`: trace capture/replay controller/inspector/serialization.
- `snapshot/`: snapshot integrity/compression and message serialization/migration.
- `approval/`: event-bus based approval gate.
- `security/`: Ed25519-based `AgentAuth` signing/verification and replay checks.
- `mailbox/`, `cluster/`, `playground/`: inter-agent messaging and team coordination utilities.
- `templates/`, `presets/`, `skill-chain-executor/`, `context/`: template/preset flows, textual skill-chain execution, and context compatibility re-exports.

Code volume snapshot from the current tree:
- `src/` files: 305
- non-test TypeScript files: 165
- test files: 117

## Runtime and Control Flow
1. `DzupAgent` construction
- Resolves model from instance, tier, or model name string.
- Optionally creates mailbox and auto-injects `send_mail`/`check_mail` tools.
- Instantiates instruction resolver, memory context loader, and middleware runtime.

2. `generate()` path
- `prepareRunState()` computes effective max iterations, budget, prepared messages, tool map, bound model, and optional stuck detector.
- `runToolLoop()` performs iterative model invocation and tool execution until final answer or stop reason.
- `executeGenerateRun()` applies output filtering, emits stop-reason telemetry, runs optional summary update, and emits optional post-run reflection callback.

3. `stream()` path
- If model supports streaming and no middleware `wrapModelCall` is active, streams chunks directly and executes tool calls inline via `executeStreamingToolCall()`.
- Otherwise, falls back to non-stream `executeGenerateRun()` and emits synthesized stream events.

4. Tool-loop internals
- Loop tracks usage and warnings through `IterationBudget`.
- Tool execution can be sequential or semaphore-limited parallel (`executeToolsParallel`).
- Optional tool-arg validation/repair runs before invocation.
- Stuck handling escalates from blocking repeated tools to nudging to loop abort (`StuckError`).

5. Workflow and pipeline runtime
- `WorkflowBuilder` compiles workflow nodes (`step`, `parallel`, `branch`, `suspend`) into a `PipelineDefinition` and delegates execution to `PipelineRuntime`.
- `PipelineRuntime` validates definitions and executes node graph transitions, including retry policies, error edges, loops, fork/join branches, checkpointing, and suspension.
- Optional runtime integrations: tracer spans, pipeline stuck detector, recovery copilot attempts, trajectory calibration, and iteration-budget warnings.

6. Orchestration and team coordination
- `AgentOrchestrator` provides sequential, parallel, and supervisor orchestration.
- Delegation stack (`DelegatingSupervisor`, `PlanningAgent`, `SimpleDelegationTracker`) supports decomposition and assignment execution.
- Additional strategies include contract-net bidding, topology execution, routing policies, and merge/circuit-breaker controls.
- `AgentPlayground` and `TeamCoordinator` provide higher-level team runs (`supervisor`, `peer-to-peer`, `blackboard`) on top of these primitives.

7. Replay, recovery, and learning loops
- `TraceCapture` records event-bus traffic into traces; replay stack provides interactive stepping/seeking and timeline analysis.
- Recovery stack analyzes failure context and can execute ranked recovery actions.
- Self-correction modules expose standalone analyzers/controllers/hooks used by runtime and pipeline integrations.

## Key APIs and Types
Primary package entrypoint is `src/index.ts` (single root export in `package.json`). Notable public APIs:
- Agent runtime:
  - `DzupAgent`, `runToolLoop`, `ConcreteRunHandle`, `executeToolsParallel`, `DynamicToolRegistry`.
  - Core types: `DzupAgentConfig`, `GenerateOptions`, `GenerateResult`, `AgentStreamEvent`, `ToolLoopConfig`, `ToolLoopResult`.
- Guardrails:
  - `IterationBudget`, `StuckDetector`, `CascadingTimeout`, `StuckError`.
  - Types: `GuardrailConfig`, `BudgetState`, `StuckDetectorConfig`.
- Workflows/Pipelines:
  - `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`, `PipelineRuntime`, `validatePipeline`, `executeLoop`, `PipelineAnalytics`.
  - Types: `WorkflowStep`, `WorkflowEvent`, `PipelineRuntimeConfig`, `PipelineRuntimeEvent`, `NodeResult`, `RetryPolicy`.
- Orchestration:
  - `AgentOrchestrator`, `DelegatingSupervisor`, `PlanningAgent`, `ContractNetManager`, `TopologyAnalyzer`, `TopologyExecutor`, routing/merge/circuit-breaker classes.
- Structured and tools:
  - `generateStructuredOutput`, `detectStrategy`, `createForgeTool`, `ToolSchemaRegistry`, `StreamActionParser`.
- Additional modules:
  - `ApprovalGate`, `AgentAuth`, snapshot/message serializers, replay stack classes, presets/templates, mailbox/cluster/playground APIs, skill-chain executor APIs.

## Dependencies
Runtime dependencies (`package.json`):
- `@dzupagent/adapter-types` `0.2.0`
- `@dzupagent/context` `0.2.0`
- `@dzupagent/core` `0.2.0`
- `@dzupagent/memory-ipc` `0.2.0`

Peer dependencies:
- `@langchain/core >=1.0.0`
- `@langchain/langgraph >=1.0.0`
- `zod >=4.0.0`

Dev/build/test dependencies and tooling:
- `typescript`, `tsup`, `vitest`.
- build target is Node 20 ESM (`tsup.config.ts`), compile target ES2022 (`tsconfig.json`).

Frequently used Node built-ins in this package:
- `node:crypto`, `node:fs/promises`, `node:path`, `node:zlib`.

## Integration Points
- Model and tool interfaces:
  - Integrates with LangChain `BaseChatModel`, `StructuredToolInterface`, message types.
  - Tool binding uses model `bindTools` when available.
- Framework core:
  - Uses `@dzupagent/core` registry, middleware contracts, event bus, message summarization, run journal/store types, and pipeline core types.
- Memory integration:
  - Uses memory service `get`/`formatForPrompt` path.
  - Optional dynamic import of `@dzupagent/memory-ipc` for Arrow-based selection.
- Instruction integration:
  - Scans project directories for AGENTS files and merges parsed sections into system prompt.
- Event-driven integrations:
  - Emits agent/tool/pipeline/supervisor/approval/mail events via `DzupEventBus`.
  - Approval flow waits on `approval:granted`/`approval:rejected`; optional webhook notification.
- Runtime persistence and resume:
  - Pipeline checkpoint store (`PipelineCheckpointStore`) and workflow run journal/store are supported.
- Provider adapter boundary:
  - Orchestration supports provider-port execution via `ProviderExecutionPort`.

## Testing and Observability
Testing:
- Test runner: Vitest (`vitest.config.ts`) with Node environment.
- Test file patterns: `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Coverage provider: `v8`, with source exclusions for test/spec files and barrel `index.ts` files.
- Current test footprint is broad, including deep coverage for agent loop, orchestration, pipeline runtime, streaming, recovery, self-correction, mailbox, and replay-related behavior.

Observability surfaces:
- Event bus emissions in core runtime:
  - examples include `agent:stop_reason`, `agent:stuck_detected`, `tool:latency`, approval and mailbox events.
- Pipeline runtime emits typed lifecycle/retry/recovery/stuck/checkpoint/budget events.
- Replay stack captures and inspects event streams (`TraceCapture`, `ReplayController`, `ReplayInspector`, `TraceSerializer`).
- Orchestration telemetry helper functions currently emit structured `console.debug` records.

## Risks and TODOs
- Version metadata drift:
  - `package.json` is `0.2.0`, while `src/index.ts` exports `dzupagent_AGENT_VERSION = '0.1.0'`.
- README/API drift:
  - README examples still show outdated signatures (`systemPrompt`, string-based `generate`, `asTool({...})`) that do not match current `DzupAgentConfig` and methods.
- Delegation result-keying collision risk:
  - `DelegatingSupervisor.delegateAndCollect()` keys aggregate results by `specialistId`, and `PlanningAgent.executePlan()` reads by `specialistId`, which can overwrite results when multiple nodes in one chunk target the same specialist.
- Structured-generation usage accounting gap:
  - `DzupAgent.generateStructured()` currently returns synthetic usage `{ totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 }` for `withStructuredOutput` path.
- Large surface-area complexity:
  - Package exposes a very broad root API and several large runtime files, increasing maintenance cost and documentation drift risk.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js