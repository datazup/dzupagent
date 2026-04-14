# @dzupagent/agent Architecture

This document describes the **current implementation** of `packages/agent` as of April 3, 2026, based on source code under `packages/agent/src`.

## 1. Package Purpose

`@dzupagent/agent` is the execution and orchestration layer for DzupAgent. It provides:

- The main `DzupAgent` runtime (`generate`, `stream`, `asTool`)
- Tool-loop execution with guardrails and stuck detection
- Workflow and pipeline runtimes
- Multi-agent orchestration patterns (supervisor, contract-net, topology, map-reduce)
- Recovery, replay/debugging, structured output, security, templates, presets, and playground utilities
- Self-correction and self-learning modules for iterative quality improvement

Primary external dependencies:

- `@dzupagent/core`
- `@dzupagent/context`
- `@dzupagent/memory-ipc` (optional at runtime via dynamic import)
- `@langchain/core`, `@langchain/langgraph`
- `zod`

## 2. High-Level Architecture

```text
User / Host App
  -> DzupAgent (agent runtime facade)
     -> Instruction resolution (static or AGENTS.md merged)
     -> Memory context loading (standard or Arrow budgeted)
     -> Middleware runtime (beforeAgent, wrapModelCall, wrapToolCall, injected tools)
     -> Tool loop / stream loop
        -> Model invocation
        -> Tool execution (sequential or parallel)
        -> Guardrails (budget + stuck detection + tool blocking)
     -> Optional summary update / context compression
     -> Telemetry events via eventBus

Advanced layers built on top:
  - WorkflowBuilder -> compiled PipelineDefinition -> PipelineRuntime
  - Orchestration (supervisor, contract-net, topology, map-reduce, delegation/planning)
  - RecoveryCopilot + PipelineRuntime recovery hooks
  - Replay stack (TraceCapture, ReplayEngine/Controller/Inspector, TraceSerializer)
  - Self-correction/self-learning stack
```

## 3. Core Runtime (`src/agent`)

### 3.1 `DzupAgent`

Key file: `src/agent/dzip-agent.ts`

Responsibilities:

- Model resolution from:
  - direct `BaseChatModel`
  - tier/name string through `registry`
- Preparation of effective prompt:
  - base instructions
  - optional AGENTS.md merge (`instructionsMode: 'static+agents'`)
  - memory context
  - rolling conversation summary
- Execution:
  - `generate(messages, options)`
  - `stream(messages, options)`
  - `generateStructured(messages, schema, options)`
- Tool wrapping for supervisor usage via `asTool()`

### 3.2 Generate Flow

`generate()` path:

1. `prepareRunState()` (`run-engine.ts`)
2. Build budget, tool map, stuck detector, prepared messages
3. Execute `runToolLoop()`
4. Extract final AI content
5. Apply optional output filter (`guardrails.outputFilter`)
6. Emit stop reason telemetry
7. Optionally update summary via `summarizeAndTrim`

### 3.3 Stream Flow

`stream()` path:

- Uses native model streaming when available and no middleware wraps model calls.
- Falls back to non-stream path (`executeGenerateRun`) otherwise.
- Emits `AgentStreamEvent` types:
  - `text`
  - `tool_call`
  - `tool_result`
  - `budget_warning`
  - `stuck`
  - `error`
  - `done`

### 3.4 Tool Loop

Key file: `src/agent/tool-loop.ts`

Features:

- ReAct-style iterative loop
- Stop reasons:
  - `complete`, `iteration_limit`, `budget_exceeded`, `aborted`, `error`, `stuck`
- Per-tool metrics (`calls`, `errors`, `totalMs`, `avgMs`)
- Optional parallel tool execution (`parallelTools`, `maxParallelTools`)
- Optional tool argument validation + auto-repair (`validateToolArgs`)
- Stuck escalation stages:
  - block repeated tool
  - inject nudge
  - abort after repeated stuck cycles

### 3.5 Guardrails

Key files: `src/guardrails/*`

- `IterationBudget`: token/cost/iteration tracking with threshold warnings
- `StuckDetector`: repeated tool calls, error bursts, idle loops
- `CascadingTimeout`: parent-child timeout hierarchy

## 4. Context and Instruction Loading

### 4.1 AGENTS.md Instruction System

Key files:

- `src/instructions/agents-md-parser.ts`
- `src/instructions/instruction-loader.ts`
- `src/instructions/instruction-merger.ts`
- `src/agent/instruction-resolution.ts`

Behavior:

- Parse hierarchical AGENTS sections from markdown headings
- Walk project tree and load AGENTS files (with skip lists and basic `.gitignore` handling)
- Merge static agent instructions with AGENTS-derived sections
- Cache merged result in `AgentInstructionResolver`

### 4.2 Memory Context Loading

Key file: `src/agent/memory-context-loader.ts`

Behavior:

- Standard mode: load all records from memory service and format for prompt
- Arrow mode (optional): dynamic import of `@dzupagent/memory-ipc` and token-budgeted selection
- Memory profile presets:
  - `minimal`
  - `balanced`
  - `memory-heavy`

If Arrow path fails, loader falls back to standard mode.

## 5. Workflow and Pipeline

### 5.1 Workflow Layer

Key files: `src/workflow/*`

- Fluent builder: `then`, `parallel`, `branch`, `suspend`
- Compiles workflow nodes into `PipelineDefinition`
- Executes through `PipelineRuntime`
- Supports event streaming (`workflow:completed`, `workflow:failed`, `suspended`, etc.)

### 5.2 Pipeline Runtime

Key files:

- `src/pipeline/pipeline-runtime.ts`
- `src/pipeline/pipeline-runtime-types.ts`
- `src/pipeline/pipeline-validator.ts`
- `src/pipeline/loop-executor.ts`
- `src/pipeline/retry-policy.ts`

Capabilities:

- Validates graph before execution
- Executes node graph with support for:
  - sequential edges
  - conditional edges
  - error edges
  - fork/join
  - loop nodes
  - suspend/approval-gate nodes
- Node retries with backoff and retryability filtering
- Checkpointing (in-memory store provided in package)
- Pipeline events for observability
- Optional integration with:
  - stuck detector
  - recovery copilot
  - trajectory calibrator
  - iteration budget warning signals
  - tracer spans

### 5.3 Pipeline Utilities

- Templates for common flows (`createCodeReviewPipeline`, `createFeatureGenerationPipeline`, etc.)
- Analytics aggregation and bottleneck detection (`PipelineAnalytics`)

## 6. Multi-Agent Orchestration

Key files: `src/orchestration/*`

Implemented patterns:

- Sequential chain
- Parallel fan-out + merge strategies
- Supervisor pattern (manager delegates to specialists exposed as tools)
- Debate
- Contract-net protocol
- Topology execution (`hierarchical`, `pipeline`, `star`, `mesh`, `ring`)
- Delegation protocol with tracker (`SimpleDelegationTracker`)
- Planning agent for DAG decomposition and level-by-level execution

Supporting components:

- `merge-strategies.ts` (`concat`, `vote`, `numbered`, `json-array`)
- `orchestration-error.ts` typed pattern-aware errors

## 7. Recovery and Self-Correction

### 7.1 Recovery

Key files: `src/recovery/*`

- `FailureAnalyzer`: classify and fingerprint failures
- `StrategyRanker`: confidence/risk/cost-based ranking
- `RecoveryExecutor`: run action plans with optional approval gate
- `RecoveryCopilot`: orchestrates analysis -> strategy -> execution

Pipeline runtime can call recovery copilot before hard-failing nodes.

### 7.2 Self-Correction / Self-Learning

Key files: `src/self-correction/*`

Modules include:

- `ReflectionLoop`
- `AdaptiveIterationController`
- `createSelfCorrectingExecutor`
- `RootCauseAnalyzer`
- `VerificationProtocol`
- `PipelineStuckDetector`
- `SelfLearningRuntime`
- `SelfLearningPipelineHook`
- `AdaptivePromptEnricher`
- `TrajectoryCalibrator`
- `ObservabilityCorrectionBridge`
- `StrategySelector`
- `RecoveryFeedback`
- `AgentPerformanceOptimizer`
- `FeedbackCollector`
- `LearningDashboardService`
- `LangGraphLearningMiddleware`

These modules are designed as best-effort and generally avoid crashing host execution paths when learning operations fail.

## 8. Replay, Security, Tools, Templates, Playground

### 8.1 Replay Debugger (`src/replay`)

- `TraceCapture` (event capture from event bus)
- `ReplayEngine` (session creation/lifecycle)
- `ReplayController` (play/pause/seek/breakpoint controls)
- `ReplayInspector` (timeline, diff, metrics)
- `TraceSerializer` (JSON/compact/binary with sanitization support)

### 8.2 Security (`src/security`)

- `AgentAuth` implements Ed25519 key generation, message signing, verification, nonce-based replay protection, and registered key lookup.

### 8.3 Structured Output (`src/structured`)

- Strategy detection from model name
- Strategy fallback chain:
  - detected strategy
  - `generic-parse`
  - `fallback-prompt`
- Zod schema validation and retry-on-invalid responses

### 8.4 Tooling Helpers (`src/tools`)

- `createForgeTool`: typed tool factory from Zod schemas
- `ToolSchemaRegistry`: versioned schema registration + compatibility checks

### 8.5 Templates and Presets (`src/templates`, `src/presets`)

- 22 built-in templates in `agent-templates.ts` plus mutable `TemplateRegistry`
- Preset objects for RAG/research/summarization/QA flows
- `buildConfigFromPreset` helper for constructing agent configs from preset + runtime deps

### 8.6 Playground (`src/playground`)

- Multi-agent sandbox with spawning, team coordination, event observation
- Coordination patterns:
  - supervisor
  - peer-to-peer
  - blackboard
- Shared in-memory workspace with serialized writes and subscriptions

## 9. Public API Surface

The package exposes most subsystems through `src/index.ts`, including:

- Agent runtime
- Guardrails
- Workflow
- Orchestration
- Pipeline
- Structured output
- Approval
- Snapshot/serialization
- Security
- Streaming parser
- Replay
- Recovery
- Self-correction/self-learning
- Playground
- Templates/presets

## 10. How To Use (Practical Recipes)

### 10.1 Basic Agent

```ts
import { DzupAgent } from '@dzupagent/agent'
import { HumanMessage } from '@langchain/core/messages'

const agent = new DzupAgent({
  id: 'reviewer',
  instructions: 'You are a strict code reviewer.',
  model: chatModel, // BaseChatModel instance
  tools: [lintTool, searchTool],
  guardrails: { maxIterations: 10, maxTokens: 100_000, maxCostCents: 50 },
})

const result = await agent.generate([new HumanMessage('Review this patch')])
console.log(result.content, result.stopReason)
```

### 10.2 Streaming

```ts
for await (const ev of agent.stream([new HumanMessage('Do the task')])) {
  if (ev.type === 'text') process.stdout.write(String(ev.data.content ?? ''))
}
```

### 10.3 Structured Output

```ts
import { generateStructured } from '@dzupagent/agent'
import { z } from 'zod'

const schema = z.object({ summary: z.string(), risk: z.number().min(0).max(1) })
const out = await generateStructured(llm, [{ role: 'user', content: 'Analyze X' }], { schema })
```

### 10.4 Supervisor Orchestration

```ts
import { AgentOrchestrator } from '@dzupagent/agent'

const res = await AgentOrchestrator.supervisor({
  manager: managerAgent,
  specialists: [dbAgent, apiAgent, uiAgent],
  task: 'Design and implement the feature',
})
```

### 10.5 Pipeline Runtime

```ts
import { PipelineRuntime, InMemoryPipelineCheckpointStore } from '@dzupagent/agent'

const runtime = new PipelineRuntime({
  definition: pipelineDef,
  nodeExecutor: executeNode,
  checkpointStore: new InMemoryPipelineCheckpointStore(),
  onEvent: (e) => console.log(e.type),
})

const run = await runtime.execute({ featureSpec: '...' })
```

### 10.6 AGENTS.md-Aware Instructions

```ts
const agent = new DzupAgent({
  id: 'repo-agent',
  instructions: 'Base instructions',
  instructionsMode: 'static+agents',
  agentsDir: process.cwd(),
  model: chatModel,
})
```

## 11. Notable Current-State Caveats

These are implementation observations useful for maintainers:

- `DzupAgentConfig.selfLearning` exists and hook creation occurs in `prepareRunState`, but `GenerateResult.learnings` is currently not populated by the generate path.
- `createDefaultPresetRegistry()` currently returns an empty registry (built-in presets are exported, but not auto-registered there).
- `generateStructured` in `DzupAgent` uses model-native `withStructuredOutput` when available, but token usage accounting in that path is minimal (`llmCalls: 1`, token counts zeroed).

## 12. Where To Extend

Common extension points:

- Middleware (`beforeAgent`, `wrapModelCall`, `wrapToolCall`, middleware tools)
- Custom tools via `createForgeTool` or native LangChain tools
- Guardrail policies (`outputFilter`, stuck settings, budget settings)
- Merge strategies for parallel orchestration
- Pipeline node executors, predicates, retry policies, checkpoint stores
- Recovery strategy generators/executors
- Self-learning hooks and dashboard integrations

## 13. Feature-to-Test Coverage Matrix

`packages/agent/src/__tests__` currently contains **74** test files.  
Use this matrix to connect implementation areas to the test suites that validate them.

### 13.1 Core Agent Runtime

- Feature: `DzupAgent` generate/stream behavior, parity, token usage, memory integration, middleware
- Source:
  - `src/agent/dzip-agent.ts`
  - `src/agent/run-engine.ts`
  - `src/agent/middleware-runtime.ts`
  - `src/agent/memory-context-loader.ts`
  - `src/agent/message-utils.ts`
- Related tests:
  - `src/__tests__/dzip-agent-run-parity.test.ts`
  - `src/__tests__/token-usage.test.ts`
  - `src/__tests__/dzip-agent-memory-context.integration.test.ts`
  - `src/__tests__/middleware-hooks.test.ts`
  - `src/__tests__/middleware-runtime.test.ts`
  - `src/__tests__/memory-context-loader.test.ts`
  - `src/__tests__/message-utils.test.ts`
  - `src/__tests__/memory-profiles.test.ts`

### 13.2 Tool Loop, Parallelism, Validation, Telemetry

- Feature: ReAct loop, parallel tool execution, arg validation/repair, tool stats and telemetry, stuck escalation
- Source:
  - `src/agent/tool-loop.ts`
  - `src/agent/parallel-executor.ts`
  - `src/agent/tool-arg-validator.ts`
  - `src/agent/stuck-error.ts`
- Related tests:
  - `src/__tests__/parallel-tool-loop.test.ts`
  - `src/__tests__/parallel-tools.test.ts`
  - `src/__tests__/tool-arg-validator.test.ts`
  - `src/__tests__/tool-loop-telemetry.test.ts`
  - `src/__tests__/tool-stats-wiring.test.ts`
  - `src/__tests__/stuck-recovery.test.ts`
  - `src/__tests__/stuck-detector.test.ts`

### 13.3 Guardrails and Timeouts

- Feature: budget limits, stuck detection, cascading timeouts
- Source:
  - `src/guardrails/iteration-budget.ts`
  - `src/guardrails/stuck-detector.ts`
  - `src/guardrails/cascading-timeout.ts`
- Related tests:
  - `src/__tests__/stuck-detector.test.ts`
  - `src/__tests__/stuck-recovery.test.ts`
  - `src/__tests__/cascading-timeout.test.ts`

### 13.4 Instructions / AGENTS.md

- Feature: parse, load, merge, and resolve AGENTS.md into effective instructions
- Source:
  - `src/instructions/agents-md-parser.ts`
  - `src/instructions/instruction-loader.ts`
  - `src/instructions/instruction-merger.ts`
  - `src/agent/instruction-resolution.ts`
- Related tests:
  - `src/__tests__/agents-md-parser.test.ts`
  - `src/__tests__/instruction-loader.test.ts`
  - `src/__tests__/instruction-merger.test.ts`
  - `src/__tests__/instruction-resolution.test.ts`

### 13.5 Workflow Builder and Runtime Composition

- Feature: workflow DSL compilation and runtime semantics
- Source:
  - `src/workflow/workflow-builder.ts`
  - `src/workflow/workflow-types.ts`
- Related tests:
  - `src/__tests__/workflow-builder.test.ts`

### 13.6 Pipeline Runtime and Validation

- Feature: pipeline execution engine (edges, fork/join, loops, suspend/resume, checkpointing), validator, templates, analytics, retry/backoff, tracer hooks
- Source:
  - `src/pipeline/pipeline-runtime.ts`
  - `src/pipeline/pipeline-validator.ts`
  - `src/pipeline/loop-executor.ts`
  - `src/pipeline/retry-policy.ts`
  - `src/pipeline/pipeline-templates.ts`
  - `src/pipeline/pipeline-analytics.ts`
  - `src/pipeline/in-memory-checkpoint-store.ts`
- Related tests:
  - `src/__tests__/pipeline-runtime.test.ts`
  - `src/__tests__/pipeline-runtime-helpers.test.ts`
  - `src/__tests__/pipeline-validator.test.ts`
  - `src/__tests__/pipeline-templates.test.ts`
  - `src/__tests__/pipeline-analytics.test.ts`
  - `src/__tests__/pipeline-retry.test.ts`
  - `src/__tests__/pipeline-otel.test.ts`
  - `src/__tests__/checkpoint-store.test.ts`

### 13.7 Orchestration Patterns

- Feature: sequential/parallel/supervisor/debate orchestration, map-reduce, contract-net, delegation, planning, topology
- Source:
  - `src/orchestration/orchestrator.ts`
  - `src/orchestration/map-reduce.ts`
  - `src/orchestration/contract-net/*`
  - `src/orchestration/delegation.ts`
  - `src/orchestration/delegating-supervisor.ts`
  - `src/orchestration/planning-agent.ts`
  - `src/orchestration/topology/*`
- Related tests:
  - `src/__tests__/orchestrator-patterns.test.ts`
  - `src/__tests__/supervisor.test.ts`
  - `src/__tests__/map-reduce.test.ts`
  - `src/__tests__/contract-net.test.ts`
  - `src/__tests__/delegation.test.ts`
  - `src/__tests__/delegating-supervisor.test.ts`
  - `src/__tests__/planning-agent.test.ts`
  - `src/__tests__/plan-decomposition.test.ts`
  - `src/__tests__/topology.test.ts`

### 13.8 Structured Output and Stream Parsing

- Feature: structured extraction strategy/fallback + streaming tool-call parser
- Source:
  - `src/structured/structured-output-engine.ts`
  - `src/streaming/stream-action-parser.ts`
- Related tests:
  - `src/__tests__/structured-output.test.ts`
  - `src/__tests__/stream-action-parser.test.ts`

### 13.9 Recovery Stack

- Feature: failure classification, strategy ranking, recovery plan execution, copilot orchestration
- Source:
  - `src/recovery/failure-analyzer.ts`
  - `src/recovery/strategy-ranker.ts`
  - `src/recovery/recovery-executor.ts`
  - `src/recovery/recovery-copilot.ts`
- Related tests:
  - `src/__tests__/failure-analyzer.test.ts`
  - `src/__tests__/strategy-ranker.test.ts`
  - `src/__tests__/recovery-executor.test.ts`
  - `src/__tests__/recovery-copilot.test.ts`

### 13.10 Reflection, Replay, Snapshot, Serialization, Security

- Feature: run reflection scoring, replay debugger stack, snapshot/serialized-message formats, agent auth
- Source:
  - `src/reflection/run-reflector.ts`
  - `src/replay/*`
  - `src/snapshot/agent-snapshot.ts`
  - `src/snapshot/serialized-message.ts`
  - `src/security/agent-auth.ts`
- Related tests:
  - `src/__tests__/run-reflector.test.ts`
  - `src/__tests__/run-reflector-llm.test.ts`
  - `src/__tests__/replay-debugger.test.ts`
  - `src/__tests__/agent-snapshot.test.ts`
  - `src/__tests__/serialized-message.test.ts`
  - `src/__tests__/agent-auth.test.ts`

### 13.11 Self-Correction / Self-Learning

- Feature: adaptive prompting, error orchestration, post-run analysis, trajectory calibration, strategy selection, middleware bridge, learning runtime/hook/dashboard, verification protocol, root-cause and refinement loops
- Source:
  - `src/self-correction/*`
- Related tests:
  - `src/__tests__/adaptive-prompt-enricher.test.ts`
  - `src/__tests__/error-detector.test.ts`
  - `src/__tests__/feedback-collector.test.ts`
  - `src/__tests__/iteration-controller.test.ts`
  - `src/__tests__/langgraph-middleware.test.ts`
  - `src/__tests__/learning-dashboard.test.ts`
  - `src/__tests__/observability-bridge.test.ts`
  - `src/__tests__/performance-optimizer.test.ts`
  - `src/__tests__/pipeline-stuck-detector.test.ts`
  - `src/__tests__/post-run-analyzer.test.ts`
  - `src/__tests__/reflection-loop.test.ts`
  - `src/__tests__/root-cause-analyzer.test.ts`
  - `src/__tests__/self-correcting-node.test.ts`
  - `src/__tests__/self-learning-hook.test.ts`
  - `src/__tests__/self-learning-runtime.test.ts`
  - `src/__tests__/self-learning-integration.test.ts`
  - `src/__tests__/specialist-registry.test.ts`
  - `src/__tests__/strategy-selector.test.ts`
  - `src/__tests__/trajectory-calibrator.test.ts`
  - `src/__tests__/verification-protocol.test.ts`

### 13.12 Templates, Tool Schema Registry, Playground UI Utils

- Feature: template inventory/composition/registry, tool schema compatibility/docs, playground UI helper logic
- Source:
  - `src/templates/*`
  - `src/tools/tool-schema-registry.ts`
  - `src/playground/ui/utils.ts`
- Related tests:
  - `src/__tests__/agent-templates.test.ts`
  - `src/__tests__/tool-schema-registry.test.ts`
  - `src/__tests__/playground-ui-utils.test.ts`

## 14. Recommended Test Commands For Feature Updates

Run targeted suites first, then full package tests.

### 14.1 Targeted examples

```bash
# Core runtime and tool-loop behavior
yarn workspace @dzupagent/agent test dzip-agent-run-parity.test.ts parallel-tool-loop.test.ts tool-loop-telemetry.test.ts

# Pipeline engine changes
yarn workspace @dzupagent/agent test pipeline-runtime.test.ts pipeline-retry.test.ts pipeline-validator.test.ts pipeline-templates.test.ts

# Orchestration changes
yarn workspace @dzupagent/agent test orchestrator-patterns.test.ts supervisor.test.ts contract-net.test.ts delegating-supervisor.test.ts planning-agent.test.ts topology.test.ts

# Self-learning / self-correction changes
yarn workspace @dzupagent/agent test self-learning-runtime.test.ts self-learning-integration.test.ts langgraph-middleware.test.ts post-run-analyzer.test.ts
```

### 14.2 Full package verification

```bash
yarn workspace @dzupagent/agent test
yarn workspace @dzupagent/agent typecheck
yarn workspace @dzupagent/agent lint
```

---

For implementation details, start from:

- `src/index.ts` (public exports)
- `src/agent/dzip-agent.ts` (runtime entry)
- `src/pipeline/pipeline-runtime.ts` (graph execution core)
- `src/orchestration/orchestrator.ts` (multi-agent patterns)
