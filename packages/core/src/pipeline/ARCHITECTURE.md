# Pipeline Architecture (`@dzupagent/core`)

This document describes the architecture, features, flow, usage, downstream references, and test coverage for:

- `packages/core/src/pipeline/pipeline-definition.ts`
- `packages/core/src/pipeline/pipeline-checkpoint-store.ts`
- `packages/core/src/pipeline/pipeline-serialization.ts`
- `packages/core/src/pipeline/pipeline-layout.ts`
- `packages/core/src/pipeline/index.ts`

## 1. Purpose and Scope

The `pipeline` module in `@dzupagent/core` provides the **canonical pipeline contracts** shared across the monorepo:

- Type-level pipeline model (`PipelineDefinition`, node/edge unions)
- Checkpoint persistence interface (`PipelineCheckpointStore`)
- JSON schema validation and serialization/deserialization helpers (Zod-based)
- A lightweight graph layout helper for visualization (`autoLayout`)

It intentionally does **not** execute pipelines. Execution lives in `@dzupagent/agent` (`PipelineRuntime`), which consumes these types.

## 2. Module Responsibilities

| File | Responsibility |
|---|---|
| `pipeline-definition.ts` | Canonical node/edge/checkpoint strategy and validation result types |
| `pipeline-checkpoint-store.ts` | Storage contract for versioned run checkpoints |
| `pipeline-serialization.ts` | Runtime validation schemas + `serializePipeline` / `deserializePipeline` |
| `pipeline-layout.ts` | Topological auto-layout for graph UI |
| `index.ts` | Single re-export facade for the module |

## 3. Data Model

### 3.1 Node Types

`PipelineNode` is a discriminated union over 8 node kinds:

1. `agent`
2. `tool`
3. `transform`
4. `gate`
5. `fork`
6. `join`
7. `loop`
8. `suspend`

All nodes include a common base (`id`, `type`, optional `name`, `description`, `timeoutMs`, `retries`, optional `retryPolicy`).

### 3.2 Edge Types

`PipelineEdge` is a discriminated union of:

1. `sequential` (`sourceNodeId -> targetNodeId`)
2. `conditional` (`predicateName` + `branches` map)
3. `error` (error-routing edge, optional `errorCodes`)

### 3.3 Pipeline Definition

`PipelineDefinition` describes a whole run graph:

- identity: `id`, `name`, `version`, `schemaVersion`
- graph: `entryNodeId`, `nodes[]`, `edges[]`
- optional runtime limits: `budgetLimitCents`, `tokenLimit`
- checkpoint control: `checkpointStrategy`
- metadata/tags

### 3.4 Checkpoint Model

`PipelineCheckpoint` is a versioned snapshot per run:

- run identity: `pipelineRunId`, `pipelineId`, `version`
- replay state: `completedNodeIds`, `state`
- suspension marker: `suspendedAtNodeId?`
- budget snapshot: `budgetState?`
- timestamp: `createdAt` (string)

`PipelineCheckpointStore` defines async persistence operations:

- `save`
- `load` (latest)
- `loadVersion`
- `listVersions`
- `delete`
- `prune`

## 4. Validation and Serialization Layer

`pipeline-serialization.ts` provides Zod schemas for all node types, edge types, checkpoints, and full definitions.

### What this layer guarantees

- Required fields and basic value constraints (`min(1)`, positive ints, enums)
- Schema-version gate (`schemaVersion: '1.0.0'`)
- Parse-time safety for external input (`safeParse` + explicit errors)

### What it intentionally does not guarantee

Semantic graph correctness (entry existence, dangling edges, cycles, fork/join pairing, reachability) is handled downstream by `@dzupagent/agent` validator:

- `packages/agent/src/pipeline/pipeline-validator.ts`

## 5. Execution Flow Across Packages

Core flow in practice:

1. A producer builds a `PipelineDefinition` (for example `WorkflowBuilder` or `PipelineExecutor`).
2. Optional core schema validation via `PipelineDefinitionSchema` and optional JSON serialization (`serializePipeline`).
3. `PipelineRuntime` in `@dzupagent/agent` receives the definition.
4. Runtime performs semantic validation (`validatePipeline`).
5. Runtime executes nodes via user-provided `nodeExecutor`, resolving sequential/conditional/error edges.
6. Runtime checkpoints through a `PipelineCheckpointStore` implementation.
7. Runtime can suspend/resume using `PipelineCheckpoint`.
8. Optional visualization can use `autoLayout` for node coordinates.

## 6. Feature Catalog

### 6.1 Canonical Contract Sharing

All packages share one pipeline schema/type vocabulary from `@dzupagent/core`, reducing drift between authoring, validation, runtime, and docs.

### 6.2 Fully JSON-Friendly Top-Level Model

Definitions/checkpoints are designed to be serializable and transportable.

### 6.3 Explicit Checkpoint Abstraction

A storage interface in core allows runtime and apps to swap backends (in-memory, DB, etc.) without runtime changes.

### 6.4 Layout Utility for UI/Docs

`autoLayout` provides deterministic topological placement for pipeline node rendering.

### 6.5 Runtime-Independent Core

Core has no execution coupling; consumers like `@dzupagent/agent` implement runtime behavior, retries, suspension, recovery, and eventing.

## 7. Usage Examples

### 7.1 Define and Validate a Pipeline

```ts
import {
  type PipelineDefinition,
  PipelineDefinitionSchema,
} from '@dzupagent/core'

const definition: PipelineDefinition = {
  id: 'feature-gen',
  name: 'Feature Generation',
  version: '1.0.0',
  schemaVersion: '1.0.0',
  entryNodeId: 'plan',
  nodes: [
    { id: 'plan', type: 'agent', agentId: 'planner', timeoutMs: 30_000 },
    { id: 'implement', type: 'tool', toolName: 'apply_patch', retries: 2 },
    { id: 'review', type: 'gate', gateType: 'quality' },
  ],
  edges: [
    { type: 'sequential', sourceNodeId: 'plan', targetNodeId: 'implement' },
    { type: 'sequential', sourceNodeId: 'implement', targetNodeId: 'review' },
  ],
  checkpointStrategy: 'after_each_node',
}

const parsed = PipelineDefinitionSchema.safeParse(definition)
if (!parsed.success) {
  throw new Error(parsed.error.issues.map((i) => i.message).join('; '))
}
```

### 7.2 Serialize / Deserialize

```ts
import { serializePipeline, deserializePipeline } from '@dzupagent/core'

const json = serializePipeline(definition)
const restored = deserializePipeline(json)
```

### 7.3 Execute with Agent Runtime and Checkpoints

```ts
import type { PipelineNode } from '@dzupagent/core'
import { PipelineRuntime, InMemoryPipelineCheckpointStore } from '@dzupagent/agent'
import type { NodeExecutionContext, NodeResult } from '@dzupagent/agent'

const checkpointStore = new InMemoryPipelineCheckpointStore()

const nodeExecutor = async (
  nodeId: string,
  node: PipelineNode,
  ctx: NodeExecutionContext,
): Promise<NodeResult> => {
  // Minimal execution example
  ctx.state[`done:${nodeId}`] = true
  return { nodeId, output: { ok: true, type: node.type }, durationMs: 5 }
}

const runtime = new PipelineRuntime({
  definition,
  nodeExecutor,
  checkpointStore,
  predicates: {
    routeByBudget: (s) => Boolean(s['budgetOk']),
  },
})

const result = await runtime.execute({ budgetOk: true })
```

### 7.4 Compute Graph Layout

```ts
import { autoLayout } from '@dzupagent/core'

const nodes = definition.nodes.map((n) => ({ id: n.id }))
const edges = definition.edges.flatMap((e) => {
  if (e.type === 'sequential' || e.type === 'error') {
    return [{ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId }]
  }
  // conditional edges become multiple source->target edges
  return Object.values(e.branches).map((targetNodeId) => ({
    sourceNodeId: e.sourceNodeId,
    targetNodeId,
  }))
})

const layout = autoLayout(nodes, edges)
```

## 8. Cross-Package References and Usage

### 8.1 `@dzupagent/agent` (Primary Runtime Consumer)

- `packages/agent/src/pipeline/pipeline-validator.ts`
  - Consumes `PipelineDefinition` and emits `PipelineValidationResult`.
  - Adds semantic checks beyond core schema (dangling edges, cycles, fork/join balance, reachability).
- `packages/agent/src/pipeline/pipeline-runtime.ts`
  - Executes definitions with retries, branching, loops, error edges, suspension/resume, and checkpoints.
- `packages/agent/src/pipeline/in-memory-checkpoint-store.ts`
  - Concrete implementation of core `PipelineCheckpointStore`.
- `packages/agent/src/pipeline/pipeline-runtime/edge-resolution.ts`
  - Uses core `PipelineEdge` semantics for branching/error routing.

### 8.2 `@dzupagent/agent` Workflow Compilation

- `packages/agent/src/workflow/workflow-builder.ts`
  - Compiles fluent workflow DSL to canonical core `PipelineDefinition`.
  - Runs compiled definition with `PipelineRuntime`.

### 8.3 `@dzupagent/codegen`

- `packages/codegen/src/pipeline/pipeline-executor.ts`
  - Converts `PhaseConfig[]` into core `PipelineDefinition`/`PipelineNode[]`.
  - Delegates execution to `@dzupagent/agent` runtime.

### 8.4 `@dzupagent/server` Documentation

- `packages/server/src/docs/pipeline-doc.ts`
  - Renders pipeline-like structures to markdown + Mermaid.
  - Not tightly coupled to core types, but conceptually aligned with core graph model.

### 8.5 Facade and Root Exports

- `packages/core/src/index.ts` re-exports all pipeline types/schemas/functions.
- `packages/core/src/facades/orchestration.ts` re-exports them in orchestration facade.

## 9. Test Coverage

### 9.1 Direct Core Pipeline Coverage

1. `packages/core/src/pipeline/__tests__/pipeline.test.ts`
   - Node/edge union validation for all node and edge variants
   - Definition and checkpoint schema validation
   - Serialize/deserialize round-trips and failure paths
   - JSON-serializability assertions
2. `packages/core/src/__tests__/pipeline-layout.test.ts`
   - Empty/single/linear/parallel/diamond layout cases
   - Layout metadata (`viewport`, dimensions, algorithm metadata)
3. `packages/core/src/__tests__/facades.test.ts`
   - Verifies orchestration facade exports pipeline schemas/functions/layout

Focused run executed:

- `yarn workspace @dzupagent/core test src/pipeline/__tests__/pipeline.test.ts src/__tests__/pipeline-layout.test.ts src/__tests__/facades.test.ts`
- Result: 76/76 tests passed (3 files), April 3, 2026.

### 9.2 Downstream Runtime/Integration Coverage (Agent Package)

1. `packages/agent/src/__tests__/pipeline-validator.test.ts`
   - Semantic validation cases (cycles, dangling edges, fork/join, loop body, unreachable nodes, missing timeouts)
2. `packages/agent/src/__tests__/pipeline-runtime.test.ts`
   - Runtime behavior (sequential/conditional/error routing, fork/join parallelism, suspend/resume, checkpointing, loop execution, cancellation)
3. `packages/agent/src/__tests__/pipeline-retry.test.ts`
   - Retry/backoff/jitter policy behavior, retry eventing, policy override rules
4. `packages/agent/src/__tests__/checkpoint-store.test.ts`
   - Store behavior and cloning isolation guarantees
5. `packages/agent/src/__tests__/pipeline-templates.test.ts`
   - Template-generated definitions and validator compatibility

Focused run executed:

- `yarn workspace @dzupagent/agent test src/__tests__/pipeline-validator.test.ts src/__tests__/pipeline-runtime.test.ts src/__tests__/checkpoint-store.test.ts src/__tests__/pipeline-retry.test.ts src/__tests__/pipeline-templates.test.ts`
- Result: 139/139 tests passed (5 files), April 3, 2026.

## 10. Architecture Observations and Gaps

1. **Type/schema mismatch for retry policy serialization**
   - `PipelineNodeBase` includes `retryPolicy` in `pipeline-definition.ts`.
   - `PipelineNodeBaseSchema` in `pipeline-serialization.ts` does not include `retryPolicy`.
   - Effect: round-tripping through `serializePipeline` can drop/strip `retryPolicy` fields.
2. **JSON-serializable claim vs `RegExp` in `NodeRetryPolicy`**
   - `retryableErrors?: Array<string | RegExp>` is not strictly JSON-serializable due to `RegExp`.
   - This conflicts with the module-level JSON-serializable guidance.
3. **Timestamp format not strongly validated**
   - `createdAt` is currently `z.string().min(1)` rather than ISO datetime validation.
4. **Layout helper expects flattened edges**
   - `autoLayout` takes `{sourceNodeId,targetNodeId?}` edges; conditional branch maps must be expanded by callers.
   - This is fine but should be documented in API docs.

## 11. Practical Guidance

1. Use core schemas for ingress validation and serialization boundaries.
2. Always run agent semantic validation before execution (runtime already does this).
3. Treat checkpoint store as an infrastructure boundary; keep it deterministic and clone-safe.
4. For visualization, normalize conditional edges to concrete source-target pairs before calling `autoLayout`.

