# Workflow Module Architecture (`packages/agent/src/workflow`)

This document describes the current workflow implementation in `@dzupagent/agent` (source: `packages/agent/src/workflow`) as analyzed on April 4, 2026.

## 1. Scope and Files

Workflow module files:

- `workflow-builder.ts`: fluent DSL, compiler to `PipelineDefinition`, execution wrapper (`run`, `stream`)
- `workflow-types.ts`: step/context/event/node types used by the DSL and runtime bridge
- `index.ts`: public re-exports for workflow API surface

Primary runtime dependency:

- `PipelineRuntime` from `packages/agent/src/pipeline/pipeline-runtime.ts`
- Canonical pipeline contracts (`PipelineDefinition`, `PipelineNode`) from `@dzupagent/core`

## 2. Public API and Feature Set

### 2.1 Entry Points

- `createWorkflow(config)` -> returns `WorkflowBuilder`
- `new WorkflowBuilder(config)`
- `WorkflowBuilder.build()` -> returns `CompiledWorkflow`

### 2.2 Fluent Builder Features

- `then(step)`: append sequential step
- `parallel(steps, mergeStrategy?)`: fan-out and merge
- `branch(condition, branches)`: conditional route by string branch key
- `suspend(reason)`: insert suspend point for human-in-the-loop pause

### 2.3 Execution Features (`CompiledWorkflow`)

- `run(initialState, { signal, runId, onEvent })`
- `stream(initialState, { signal })` async generator of `WorkflowEvent`
- `resume(checkpointOrRunId, additionalState?, { signal, onEvent })` continues execution from a `PipelineCheckpoint` (suspend point) — see §5.3
- `toPipelineDefinition()` for inspection/export of compiled graph
- `withCheckpointStore(store)` opt-in durable suspend/resume via `PipelineCheckpointStore`
- `withJournal(journal)` / `withStore(store)` for journal-based fork/replay (see `RunHandle`)

### 2.4 Supported Merge Strategies

- `merge-objects` (default): shallow object merge from each parallel result
- `last-wins`: only last parallel result object is merged
- `concat-arrays`: stores all parallel outputs into `state.parallelResults`

## 3. Data Model

### 3.1 Step Contract

A `WorkflowStep` is:

- `id: string`
- optional `description`
- `execute(input, ctx) => Promise<output>`

`ctx` includes:

- `workflowId`
- mutable shared `state`
- optional `AbortSignal`

### 3.2 Node Types in Builder IR

Internal node union:

- `step`
- `parallel`
- `branch`
- `suspend`

These are compiled into canonical pipeline nodes/edges for `PipelineRuntime`.

## 4. Compile and Runtime Flow

### 4.1 Build-Time Compilation

`build()` constructs `CompiledWorkflow`, which immediately compiles the builder node list into:

- `PipelineDefinition`
- predicate map for conditional edges
- suspend reason map (`nodeId -> reason`)
- node executor factory mapping transform names to handlers

Compilation details:

- Reverse traversal of workflow IR builds forward execution edges
- Every executable workflow operation becomes a pipeline `transform` node
- `suspend(...)` becomes pipeline `suspend` node
- `branch(...)` creates:
  - a selector transform node that stores chosen branch in internal state key
  - a conditional edge keyed by generated predicate name
  - compiled step sequence per branch

### 4.2 Runtime Execution (`run`)

`run` initializes `PipelineRuntime` with:

- compiled definition
- generated node executor
- predicate map
- abort signal
- runtime event bridge (`PipelineRuntimeEvent` -> `WorkflowEvent`)

Execution behavior:

1. Runtime executes from entry node.
2. Transform handlers emit step/parallel/branch events.
3. Runtime events emit workflow lifecycle events:
   - `workflow:completed`
   - `workflow:failed`
   - `suspended`
4. Final returned value is the latest observed mutable state snapshot.

### 4.3 Streaming Execution (`stream`)

`stream` is a lightweight wrapper over `run`:

- starts `run` in background
- buffers emitted events
- yields events as they arrive
- stops on terminal event (`workflow:completed`, `workflow:failed`, or `suspended`)

## 5. Behavior Semantics

### 5.1 State Mutation Model

- Steps receive the shared mutable state object.
- If a step returns an object, it is shallow-merged into state (`Object.assign`).
- `run` returns a shallow copy of final observed state.

Important for callers:

- Parallel steps are executed via `Promise.all` with the same shared state reference.
- Deterministic output is best achieved by returning result objects, not mutating shared state in-place inside parallel steps.

### 5.2 Branching Semantics

- Branch condition returns a string key.
- If key is not present in configured branches, execution fails with explicit error.
- Branch decision is persisted in internal state key and resolved by runtime predicate.

### 5.3 Suspend / Resume Semantics

- Hitting `suspend(reason)` causes runtime to return in `suspended` state.
- `CompiledWorkflow.run()` surfaces this as a `suspended` event and returns the current state without writing a `run_completed` journal entry.
- Subsequent nodes after suspend are not executed in that run.

Resume continuation (durable):

- When a `PipelineCheckpointStore` is attached via `withCheckpointStore(store)`, the underlying `PipelineRuntime` persists a `PipelineCheckpoint` at every suspension point automatically.
- `CompiledWorkflow.resume(checkpointOrRunId, additionalState?, options?)` rehydrates state and continues from the node *after* the suspension point. It is a thin delegation to `PipelineRuntime.resume(checkpoint, additionalState)`.
- `additionalState` is shallow-merged with the restored state and is the canonical channel for injecting human-in-the-loop input (e.g. an approval payload).
- `resume(...)` writes a `run_resumed` journal entry (when a `RunJournal` is attached) and reuses the original `pipelineRunId`, so a single suspend/resume lifecycle remains under one logical run.

Two distinct continuation modes are now supported:

| Mode | API | Backing store | Use case |
|---|---|---|---|
| Pipeline checkpoint resume | `CompiledWorkflow.resume(...)` | `PipelineCheckpointStore` | Continue a paused run from its suspension point |
| Journal-based fork / replay | `RunHandle.fork(stepId)` / `RunHandle.resumeFromStep(stepId)` (via `getHandle(runId)`) | `RunJournal` + `RunStore` | Branch a new run from any completed step in a historical run |

### 5.4 Error Semantics

- Step failures emit `step:failed` and propagate as thrown errors from `run`.
- Runtime pipeline failure emits `workflow:failed`.
- If runtime returns failed state, `run` throws with best available error source.

## 6. Event Model

Workflow-level events emitted to consumers:

- Step lifecycle: `step:started`, `step:completed`, `step:failed`
- Parallel lifecycle: `parallel:started`, `parallel:completed`
- Branch lifecycle: `branch:evaluated`
- Workflow lifecycle: `suspended`, `workflow:completed`, `workflow:failed`

## 7. Usage Examples

### 7.1 Sequential + Branch

```ts
import { createWorkflow, type WorkflowStep } from '@dzupagent/agent'

const classify: WorkflowStep = {
  id: 'classify',
  execute: async (state) => ({ mode: state['fast'] ? 'quick' : 'full' }),
}

const quick: WorkflowStep = {
  id: 'quick',
  execute: async () => ({ result: 'quick-path' }),
}

const full: WorkflowStep = {
  id: 'full',
  execute: async () => ({ result: 'full-path' }),
}

const workflow = createWorkflow({ id: 'example-branch' })
  .then(classify)
  .branch(
    (s) => String(s['mode']),
    {
      quick: [quick],
      full: [full],
    },
  )
  .build()

const result = await workflow.run({ fast: true })
```

### 7.2 Parallel Fan-Out + Merge

```ts
const workflow = createWorkflow({ id: 'example-parallel' })
  .parallel(
    [
      { id: 'a', execute: async () => ({ a: 1 }) },
      { id: 'b', execute: async () => ({ b: 2 }) },
    ],
    'merge-objects',
  )
  .build()

const result = await workflow.run({})
// result => { a: 1, b: 2 }
```

### 7.3 Human Review Pause + Event Stream

```ts
const workflow = createWorkflow({ id: 'review-flow' })
  .then({ id: 'draft', execute: async () => ({ draft: 'v1' }) })
  .suspend('needs_human_review')
  .then({ id: 'publish', execute: async () => ({ published: true }) })
  .build()

for await (const event of workflow.stream({})) {
  console.log(event)
  // stream stops when suspended/completed/failed
}
```

## 8. Typical Use Cases

- Deterministic multi-step pipelines where each step is explicit and inspectable.
- Fan-out/fan-in subtask execution (analysis, generation, validation in parallel).
- Branch-based policy routing (for example "quick" vs "thorough").
- Human-in-the-loop checkpoints before expensive or sensitive next actions.
- Authoring convenience layer over `PipelineRuntime` when full raw pipeline definitions are unnecessary.

## 9. References Across Monorepo

### 9.1 Direct Runtime/API References

- Public export from package root: `packages/agent/src/index.ts`
- Workflow tests: `packages/agent/src/__tests__/workflow-builder.test.ts`

### 9.2 Documentation References

- `packages/agent/README.md` (Workflow section)
- `packages/agent/ARCHITECTURE.md` (WorkflowBuilder -> PipelineRuntime layer)
- `packages/core/src/pipeline/ARCHITECTURE.md` (WorkflowBuilder named as producer of pipeline definitions)
- `packages/domain-nl2sql/src/workflows/index.ts` (commented usage example)

### 9.3 Related Pattern in Other Packages

- `packages/agent-adapters/src/workflow/adapter-workflow.ts` provides a separate DSL (`AdapterWorkflowBuilder`) that similarly compiles to `PipelineDefinition` and executes with `PipelineRuntime` from `@dzupagent/agent`.

### 9.4 Current Adoption Status

Repository-wide search indicates:

- Direct code usage of `createWorkflow` is currently concentrated in `@dzupagent/agent` tests.
- Other packages mostly reference workflow usage in docs/examples, or use their own workflow abstraction layer.

## 10. Test Coverage and Validation

### 10.1 Workflow-Focused Test File

- `packages/agent/src/__tests__/workflow-builder.test.ts`
- 9 passing tests covering:
  - sequential execution
  - parallel execution merge
  - branch routing
  - event emission
  - suspend behavior
  - pipeline definition compilation
  - error propagation
  - workflow failure event
  - stream API happy path

### 10.2 Executed Commands

From repo root:

```bash
yarn workspace @dzupagent/agent test src/__tests__/workflow-builder.test.ts
yarn workspace @dzupagent/agent test:coverage -- src/__tests__/workflow-builder.test.ts --coverage.include=src/workflow/workflow-builder.ts --coverage.include=src/workflow/workflow-types.ts
```

### 10.3 Coverage Result (Workflow Module Scope)

`workflow-builder.ts` coverage in focused run:

- Statements: 90.19% (497/551)
- Branches: 74.44% (67/90)
- Functions: 93.93% (31/33)
- Lines: 90.19% (497/551)

Uncovered regions from report:

- `workflow-builder.ts`: lines 502-507, 511-517
- These correspond to defensive executor branches for non-transform nodes and missing transform-handler lookup.

### 10.4 Remaining Testing Gaps (Descriptive)

Not explicitly covered by the current workflow test file:

- `parallel(..., 'last-wins')` and `parallel(..., 'concat-arrays')` specific merge semantics
- branch selection error path (`condition` returns unknown key)
- empty workflow/no-op fallback path
- branch with no executable targets fallback (`__default__`)
- stream failure-path event behavior
- cancellation/abort behavior via `AbortSignal`

## 11. Known Constraints and Practical Guidance

- `createWorkflow` returns a builder, so callers must chain and call `.build()` before execution.
- For predictable parallel outcomes, avoid in-place shared state mutation inside parallel step implementations.
- Use `toPipelineDefinition()` when you need graph inspection, diagnostics, or interoperability with lower-level pipeline tooling.
- For durable suspend/resume, attach a `PipelineCheckpointStore` via `withCheckpointStore(...)` and continue with `CompiledWorkflow.resume(runIdOrCheckpoint, additionalState?)`.
- For replay-style branching from any historical step (not just suspension points), use `withJournal(...)` + `withStore(...)` and operate on the `RunHandle` returned by `getHandle(runId)`.
