# Workflow Module Architecture (`packages/agent/src/workflow`)

## Scope
This document covers the workflow subsystem in `@dzupagent/agent` located at `packages/agent/src/workflow`.

Included source files:
- `workflow-builder.ts`
- `workflow-types.ts`
- `index.ts`

Related surfaces inspected for this refresh:
- `packages/agent/src/index.ts` (package-level exports)
- `packages/agent/README.md` (public package docs)
- `packages/agent/src/__tests__/workflow-builder.test.ts`
- `packages/agent/src/__tests__/workflow-builder-deep.test.ts`
- `packages/agent/src/__tests__/workflow-builder-full.test.ts`
- `packages/agent/src/skill-chain-executor/skill-chain-executor.ts` (consumer integration)

## Responsibilities
The workflow module provides a fluent, code-first DSL that compiles into canonical pipeline definitions and executes them through `PipelineRuntime`.

Primary responsibilities:
- Build workflows from four node kinds: sequential `step`, `parallel`, `branch`, and `suspend`.
- Compile workflow nodes into a `PipelineDefinition` with transform/suspend nodes and sequential/conditional edges.
- Execute compiled workflows with event callbacks and optional `AbortSignal`.
- Bridge runtime lifecycle events to workflow-level events.
- Support journaling (`RunJournal`), run lookup (`RunStore`/`RunHandle`), and checkpoint-based resume (`PipelineCheckpointStore`).

## Structure
### `workflow-types.ts`
Defines the public workflow contracts:
- `WorkflowStep<TInput, TOutput>`
- `WorkflowContext`
- `WorkflowNode`
- `MergeStrategy` (`merge-objects` | `concat-arrays` | `last-wins`)
- `WorkflowEvent`

### `workflow-builder.ts`
Contains:
- `WorkflowConfig`
- `WorkflowBuilder` fluent API (`then`, `parallel`, `branch`, `suspend`, `build`)
- `CompiledWorkflow` runtime-facing API (`run`, `stream`, `resume`, `toPipelineDefinition`, `withJournal`, `withStore`, `withCheckpointStore`, `getHandle`)
- Internal compiler (`compileWorkflow`) and runtime event handling helpers.

### `index.ts`
Re-exports builder and types for module consumers.

## Runtime and Control Flow
1. A caller creates `WorkflowBuilder` via `createWorkflow(config)`.
2. Builder methods append internal `WorkflowNode` entries.
3. `build()` creates a `CompiledWorkflow`, which immediately compiles nodes into:
- pipeline nodes and edges
- predicate map for conditional edges
- suspend-reason map (`nodeId -> reason`)
- transform handler registry used by a `NodeExecutor`
4. `run(initialState, options)` creates `PipelineRuntime` with compiled definition and executes from `entryNodeId`.
5. Runtime events are translated by `handleRuntimeEvent`:
- `pipeline:completed` -> `workflow:completed`
- `pipeline:failed` -> `workflow:failed`
- `pipeline:suspended` -> `suspended`
6. `stream(initialState, options)` runs `run()` in the background and yields buffered `WorkflowEvent`s until terminal event (`workflow:completed`, `workflow:failed`, `suspended`).
7. `resume(checkpointOrRunId, additionalState, options)` loads or accepts a `PipelineCheckpoint`, then delegates to `PipelineRuntime.resume(...)` using the same compiled definition.

State semantics:
- Step outputs are shallow-merged into shared state (`Object.assign`) when output is an object.
- Parallel executes with `Promise.all` and merges by configured strategy.
- `run`/`resume` return a shallow copy of the last observed state snapshot.

## Key APIs and Types
Builder and factory:
- `createWorkflow(config: WorkflowConfig): WorkflowBuilder`
- `new WorkflowBuilder(config)`
- `WorkflowBuilder.then(step)`
- `WorkflowBuilder.parallel(steps, mergeStrategy?)`
- `WorkflowBuilder.branch(condition, branches)`
- `WorkflowBuilder.suspend(reason)`
- `WorkflowBuilder.build(): CompiledWorkflow`

Compiled workflow:
- `CompiledWorkflow.run(initialState, { signal?, runId?, onEvent? })`
- `CompiledWorkflow.stream(initialState, { signal? })`
- `CompiledWorkflow.resume(checkpointOrRunId, additionalState?, { signal?, onEvent? })`
- `CompiledWorkflow.toPipelineDefinition()`
- `CompiledWorkflow.withJournal(journal)`
- `CompiledWorkflow.withStore(store)`
- `CompiledWorkflow.withCheckpointStore(checkpointStore)`
- `CompiledWorkflow.getHandle(runId)`

Notable event types in `WorkflowEvent`:
- Emitted by workflow runtime: `step:started`, `step:completed`, `step:failed`, `parallel:started`, `parallel:completed`, `branch:evaluated`, `suspended`, `workflow:completed`, `workflow:failed`
- Also present in the shared type union: `step:skipped`, `step:retrying` (used by `skill-chain-executor` callbacks)

## Dependencies
Direct dependencies from this module:
- `@dzupagent/core` types:
  - `PipelineDefinition`, `PipelineNode`
  - `PipelineCheckpoint`, `PipelineCheckpointStore`
  - `RunJournal`, `RunStore`
- Internal runtime dependency:
  - `PipelineRuntime` from `../pipeline/pipeline-runtime.js`
  - runtime types from `../pipeline/pipeline-runtime-types.js`
- Internal run-handle integration:
  - `ConcreteRunHandle`, `RunNotFoundError`, `RunHandle`-related types
- Node builtin:
  - `node:crypto` (`randomUUID`)

Package-level context (`packages/agent/package.json`):
- Package: `@dzupagent/agent` (ESM, built via `tsup`)
- Internal package deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/adapter-types`, `@dzupagent/agent-types`

## Integration Points
- Package root exports (`packages/agent/src/index.ts`) re-export workflow APIs/types, making this module part of `@dzupagent/agent` public surface.
- `SkillChainExecutor` compiles skill chains into `CompiledWorkflow` using `createWorkflow(...)`, then forwards workflow events to its progress callback and optional `DzupEventBus` bridge.
- `PipelineRuntime` is the execution engine; workflow compilation acts as an adapter layer from fluent DSL to canonical pipeline graph.
- `RunJournal` integration writes run/step lifecycle entries; `RunStore` enables `getHandle(runId)` lookup and handle reconstruction.
- Checkpoint integration is opt-in through `withCheckpointStore(...)`; `resume(...)` can consume a full checkpoint object or a `pipelineRunId` lookup.

## Testing and Observability
Workflow-specific tests currently exist in:
- `src/__tests__/workflow-builder.test.ts`
- `src/__tests__/workflow-builder-deep.test.ts`
- `src/__tests__/workflow-builder-full.test.ts`

Covered behaviors include:
- Sequential, parallel, branching, suspend, stream, error propagation, and edge cases
- Merge strategies (`merge-objects`, `last-wins`, `concat-arrays`)
- Pipeline definition shape and cloning behavior
- AbortSignal propagation to step context
- Journal integration and `getHandle` error paths

Observability surfaces:
- Per-run callback via `onEvent` in `run`/`resume`
- Async event stream via `stream(...)`
- Journal persistence hooks for run/step lifecycle entries
- Workflow events bridged by downstream consumers (for example `SkillChainExecutor` -> `DzupEventBus`)

## Risks and TODOs
- `resume(...)` and `withCheckpointStore(...)` are implemented in `CompiledWorkflow`, but current workflow-focused tests do not directly exercise checkpoint resume behavior in this module.
- `WorkflowEvent` includes `step:skipped` and `step:retrying`, but `workflow-builder.ts` itself does not emit these events; they are emitted by other consumers (notably `SkillChainExecutor`).
- `run_started` journal append is awaited directly; a failing journal can fail a run before step execution begins.
- `stream()` appends a `workflow:failed` event in its catch path even though `run()` may already emit one; consumers should tolerate potential duplicate failure events.
- `packages/agent/README.md` currently documents `createWorkflow(config): CompiledWorkflow`, but the implementation returns `WorkflowBuilder` (requiring `.build()` before execution).

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

