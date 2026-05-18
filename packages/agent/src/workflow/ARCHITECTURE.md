# Workflow Module Architecture (`packages/agent/src/workflow`)

## Scope
This document covers the workflow subsystem in `@dzupagent/agent` under `packages/agent/src/workflow`.

Files in scope:
- `compiled-workflow.ts`
- `workflow-builder.ts`
- `workflow-builder-types.ts`
- `workflow-compiler.ts`
- `workflow-compiler-types.ts`
- `workflow-compiler-node-builders.ts`
- `workflow-compiler-error-handlers.ts`
- `workflow-compiler-executor.ts`
- `workflow-types.ts`
- `index.ts`

Related surfaces checked for this refresh:
- `packages/agent/src/index.ts` (package exports)
- `packages/agent/package.json` (export map, dependency declarations)
- `packages/agent/README.md` (public docs)
- `packages/agent/src/__tests__/workflow-builder*.test.ts`
- `packages/agent/src/__tests__/workflow-durability-integration.test.ts`
- `packages/agent/src/skill-chain-executor/*.ts` (workflow-event consumer)

## Responsibilities
The module provides a fluent workflow DSL that compiles into canonical pipeline definitions and executes them through `PipelineRuntime`.

Core responsibilities:
- Build workflow graphs from `step`, `parallel`, `branch`, and `suspend` nodes.
- Support workflow-level error recovery via `onError(predicate, recoverySteps)`.
- Compile workflow nodes into `PipelineDefinition` nodes/edges/predicates plus runtime transform handlers.
- Execute workflows with `run`, `stream`, and `resume` entry points.
- Emit workflow lifecycle events and map runtime pipeline events into workflow events.
- Integrate optional durability primitives: `RunJournal`, `RunStore`, and `PipelineCheckpointStore`.
- Reconstruct `RunHandle`s for active or persisted runs.

## Structure
- `workflow-types.ts`
  Defines public types: `WorkflowStep`, `WorkflowContext`, `WorkflowNode`, `MergeStrategy`, `WorkflowEvent`.

- `workflow-builder-types.ts`
  Defines public builder config and error-handler contracts:
  - `WorkflowConfig`
  - `WorkflowErrorHandler`

- `workflow-builder.ts`
  Defines `WorkflowBuilder` fluent API:
  - `.then(...)`
  - `.parallel(...)`
  - `.branch(...)`
  - `.suspend(...)`
  - `.onError(...)`
  - `.build()` -> `CompiledWorkflow`
  Also exports `createWorkflow(config)` factory.

- `compiled-workflow.ts`
  Holds execution lifecycle and integrations:
  - compilation bootstrap via `compileWorkflow(...)`
  - durability wiring (`withJournal`, `withStore`, `withCheckpointStore`)
  - execution APIs (`run`, `stream`, `resume`)
  - handle retrieval (`getHandle`)
  - runtime-event mapping and journal write helpers

- `workflow-compiler.ts`
  Coordinator that lowers `WorkflowNode[]` into a canonical `PipelineDefinition`, conditional predicates, suspend-reason map, and `NodeExecutor` factory.

- `workflow-compiler-node-builders.ts`
  Per-node lowering helpers for `step`, `parallel`, `branch`, transform/noop, edge linking, and merge strategy application.

- `workflow-compiler-error-handlers.ts`
  Error recovery helpers:
  - `asAbortSignal(...)` bridge from runtime cancellation signal shape to `AbortSignal`
  - `applyErrorHandlers(...)` first-match recovery execution

- `workflow-compiler-executor.ts`
  Builds runtime `NodeExecutor` bound to compiled transform handlers.

- `workflow-compiler-types.ts`
  Internal compiler contracts (`WorkflowTransformHandler`, `WorkflowCompilation`).

- `index.ts`
  Workflow-local re-export surface for builder/class/types.

## Runtime and Control Flow
1. Caller creates a builder with `createWorkflow({ id, description? })`.
2. Builder methods append internal `WorkflowNode`s and optional error handlers.
3. `build()` constructs `CompiledWorkflow`, which immediately calls `compileWorkflow(...)`.
4. Compiler pass:
- Walks nodes in reverse to produce forward execution graph.
- Creates transform nodes for steps/parallel/branch decisions.
- Creates suspend nodes with mapped suspend reasons.
- Creates sequential and conditional edges.
- Builds predicate registry for conditional branch selection.
- Produces a `NodeExecutor` factory bound to transform handlers.
5. `run(initialState, options)`:
- resolves `runId` (explicit or `randomUUID()`)
- optionally appends `run_started` to journal
- executes through `PipelineRuntime.execute(...)`
- translates pipeline events into workflow events
- appends `run_completed` / `run_failed` journal entries
- returns latest observed state snapshot (shallow copy)
6. `stream(initialState, options)`:
- starts `run(...)` in background
- buffers `WorkflowEvent`s from callback
- yields until terminal event: `workflow:completed`, `workflow:failed`, or `suspended`
7. `resume(checkpointOrRunId, additionalState, options)`:
- accepts a `PipelineCheckpoint` directly or loads by `pipelineRunId` from configured checkpoint store
- appends `run_resumed` journal entry
- calls `PipelineRuntime.resume(...)`
- returns latest observed state snapshot

State and merge semantics:
- Step outputs that are objects are merged into state via `Object.assign`.
- Parallel `merge-objects`: shallow-merge all results in order.
- Parallel `last-wins`: shallow-merge only final result.
- Parallel `concat-arrays`: sets `state.parallelResults = results`.
- Branch selection is stored in an internal state key `__wf_branch_selection_<n>` and used by conditional edge predicates.

Error handling semantics:
- Without matching `onError` handlers, thrown step/parallel errors fail the run.
- With matching handlers, recovery steps run sequentially; successful recovery continues workflow progression.
- Recovery handlers are first-match by registration order.

## Key APIs and Types
Builder and factory:
- `createWorkflow(config: WorkflowConfig): WorkflowBuilder`
- `WorkflowBuilder.then(step: WorkflowStep): this`
- `WorkflowBuilder.parallel(steps: WorkflowStep[], mergeStrategy?: MergeStrategy): this`
- `WorkflowBuilder.branch(condition, branches): this`
- `WorkflowBuilder.suspend(reason: string): this`
- `WorkflowBuilder.onError(predicate, recoverySteps): this`
- `WorkflowBuilder.build(): CompiledWorkflow`

Compiled workflow surface:
- `withJournal(journal: RunJournal): this`
- `withStore(store: RunStore): this`
- `withCheckpointStore(checkpointStore: PipelineCheckpointStore): this`
- `toPipelineDefinition(): PipelineDefinition` (deep clone via `structuredClone`)
- `run(initialState, { signal?, runId?, onEvent? })`
- `stream(initialState, { signal? })`
- `resume(checkpointOrRunId, additionalState?, { signal?, onEvent? })`
- `getHandle(runId): Promise<RunHandle>`

Key public types:
- `WorkflowStep<TInput, TOutput>`
- `WorkflowContext` (`workflowId`, shared `state`, optional `signal`)
- `WorkflowNode`
- `MergeStrategy`
- `WorkflowEvent`

`WorkflowEvent` includes:
- Emitted from workflow runtime/compiler path: `step:started`, `step:completed`, `step:failed`, `parallel:started`, `parallel:completed`, `branch:evaluated`, `suspended`, `workflow:completed`, `workflow:failed`
- Included for shared event contract usage: `step:skipped`, `step:retrying` (emitted by `skill-chain-executor`, not by workflow compiler itself)

## Dependencies
Direct imports used by workflow module:
- `@dzupagent/core/pipeline`
  - `PipelineDefinition`, `PipelineNode`
  - `PipelineCheckpoint`, `PipelineCheckpointStore`
- `@dzupagent/core/persistence`
  - `RunJournal`, `RunStore`
- Internal `@dzupagent/agent` modules:
  - `../pipeline/pipeline-runtime.js`
  - `../pipeline/pipeline-runtime-types.js`
  - `../agent/run-handle.js`
  - `../agent/run-handle-types.js`
  - `../utils/exact-optional.js`
- Node built-in:
  - `node:crypto` (`randomUUID`)

Package-level dependency context (`packages/agent/package.json`):
- Runtime deps include `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/security`, `@dzupagent/adapter-types`, `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, `zod`.

## Integration Points
- Public package export surface:
  - `packages/agent/src/index.ts` re-exports `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`, and workflow types.
  - `packages/agent/package.json` export map exposes `./workflow` entry (`dist/workflow.js`, `dist/workflow.d.ts`).

- Runtime execution integration:
  - Compiled workflows execute only through `PipelineRuntime`.
  - Conditional branching relies on compiler-produced predicate map consumed by pipeline runtime.

- Durability and run-management integration:
  - `RunJournal` receives run and step lifecycle entries.
  - `RunStore` is used to validate run existence in `getHandle` fallback path.
  - `RunHandle` reconstruction is handled by `ConcreteRunHandle.fromRunId(...)`.
  - `PipelineCheckpointStore` enables resume by `pipelineRunId`.

- Workflow-event consumers:
  - `skill-chain-executor` compiles skill chains via `createWorkflow(...)` and forwards `WorkflowEvent`s to progress callbacks and optional `DzupEventBus` bridge.
  - `step:skipped` and `step:retrying` are consumed in this path.

## Testing and Observability
Coverage in `packages/agent/src/__tests__`:
- `workflow-builder.test.ts`
  - sequential/parallel/branch/suspend execution
  - event emission
  - pipeline definition inspection
  - error propagation
  - stream terminal events
  - journal/store integration and `getHandle` behavior
- `workflow-builder-deep.test.ts`
  - merge strategy behavior
  - branch edge cases
  - empty workflows
  - stream failure path
  - definition metadata and clone behavior
- `workflow-builder-full.test.ts`
  - extensive composition matrix, context propagation, async flows, abort-signal behavior, durability wiring
- `workflow-durability-integration.test.ts`
  - `getHandle`, checkpoint retrieval, fork/resume-from-step workflows through run-handle path

Observability surfaces:
- `onEvent` callback in `run` and `resume`
- async event stream from `stream`
- journal entries (`run_started`, `step_started`, `step_completed`, `step_failed`, `run_suspended`, `run_resumed`, `run_completed`, `run_failed`)

## Risks and TODOs
- `packages/agent/README.md` currently states `createWorkflow(config): CompiledWorkflow`, but implementation returns `WorkflowBuilder` requiring `.build()`.
- `stream()` can emit `workflow:failed` in its catch path after `run()` has already emitted failure, so consumers should tolerate duplicate failure events.
- `run_started` and `run_resumed` journal writes are awaited directly; a failing journal can fail execution before step runtime starts.
- `WorkflowEvent` union includes `step:skipped`/`step:retrying`, but compiler/runtime path here does not emit them.
- Parallel branches mutate shared `state` object and run concurrently; correctness depends on step authors avoiding conflicting in-place mutations.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

