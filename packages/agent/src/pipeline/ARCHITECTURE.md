# Pipeline Module Architecture (`packages/agent/src/pipeline`)

## Scope

This folder provides the execution runtime and supporting utilities for `PipelineDefinition` graphs from `@dzupagent/core`.

It includes:

- structural validation (`pipeline-validator.ts`)
- runtime execution (`pipeline-runtime.ts`)
- suspend/resume checkpoint persistence (`in-memory-checkpoint-store.ts`)
- loop execution utilities (`loop-executor.ts`)
- retry-policy utilities (`retry-policy.ts`)
- prebuilt pipeline templates (`pipeline-templates.ts`)
- run analytics and bottleneck reporting (`pipeline-analytics.ts`)
- runtime helper modules (`pipeline-runtime/*`)

It does not define the canonical pipeline schema. Schema/node/edge/checkpoint interfaces are defined in:

- `packages/core/src/pipeline/pipeline-definition.ts`
- `packages/core/src/pipeline/pipeline-checkpoint-store.ts`

## Module Map

### Public entrypoints

- `index.ts`
  - local barrel for the pipeline submodule
- `packages/agent/src/index.ts`
  - package-level exports used by other workspaces (`@dzupagent/agent`)

### Runtime and helpers

- `pipeline-runtime.ts`
  - main graph executor
- `pipeline-runtime-types.ts`
  - execution context/result/event/config interfaces
- `pipeline-runtime/edge-resolution.ts`
  - next-node and error-edge routing helpers
- `pipeline-runtime/checkpoint-helpers.ts`
  - canonical checkpoint object creator
- `pipeline-runtime/branch-merge.ts`
  - deterministic branch merge support for fork/join
- `pipeline-runtime/runtime-events.ts`
  - event payload constructors
- `pipeline-runtime/run-id.ts`
  - monotonic run id generator
- `pipeline-runtime/state-utils.ts`
  - deep-ish value equality helper for state delta calculation

### Validation, templates, loop, retries, analytics

- `pipeline-validator.ts`
- `pipeline-templates.ts`
- `loop-executor.ts`
- `retry-policy.ts`
- `in-memory-checkpoint-store.ts`
- `pipeline-analytics.ts`

## Public API

Exposed from `@dzupagent/agent`:

- runtime:
  - `PipelineRuntime`
  - `executeLoop`, `stateFieldTruthy`, `qualityBelow`, `hasErrors`
- validation:
  - `validatePipeline`
- checkpoint store:
  - `InMemoryPipelineCheckpointStore`
- retry:
  - `DEFAULT_RETRY_POLICY`, `calculateBackoff`, `isRetryable`, `resolveRetryPolicy`
- templates:
  - `createCodeReviewPipeline`
  - `createFeatureGenerationPipeline`
  - `createTestGenerationPipeline`
  - `createRefactoringPipeline`
- analytics:
  - `PipelineAnalytics`
- types:
  - `PipelineRunResult`, `PipelineRuntimeConfig`, `PipelineRuntimeEvent`, `NodeExecutionContext`, `NodeResult`, `RetryPolicy`, `LoopMetrics`, `PipelineTracer`

Source references:

- `packages/agent/src/index.ts:210`
- `packages/agent/src/pipeline/index.ts:8`

## Execution Model

## 1) Validation gate

`PipelineRuntime.execute()` always validates the definition first with `validatePipeline()`.

- invalid definitions throw before any node executes
- validation errors are structural (missing entry, dangling edges, duplicate ids, invalid loops, unbalanced fork/join, illegal cycles)
- warnings are advisory (missing timeouts, unreachable nodes, no error handlers, high loop iteration cap)

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:106`
- `packages/agent/src/pipeline/pipeline-validator.ts:23`

## 2) Runtime state and data structures

On run start, runtime creates:

- `runId` via `generateRunId()`
- mutable `runState` object
- `nodeResults: Map<string, NodeResult>`
- `completedNodeIds: string[]`
- checkpoint version tracker

It also pre-indexes nodes and edges in constructor:

- `nodeMap`
- `outgoingEdges` (sequential + conditional)
- `errorEdges` (error routing)

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:83`

## 3) Main control loop

`executeFromNode()` performs a single-node cursor walk:

1. check cancellation (`cancel()` or `AbortSignal`)
2. resolve current node
3. skip if already completed (resume path)
4. dispatch special node types:
   - `suspend`
   - `gate` with `approval`
   - `fork`
   - `loop`
5. otherwise execute as a standard node with retry/recovery logic
6. checkpoint (if configured strategy applies)
7. compute next node id

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:250`

## 4) Node type behavior

### Standard nodes (`agent`, `tool`, `transform`, non-approval `gate`, `join`, etc.)

- emits `pipeline:node_started`
- executes via injected `nodeExecutor(nodeId, node, context)`
- optional retry policy (node + global merged)
- emits completed/failed events
- writes result to `nodeResults`

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:354`

### `suspend` and approval `gate`

- runtime enters `suspended` state
- emits `pipeline:suspended`
- persists checkpoint with `suspendedAtNodeId`

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:654`

### `fork` + `join`

- branch start nodes from outgoing edges run in parallel
- each branch executes until join node boundary
- branch state deltas are merged back in deterministic outgoing-edge order
- branch failures emit node-failed events but do not abort remaining branches

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:694`
- `packages/agent/src/pipeline/pipeline-runtime/branch-merge.ts:20`

### `loop`

- runtime resolves loop body node ids
- delegates iterative execution to `executeLoop()`
- emits per-iteration events
- attaches loop metrics into loop node output:
  - `{ loopOutput, metrics }`

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:820`
- `packages/agent/src/pipeline/loop-executor.ts:24`

## 5) Error handling order

For failed standard nodes, runtime applies this order:

1. retry attempts (if configured and error is retryable)
2. error edges (`type: 'error'`) with code-aware matching
3. recovery copilot (optional)
4. fail run (`pipeline:failed`)

Error code extraction supports:

- object error with `code` field
- message forms:
  - `[CODE] message`
  - `CODE: message`
  - `CODE`

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:371`
- `packages/agent/src/pipeline/pipeline-runtime.ts:897`
- `packages/agent/src/pipeline/pipeline-runtime/edge-resolution.ts:35`

## 6) Optional advanced integrations

### Tracing

- if `tracer` provided, runtime creates spans per node
- fork has parent span and per-branch spans

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:357`
- `packages/agent/src/pipeline/pipeline-runtime.ts:714`

### Stuck detection

- `stuckDetector.recordNodeFailure` and `recordNodeOutput`
- emits `pipeline:stuck_detected`
- may trigger hard abort or strategy-switch hint

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:425`
- `packages/agent/src/pipeline/pipeline-runtime.ts:493`

### Recovery copilot

- optional `recoveryCopilot` with node allowlist and max attempt budget
- emits recovery lifecycle events

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:981`

### Trajectory calibrator

- extracts per-node quality score
- records step baseline data
- emits `pipeline:calibration_suboptimal` when deviation detected

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:527`

### Iteration budget warnings

- tracks cumulative cost from `extractCost`
- emits warning events at >=70% and >=90%

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:565`

## 7) Resume flow

`resume(checkpoint, additionalState?)`:

- reconstructs run state from checkpoint + additional state
- seeds `nodeResults` with placeholders for completed nodes
- continues from first next node after `suspendedAtNodeId`

Source:

- `packages/agent/src/pipeline/pipeline-runtime.ts:152`

## Control Flow Diagrams

### Normal run

```text
execute(initialState)
  -> validatePipeline(definition)
  -> emit pipeline:started
  -> executeFromNode(entryNodeId)
       loop while currentNodeId:
         if cancelled -> return cancelled
         if suspend/approval-gate -> handleSuspend -> return suspended
         if fork -> handleFork -> continue from join successor
         if loop -> handleLoop -> continue/route error
         else standard node execute
              retry? -> success/failure
              on success -> checkpoint? -> next
              on failure -> error edge? recovery? fail
  -> emit pipeline:completed
```

### Failure path for standard node

```text
nodeExecutor() returns error
  -> retry budget left?
      yes + retryable -> emit node_retry -> delay -> retry
      no  -> continue
  -> error edge match?
      yes -> jump to handler node
      no  -> recoveryCopilot configured?
               yes and success -> retry same node
               else -> emit pipeline:failed
```

### Suspend/resume

```text
run hits suspend or approval gate
  -> state = suspended
  -> checkpoint saved with suspendedAtNodeId
  -> return suspended result

resume(checkpoint)
  -> rebuild state and completed nodes
  -> start from first next node after suspendedAtNodeId
  -> continue normal execution
```

## Built-in Templates

`pipeline-templates.ts` ships four starter definitions:

- `createCodeReviewPipeline`
  - flow: `load-diff -> analyze -> review -> quality-gate -> report`
- `createFeatureGenerationPipeline`
  - includes `fix-loop` (`loop` node with `hasErrors` predicate), approval gate, publish step
- `createTestGenerationPipeline`
  - framework-aware metadata/tags (`vitest` default)
- `createRefactoringPipeline`
  - optional test validation step (`validateTests` toggle)

All templates are designed to pass `validatePipeline`.

Source:

- `packages/agent/src/pipeline/pipeline-templates.ts:28`

## Usage Examples

### 1) Minimal runtime execution

```ts
import { PipelineRuntime } from '@dzupagent/agent'
import type { PipelineDefinition, PipelineNode } from '@dzupagent/core'
import type { NodeExecutionContext, NodeResult } from '@dzupagent/agent'

const definition: PipelineDefinition = {
  id: 'demo',
  name: 'Demo Pipeline',
  version: '1.0.0',
  schemaVersion: '1.0.0',
  entryNodeId: 'a',
  nodes: [
    { id: 'a', type: 'transform', transformName: 'step-a', timeoutMs: 5000 },
    { id: 'b', type: 'transform', transformName: 'step-b', timeoutMs: 5000 },
  ],
  edges: [{ type: 'sequential', sourceNodeId: 'a', targetNodeId: 'b' }],
}

const nodeExecutor = async (
  nodeId: string,
  _node: PipelineNode,
  ctx: NodeExecutionContext,
): Promise<NodeResult> => {
  ctx.state[nodeId] = `done:${nodeId}`
  return { nodeId, output: { ok: true }, durationMs: 1 }
}

const runtime = new PipelineRuntime({ definition, nodeExecutor })
const result = await runtime.execute({ seed: 'x' })
```

### 2) Retry + error routing

```ts
import { PipelineRuntime } from '@dzupagent/agent'

const runtime = new PipelineRuntime({
  definition, // include error edge from "work" to "fallback"
  nodeExecutor,
  retryPolicy: { initialBackoffMs: 200, multiplier: 2, maxBackoffMs: 2000 },
  onEvent: (event) => {
    if (event.type === 'pipeline:node_retry') {
      console.log('retry', event.nodeId, event.attempt, event.backoffMs)
    }
  },
})
```

### 3) Suspend/resume with in-memory checkpoints

```ts
import { PipelineRuntime, InMemoryPipelineCheckpointStore } from '@dzupagent/agent'

const checkpointStore = new InMemoryPipelineCheckpointStore()
const runtime = new PipelineRuntime({ definition, nodeExecutor, checkpointStore })

const first = await runtime.execute()
if (first.state === 'suspended') {
  const cp = await checkpointStore.load(first.runId)
  if (cp) {
    const resumed = await runtime.resume(cp, { approvedBy: 'operator' })
    console.log(resumed.state)
  }
}
```

### 4) Loop predicates

```ts
import { qualityBelow, hasErrors, stateFieldTruthy } from '@dzupagent/agent'

const predicates = {
  needsImprovement: qualityBelow('qualityScore', 0.9),
  hasValidationErrors: hasErrors('errors'),
  continueFlag: stateFieldTruthy('continue'),
}
```

### 5) Analytics aggregation

```ts
import { PipelineAnalytics } from '@dzupagent/agent'

const analytics = new PipelineAnalytics()
analytics.addRun(runtimeResult)
const report = analytics.getReport(runtimeResult.pipelineId)
const bottlenecks = analytics.getBottlenecks(runtimeResult.pipelineId, 3)
```

## References in Other Packages

## Direct runtime usage

- `packages/codegen/src/pipeline/pipeline-executor.ts`
  - wraps codegen phase execution on top of `PipelineRuntime` compatibility graph
  - imports `PipelineRuntime`, `NodeExecutionContext`, `NodeResult`
  - constructs transform-only pipeline and delegates execution

- `packages/agent-adapters/src/workflow/adapter-workflow.ts`
  - compiles workflow DSL (`step`, `parallel`, `branch`, `loop`, `transform`) into `PipelineDefinition`
  - executes through `PipelineRuntime`
  - maps runtime lifecycle events into adapter workflow events

## Internal usage inside `@dzupagent/agent`

- `packages/agent/src/workflow/workflow-builder.ts`
  - same pattern as adapter workflow; compiles fluent workflow into runtime graph
- `packages/agent/src/self-correction/self-learning-runtime.ts`
  - wraps `PipelineRuntime` and injects stuck detector, event hook chaining, post-run analysis

## Event ecosystem dependencies (indirect)

- `packages/core/src/events/event-types.ts`
  - canonical pipeline event contracts used across system telemetry
- `packages/otel/src/event-metric-map/pipeline-runtime.ts`
- `packages/otel/src/event-metric-map/pipeline-retry.ts`
  - metrics extraction for pipeline runtime and retry events

## Test Coverage

Pipeline module test suites in `packages/agent/src/__tests__`:

| Test file | Focus area | Tests |
| --- | --- | --- |
| `checkpoint-store.test.ts` | in-memory checkpoint store versions, clone isolation, prune/delete | 11 |
| `pipeline-validator.test.ts` | structural validation errors/warnings and complex graph checks | 18 |
| `pipeline-templates.test.ts` | all template factories and validator compliance | 25 |
| `pipeline-analytics.test.ts` | run aggregation, bottlenecks, cost grouping, reset | 12 |
| `pipeline-runtime-helpers.test.ts` | helper modules (edge resolution, merge, runtime events, run ids) | 7 |
| `pipeline-runtime.test.ts` | runtime control flow, error routing, fork/join, suspend/resume, cancel, loop | 43 |
| `pipeline-retry.test.ts` | runtime retry behavior + retry utility functions | 42 |
| `pipeline-otel.test.ts` | tracer integration and span lifecycle | 6 |

Total in these suites: 164 tests.

Validated on current branch with:

```bash
yarn workspace @dzupagent/agent test \
  src/__tests__/checkpoint-store.test.ts \
  src/__tests__/pipeline-validator.test.ts \
  src/__tests__/pipeline-templates.test.ts \
  src/__tests__/pipeline-analytics.test.ts \
  src/__tests__/pipeline-runtime-helpers.test.ts \
  src/__tests__/pipeline-runtime.test.ts \
  src/__tests__/pipeline-retry.test.ts \
  src/__tests__/pipeline-otel.test.ts
```

Result: all 8 files passed, all 164 tests passed.

## Coverage Notes and Current Gaps

High-confidence covered behavior:

- validation pathways, including loops/fork-join/cycles
- runtime linear/conditional/error/fork/loop/suspend/resume/cancel flows
- retry backoff/jitter/overrides and emitted retry events
- checkpoint store consistency and immutability
- OTel span integration for node/fork/branch execution

Areas with limited or no direct tests in this module:

- `checkpointStrategy: 'manual'` and `'on_suspend'` semantics beyond suspend-path save behavior
- branch-failure policy in fork/join (current runtime emits failure event for failed branch and continues merge)
- recovery copilot integration path (`recoveryCopilot`) in `pipeline-runtime.ts`
- stuck-detector and trajectory calibrator integrations inside runtime
- iteration budget warnings (`iterationBudget`) behavior
- explicit `pipeline:started` / `pipeline:completed` event adaptation to the `pipeline:run_*` shape used in some other packages

## Practical Guidance

- Validate every generated definition with `validatePipeline` before execution.
- Always provide explicit `timeoutMs` on nodes to avoid warning-only defaults.
- For production runs, wire:
  - `onEvent` for observability
  - checkpoint store for resume safety
  - retry policy tuned to your provider/tool failure modes
- If using error-code routing, prefer normalized uppercase codes (`TIMEOUT`, `RATE_LIMIT`, etc.) in node errors.

