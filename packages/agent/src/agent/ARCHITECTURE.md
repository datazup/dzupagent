# `src/agent` Architecture

This document covers the implementation in `packages/agent/src/agent`.

## 1. Scope and Responsibility

`src/agent` is the core runtime layer for `@dzupagent/agent`.

It owns:
- the `DzupAgent` public runtime (`generate`, `stream`, `generateStructured`, `asTool`)
- instruction resolution (`static` vs `static+agents`)
- memory-context loading (standard and Arrow budgeted)
- middleware orchestration around model and tool execution
- the ReAct tool loop, including guardrails and stuck handling
- tool-call parallel execution and argument validation
- legacy message serialization adapters

It does **not** own pipeline runtime, orchestration strategies, templates, or security modules; those are in sibling folders and consume this runtime.

## 2. File-Level Map

| File | Primary Role |
|---|---|
| `dzip-agent.ts` | Main runtime class and public API entrypoint |
| `agent-types.ts` | Public config/result/event contracts |
| `run-engine.ts` | Shared run preparation/execution helpers for generate + stream paths |
| `tool-loop.ts` | ReAct loop implementation with stop reasons, stats, stuck escalation |
| `parallel-executor.ts` | Semaphore-based parallel tool executor |
| `tool-arg-validator.ts` | Schema-based tool arg validation + repair |
| `memory-context-loader.ts` | Memory context fetch and Arrow token-budget selection |
| `memory-profiles.ts` | Presets for Arrow memory budget tuning |
| `instruction-resolution.ts` | AGENTS.md-aware instruction loader/merger with caching |
| `middleware-runtime.ts` | Middleware hooks for model invocation and tool result transforms |
| `message-utils.ts` | System-message assembly and token-estimation helpers |
| `stuck-error.ts` | Structured stuck error with escalation metadata |
| `tool-loop-learning.ts` | Self-learning hook bridge (SkillLearner + specialist config) |
| `tool-registry.ts` | Dynamic mutable registry for tools |
| `agent-state.ts` | Legacy message serialize/deserialize checkpoint format |

## 3. Main Runtime Flow

### 3.1 `DzupAgent` construction

`DzupAgent` (`dzip-agent.ts:57`) composes runtime subsystems in constructor:
- resolves model from instance/tier/name (`dzip-agent.ts:443`)
- configures instruction resolver (`instruction-resolution.ts:19`)
- configures memory context loader (`memory-context-loader.ts:55`)
- configures middleware runtime (`middleware-runtime.ts:11`)

### 3.2 `generate()` path

`generate()` (`dzip-agent.ts:109`) flow:
1. `prepareRunState()` (`run-engine.ts:71`) computes:
   - `maxIterations`
   - guardrail budget (`IterationBudget`)
   - prepared messages (instructions + memory + summary + user messages)
   - resolved tools and tool map
   - optional `StuckDetector`
2. `executeGenerateRun()` (`run-engine.ts:113`) executes `runToolLoop()` (`tool-loop.ts:133`)
3. stop reason telemetry is emitted (`run-engine.ts:193`)
4. optional output filtering is applied (`guardrails.outputFilter`)
5. summary compression may update conversation summary (`dzip-agent.ts:520`)
6. `GenerateResult` is returned

### 3.3 `stream()` path

`stream()` (`dzip-agent.ts:181`) has two modes:
- streaming-native mode: uses model `.stream()` and emits `AgentStreamEvent`s for `text`, `tool_call`, `tool_result`, `budget_warning`, `stuck`, `done`
- fallback mode: if model stream is unavailable or middleware wraps model calls, it reuses `executeGenerateRun()` and emits synthetic stream events from final result

Streaming tool execution reuses shared helper `executeStreamingToolCall()` (`run-engine.ts:236`) to keep behavior consistent with generate mode.

## 4. Feature Breakdown

### 4.1 Instruction resolution

`AgentInstructionResolver` (`instruction-resolution.ts:19`):
- supports `static` and `static+agents` modes
- caches merged result
- deduplicates concurrent loads through `mergedInstructionsLoading`
- falls back to static instructions on load/merge errors

### 4.2 Memory context loading

`AgentMemoryContextLoader` (`memory-context-loader.ts:55`):
- standard path: `memory.get(namespace, scope)` then `memory.formatForPrompt`
- Arrow path: dynamic import of `@dzupagent/memory-ipc`, computes memory token budget, selects rows by budget/phase, formats `## Memory Context` block
- Arrow failures gracefully fall back to standard path

Memory budget presets are in `memory-profiles.ts`:
- `minimal`
- `balanced`
- `memory-heavy`

### 4.3 Middleware behavior

`AgentMiddlewareRuntime` (`middleware-runtime.ts:11`):
- `resolveTools`: appends middleware-provided tools after base tools
- `runBeforeAgentHooks`: executes all `beforeAgent`; failures are non-fatal
- `invokeModel`: uses the **first** middleware with `wrapModelCall`; otherwise `model.invoke`
- `transformToolResult`: applies all `wrapToolCall` handlers in order; failures are non-fatal

### 4.4 Tool loop behavior

`runToolLoop` (`tool-loop.ts:133`) implements ReAct loop:
- per-iteration abort and budget checks
- optional tool performance hint injection via `toolStatsTracker`
- model call + token accounting
- sequential or parallel tool execution
- tool-level latency stats + aggregated `toolStats`
- stop reasons: `complete`, `iteration_limit`, `budget_exceeded`, `aborted`, `error`, `stuck`

Stuck recovery is staged:
1. block repeated tool via budget (`tool_blocked`)
2. inject nudge system message
3. abort loop with `StuckError`

### 4.5 Parallel tool execution

`executeToolsParallel` (`parallel-executor.ts:62`):
- counting-semaphore design (`acquire`/`release`)
- bounded concurrency (`maxConcurrency`)
- abort support
- non-fatal partial failures via `Promise.allSettled`
- preserves original call order in returned results

### 4.6 Tool argument validation

`validateAndRepairToolArgs` (`tool-arg-validator.ts:57`) supports:
- required-field checks
- default filling
- type coercion (`string -> number|boolean`, scalar -> array)
- unknown-field dropping (when auto-repair enabled)
- schema hint formatting for LLM repair prompts (`formatSchemaHint`)

### 4.7 Public runtime contracts

`agent-types.ts` defines:
- `DzupAgentConfig`
- `GenerateOptions`
- `GenerateResult`
- `AgentStreamEvent`
- optional memory and self-learning config contracts

### 4.8 Legacy adapters

- `agent-state.ts`: legacy `BaseMessage[] <-> SerializedMessage[]`
- `tool-registry.ts`: mutable runtime tool registry abstraction

## 5. Internal Consumers in `packages/agent`

These modules depend directly on `src/agent` runtime:
- `src/orchestration/orchestrator.ts`
  - imports `DzupAgent` (`orchestrator.ts:11`)
  - sequential/parallel orchestration calls `agent.generate()` (`orchestrator.ts:53`, `orchestrator.ts:68`)
  - supervisor pattern builds specialist tools with `agent.asTool()` (`orchestrator.ts:134`, `orchestrator.ts:154`)
  - creates derived manager `DzupAgent` with injected specialist tools (`orchestrator.ts:162`)
- `src/orchestration/map-reduce.ts`
  - imports `DzupAgent` type (`map-reduce.ts:10`)
  - executes chunked work via `agent.generate()` (`map-reduce.ts:89`)
- `src/playground/playground.ts`
  - imports `DzupAgent` (`playground.ts:38`)
  - spawns/manages agent instances (`playground.ts:102`)

## 6. External Package References

Observed cross-package usage in code:

- `packages/server/src/runtime/dzip-agent-run-executor.ts`
  - imports `DzupAgent` (`dzip-agent-run-executor.ts:1`)
  - constructs agent per run (`dzip-agent-run-executor.ts:79`)
  - consumes `agent.stream(...)` for live run output (`dzip-agent-run-executor.ts:122`)
- `packages/express/src/agent-router.ts`
  - depends on `DzupAgent` type (`agent-router.ts:3`)
  - uses `agent.stream(...)` for SSE (`agent-router.ts:80`)
  - uses `agent.generate(...)` for sync endpoint (`agent-router.ts:128`)
- `packages/express/src/sse-handler.ts`
  - consumes `AgentStreamEvent` contract (`sse-handler.ts:2`)
- `packages/express/src/types.ts`
  - uses `DzupAgent`, `GenerateResult` types (`types.ts:2`)

Other packages import other `@dzupagent/agent` exports (mostly outside `src/agent`):
- `agent-adapters`, `codegen` import `PipelineRuntime`
- `connectors-browser`, `connectors-documents` import `createForgeTool`

## 7. Usage Examples

### 7.1 Basic generate

```ts
import { DzupAgent } from '@dzupagent/agent'
import { HumanMessage } from '@langchain/core/messages'

const agent = new DzupAgent({
  id: 'reviewer',
  instructions: 'Review code and return concise findings.',
  model: modelInstance, // BaseChatModel
})

const result = await agent.generate([new HumanMessage('Review this diff')])
console.log(result.content)
console.log(result.stopReason, result.toolStats)
```

### 7.2 Streaming with cancellation

```ts
const controller = new AbortController()

for await (const event of agent.stream([new HumanMessage('Run task')], {
  signal: controller.signal,
})) {
  if (event.type === 'text') {
    process.stdout.write(String(event.data.content ?? ''))
  }
}
```

### 7.3 Memory profile + Arrow selection

```ts
const agent = new DzupAgent({
  id: 'memory-worker',
  instructions: 'Use prior context when relevant.',
  model: modelInstance,
  memory,
  memoryNamespace: 'project-memory',
  memoryScope: { projectId: 'p-1' },
  memoryProfile: 'balanced',
  arrowMemory: { currentPhase: 'coding' },
})
```

### 7.4 Standalone tool-loop usage

```ts
import { runToolLoop } from '@dzupagent/agent'

const loop = await runToolLoop(model, messages, tools, {
  maxIterations: 8,
  parallelTools: true,
  maxParallelTools: 4,
  validateToolArgs: true,
})

console.log(loop.stopReason, loop.toolStats)
```

## 8. Test Coverage (Current State)

### 8.1 Executed verification

Executed on `2026-04-04`:

```bash
yarn workspace @dzupagent/agent test -- \
  src/__tests__/instruction-resolution.test.ts \
  src/__tests__/memory-context-loader.test.ts \
  src/__tests__/memory-profiles.test.ts \
  src/__tests__/message-utils.test.ts \
  src/__tests__/middleware-runtime.test.ts \
  src/__tests__/tool-arg-validator.test.ts \
  src/__tests__/parallel-tools.test.ts \
  src/__tests__/parallel-tool-loop.test.ts \
  src/__tests__/tool-loop-telemetry.test.ts \
  src/__tests__/tool-stats-wiring.test.ts \
  src/__tests__/stuck-recovery.test.ts \
  src/__tests__/dzip-agent-run-parity.test.ts \
  src/__tests__/dzip-agent-memory-context.integration.test.ts \
  src/__tests__/middleware-hooks.test.ts \
  src/__tests__/token-usage.test.ts \
  src/__tests__/map-reduce.test.ts \
  src/__tests__/orchestrator-patterns.test.ts \
  src/__tests__/contract-net.test.ts \
  src/__tests__/supervisor.test.ts \
  src/__tests__/topology.test.ts
```

Result:
- `20` test files passed
- `235` tests passed
- `0` failed

### 8.2 Direct module coverage by test file

- `instruction-resolution.ts`: `instruction-resolution.test.ts`
- `memory-context-loader.ts`: `memory-context-loader.test.ts`, `dzip-agent-memory-context.integration.test.ts`
- `memory-profiles.ts`: `memory-profiles.test.ts`
- `message-utils.ts`: `message-utils.test.ts`
- `middleware-runtime.ts`: `middleware-runtime.test.ts`, `middleware-hooks.test.ts`
- `tool-arg-validator.ts`: `tool-arg-validator.test.ts`, `parallel-tool-loop.test.ts`
- `parallel-executor.ts`: `parallel-tools.test.ts`, `parallel-tool-loop.test.ts`
- `tool-loop.ts`: `parallel-tool-loop.test.ts`, `tool-loop-telemetry.test.ts`, `tool-stats-wiring.test.ts`, `stuck-recovery.test.ts`
- `stuck-error.ts`: `stuck-recovery.test.ts`
- `dzip-agent.ts` + `agent-types.ts`: `dzip-agent-run-parity.test.ts`, `token-usage.test.ts`, orchestration tests (`map-reduce`, `orchestrator-patterns`, `contract-net`, `supervisor`, `topology`)

### 8.3 Notably untested or lightly tested areas

- `agent-state.ts`: no direct tests found in `src/__tests__`
- `tool-registry.ts`: no direct tests found
- `run-engine.ts`: behavior is covered indirectly through `DzupAgent` and `tool-loop` tests, but no dedicated unit tests for helpers
- `tool-loop-learning.ts`: no direct tests found; current runtime wiring appears partial (loaded during prepare, but run-level learning outputs are not surfaced in `GenerateResult` path)

## 9. Practical Extension Points

Common extension points in this module:
- custom model invocation policy: middleware `wrapModelCall`
- tool post-processing / redaction: middleware `wrapToolCall`
- advanced tool safety: `validateToolArgs`, stuck-detector tuning, budget policy
- memory-budget tuning: `memoryProfile` + `arrowMemory` overrides
- orchestration composition: `asTool()` for supervisor/specialist patterns

## 10. Summary

`src/agent` is a layered runtime: `DzupAgent` composes instruction, memory, middleware, and loop subsystems; `run-engine` standardizes execution between generate/stream paths; `tool-loop` is the behavioral core for tool-using reasoning under budgets and stuck recovery; and the module is well-covered by targeted tests, with a few utility/helper areas currently lacking direct test files.
