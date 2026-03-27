# 10 — Pipelines & Workflow Engine

> **Created:** 2026-03-24
> **Status:** Planning
> **Priority:** P1-P2
> **Dependencies:** 04-Orchestration Patterns, 09-Formats & Standards
> **Packages affected:** `@dzipagent/agent`, `@dzipagent/codegen`, `@dzipagent/core`, `@dzipagent/server`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - F1: Pipeline Definition Protocol
   - F2: Unified Execution Engine
   - F3: Workflow Persistence
   - F4: Conditional Loops
   - F5: Sub-Graph Composition
   - F6: Pipeline Registry
   - F7: Pipeline Templates
   - F8: Visual Pipeline Editor Data Model
   - F9: Pipeline Analytics
3. [State Machine](#3-state-machine)
4. [Data Models](#4-data-models)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)

---

## 1. Architecture Overview

### 1.1 Problem Statement

DzipAgent currently has two disconnected pipeline systems:

1. **GenPipelineBuilder** (`@dzipagent/codegen`): A fluent API that captures phase configuration for code generation pipelines. It is codegen-specific — phase types are hardcoded to `generation | subagent | validation | fix | review`. It outputs a flat array of `PipelinePhase` objects with no DAG semantics, no loops, and no persistence.

2. **WorkflowBuilder** (`@dzipagent/agent`): A general-purpose fluent builder with `then/parallel/branch/suspend/build`. The `CompiledWorkflow` executes nodes sequentially in memory. Suspend is a no-op (emits an event but does not actually checkpoint or halt). No persistence, no loops, no sub-graph composition.

3. **PipelineExecutor** (`@dzipagent/codegen`): A separate DAG executor with topological sort, timeouts, retries, and checkpoint callbacks. It operates on its own `PhaseConfig` type that is entirely disconnected from both builders above.

These three systems share no types, no execution model, and no persistence layer. The result is that:

- Workflows cannot loop (fix-validate cycles require manual wiring outside the builder)
- Suspend is cosmetic — no state is actually persisted or recoverable
- There is no pipeline registry, versioning, or reuse
- GenPipelineBuilder and WorkflowBuilder cannot compose with each other
- PipelineExecutor's DAG model and WorkflowBuilder's linear model are incompatible

### 1.2 Design Goals

1. **One definition protocol** — A single `PipelineDefinition` JSON-serializable format that both codegen pipelines and general workflows compile to.
2. **One execution engine** — A `PipelineRuntime` that handles DAGs with cycles (intentional loops), parallel fan-out, conditional edges, gates, and suspend/resume.
3. **Persistent by default** — Execution state checkpoints to a `PipelineCheckpointStore` (in-memory for dev, Postgres for prod, LangGraph checkpointer as optional backend).
4. **Backward compatible** — `GenPipelineBuilder` and `WorkflowBuilder` remain as ergonomic builder APIs. They gain a `.toPipelineDefinition()` method that compiles to the unified format. Existing `.getPhases()` and `.build()` APIs continue to work.
5. **Composable** — Pipelines can nest other pipelines as sub-graphs with input/output mapping and shared budget constraints.

### 1.3 Relationship Between Existing Builders and Unified Engine

```
                         Builder Layer (ergonomic APIs)
                    +----------------------------------+
                    |                                  |
          GenPipelineBuilder              WorkflowBuilder
          (@dzipagent/codegen)           (@dzipagent/agent)
                    |                                  |
                    |  .toPipelineDefinition()         |  .toPipelineDefinition()
                    |                                  |
                    +----------------------------------+
                                   |
                                   v
                       PipelineDefinition (JSON)
                       (@dzipagent/core — types only)
                                   |
                    +--------------+--------------+
                    |              |              |
                    v              v              v
             PipelineRuntime   LangGraph      Pipeline
             (native engine)   Compiler       Registry
             (@dzipagent/     (optional)     (@dzipagent/
              agent)                           server)
```

**Key insight:** The `PipelineDefinition` is a protocol, not a class. It is a JSON-serializable DAG description. Multiple builders can produce it. Multiple runtimes can consume it. This is the same pattern as LangGraph's `StateGraph` compile step, Mastra's workflow serialization, and CrewAI's flow definitions.

### 1.4 Dependency Rules

| Component | Package | Imports from |
|-----------|---------|-------------|
| `PipelineDefinition` types | `@dzipagent/core` | Nothing (pure types) |
| `PipelineRuntime` | `@dzipagent/agent` | `@dzipagent/core` |
| `GenPipelineBuilder.toPipelineDefinition()` | `@dzipagent/codegen` | `@dzipagent/core` (types only) |
| `WorkflowBuilder.toPipelineDefinition()` | `@dzipagent/agent` | `@dzipagent/core` (types only) |
| `PipelineCheckpointStore` interface | `@dzipagent/core` | Nothing (interface) |
| `PostgresPipelineCheckpointStore` | `@dzipagent/server` | `@dzipagent/core` (interface) |
| `PipelineRegistry` | `@dzipagent/server` | `@dzipagent/core` (types) |
| Pipeline analytics | `@dzipagent/agent` | `@dzipagent/core` (types) |

This preserves the rule that `@dzipagent/core` imports nothing from other DzipAgent packages.

### 1.5 DAG Execution Model with Cycle Support

The execution model is a directed graph where:

- **Nodes** execute work (agent calls, tool invocations, transforms, gates, forks, joins)
- **Edges** define transitions (sequential, conditional, error)
- **LoopNodes** are syntactic sugar for a sub-graph with a back-edge that is bounded by a condition and `maxIterations`

Cycles are intentional and bounded. The engine does NOT permit unbounded cycles. Every back-edge must be part of a `LoopNode` with an explicit termination condition and iteration cap.

```
Topological execution for acyclic portions:
  A ──> B ──> C ──> D
        |           ^
        └──> E ─────┘     (B, E can run in parallel since both depend on A)

Loop execution (fix-validate cycle):
  ┌──────────────────────────┐
  │  LoopNode "fix-cycle"    │
  │  maxIterations: 3        │
  │  condition: !state.valid │
  │                          │
  │  fix ──> validate ──┐    │
  │  ^                  │    │
  │  └──────────────────┘    │
  └──────────────────────────┘
```

### 1.6 Persistence and Recovery Architecture

```
  PipelineRuntime
       │
       │  after each node / on suspend / on error
       │
       ├──> PipelineCheckpointStore.save(executionState)
       │
       │  on resume
       │
       ├──> PipelineCheckpointStore.load(pipelineRunId)
       │         │
       │         └──> ExecutionState { completedNodes, currentState, suspendReason, ... }
       │
       └──> Skip completed nodes, resume from checkpoint
```

Checkpoint granularity is configurable:
- `every-node` — checkpoint after every node completes (safest, highest I/O)
- `on-suspend` — checkpoint only when a suspend/gate node is reached (lowest I/O)
- `every-n` — checkpoint every N nodes (tunable tradeoff)
- `manual` — only checkpoint when the node explicitly requests it

---

## 2. Feature Specifications

### F1: Pipeline Definition Protocol (P1, 8h)

**Owner:** `@dzipagent/core` (types), `@dzipagent/agent` (validation utilities)

The Pipeline Definition Protocol is the serializable DAG format that all builders compile to and all runtimes consume.

#### Types

```typescript
// @dzipagent/core/src/pipeline/pipeline-definition.ts

import type { z } from 'zod'

// ─── Node Types ───────────────────────────────────────────────────────

/**
 * Base fields shared by all pipeline nodes.
 * Every node has a unique ID, a human-readable name, and optional metadata.
 */
export interface PipelineNodeBase {
  /** Unique identifier within this pipeline. Must be a valid JS identifier. */
  id: string
  /** Human-readable name for display and logging. */
  name: string
  /** Optional description for documentation. */
  description?: string
  /** Arbitrary metadata (tags, author, etc). */
  metadata?: Record<string, unknown>
  /** Timeout in ms for this node's execution. 0 = no timeout. */
  timeoutMs?: number
  /** Max retries on failure. 0 = no retries. */
  maxRetries?: number
  /** Retry strategy when maxRetries > 0. */
  retryStrategy?: 'immediate' | 'linear-backoff' | 'exponential-backoff'
}

/**
 * AgentNode — invokes a DzipAgent (or sub-agent) with a task.
 *
 * The agent is identified by ID and resolved at runtime from the
 * agent registry or directly from the runtime's agent map.
 */
export interface AgentNode extends PipelineNodeBase {
  type: 'agent'
  /** Agent ID to invoke. Resolved from registry or runtime agent map. */
  agentId: string
  /** Task prompt template. Supports {{variable}} interpolation from state. */
  taskTemplate?: string
  /** Model tier override for this invocation. */
  modelTier?: string
  /** Tool names to make available to the agent. */
  tools?: string[]
  /** Max iterations for the agent's ReAct loop. */
  maxIterations?: number
}

/**
 * ToolNode — invokes a single tool directly (no agent reasoning).
 *
 * Useful for deterministic steps like file writes, API calls, or transforms.
 */
export interface ToolNode extends PipelineNodeBase {
  type: 'tool'
  /** Tool name to invoke. Resolved from the runtime's tool registry. */
  toolName: string
  /** Static input to the tool. Supports {{variable}} interpolation. */
  inputTemplate?: Record<string, unknown>
}

/**
 * TransformNode — runs a pure function on the pipeline state.
 *
 * The transform is identified by name and resolved from a registry
 * of named transform functions at runtime. This keeps the definition
 * JSON-serializable.
 */
export interface TransformNode extends PipelineNodeBase {
  type: 'transform'
  /**
   * Name of a registered transform function.
   * The function signature is: (state: PipelineState) => PipelineState | Promise<PipelineState>
   * Registered via PipelineRuntime.registerTransform(name, fn).
   */
  transformName: string
}

/**
 * GateNode — pauses execution until a condition is met.
 *
 * Gate types:
 * - `approval`: Human-in-the-loop approval (emits approval:requested event)
 * - `budget`: Checks remaining budget against threshold
 * - `quality`: Checks quality score against threshold
 * - `custom`: Evaluates a named predicate function
 */
export interface GateNode extends PipelineNodeBase {
  type: 'gate'
  gateType: 'approval' | 'budget' | 'quality' | 'custom'
  /** For budget gates: max cost in cents before blocking. */
  budgetLimitCents?: number
  /** For quality gates: minimum quality score (0-100). */
  qualityThreshold?: number
  /** For custom gates: name of a registered predicate. */
  predicateName?: string
  /** Timeout for approval gates in ms. 0 = wait indefinitely. */
  approvalTimeoutMs?: number
  /** For approval gates: webhook URL to notify. */
  webhookUrl?: string
}

/**
 * ForkNode — fans out to multiple parallel branches.
 *
 * All target nodes execute concurrently. The corresponding JoinNode
 * collects their results.
 */
export interface ForkNode extends PipelineNodeBase {
  type: 'fork'
  /** IDs of nodes to execute in parallel. */
  targetNodeIds: string[]
}

/**
 * JoinNode — collects results from a ForkNode's parallel branches.
 *
 * Waits for all branches to complete (or fail), then merges results
 * into the pipeline state using the specified strategy.
 */
export interface JoinNode extends PipelineNodeBase {
  type: 'join'
  /** ID of the corresponding ForkNode. */
  forkNodeId: string
  /** Strategy for merging parallel results into state. */
  mergeStrategy: 'merge-objects' | 'concat-arrays' | 'last-wins' | 'custom'
  /** For 'custom' merge: name of a registered merge function. */
  customMergeName?: string
}

/**
 * LoopNode — executes a sub-graph repeatedly until a condition is met.
 *
 * The body is a sequence of node IDs within this pipeline that form
 * the loop body. The condition is evaluated after each iteration.
 * The loop terminates when:
 * - The condition returns false (success)
 * - maxIterations is reached (may be treated as success or failure)
 * - A budget limit is exceeded
 *
 * Loop state is accumulated across iterations. Each iteration receives
 * the state from the previous iteration.
 */
export interface LoopNode extends PipelineNodeBase {
  type: 'loop'
  /**
   * Name of a registered predicate that returns true to CONTINUE looping.
   * Signature: (state: PipelineState, iteration: number) => boolean | Promise<boolean>
   */
  continuePredicateName: string
  /** Maximum iterations before forced termination. Required. */
  maxIterations: number
  /** Node IDs that form the loop body, executed in order. */
  bodyNodeIds: string[]
  /** Whether hitting maxIterations is treated as failure. Default: true. */
  failOnMaxIterations?: boolean
  /** Optional: max cost in cents for the entire loop. */
  loopBudgetCents?: number
}

/**
 * SuspendNode — checkpoints state and halts execution.
 *
 * Execution resumes when an external signal is received (via the
 * PipelineRuntime.resume() API). The resume payload is merged into
 * the pipeline state.
 */
export interface SuspendNode extends PipelineNodeBase {
  type: 'suspend'
  /** Human-readable reason for suspension. */
  reason: string
  /** Zod schema name for validating the resume payload. */
  resumeSchemaName?: string
  /** Auto-resume after this many ms. 0 = wait indefinitely. */
  autoResumeMs?: number
}

/** Union of all node types */
export type PipelineNode =
  | AgentNode
  | ToolNode
  | TransformNode
  | GateNode
  | ForkNode
  | JoinNode
  | LoopNode
  | SuspendNode

// ─── Edge Types ───────────────────────────────────────────────────────

/**
 * SequentialEdge — unconditional transition from source to target.
 */
export interface SequentialEdge {
  type: 'sequential'
  sourceNodeId: string
  targetNodeId: string
}

/**
 * ConditionalEdge — transition depends on a named predicate evaluation.
 *
 * The predicate returns a string key that maps to one of the target
 * branches. If no match is found, the `defaultTargetNodeId` is used.
 */
export interface ConditionalEdge {
  type: 'conditional'
  sourceNodeId: string
  /**
   * Name of a registered routing predicate.
   * Signature: (state: PipelineState) => string
   * The returned string must match a key in `branches`.
   */
  predicateName: string
  /** Map of predicate return value to target node ID. */
  branches: Record<string, string>
  /** Fallback target if predicate returns an unmatched key. */
  defaultTargetNodeId?: string
}

/**
 * ErrorEdge — transition taken when the source node fails.
 *
 * If no error edge exists for a failed node, the pipeline fails.
 */
export interface ErrorEdge {
  type: 'error'
  sourceNodeId: string
  targetNodeId: string
  /** Optional: only match specific error codes. */
  errorCodes?: string[]
}

/** Union of all edge types */
export type PipelineEdge =
  | SequentialEdge
  | ConditionalEdge
  | ErrorEdge

// ─── Pipeline Definition ──────────────────────────────────────────────

/**
 * Complete, JSON-serializable pipeline definition.
 *
 * This is the wire format that builders produce and runtimes consume.
 * It can be stored in a database, transmitted over HTTP, or embedded
 * in an Agent Card.
 *
 * @example
 * ```json
 * {
 *   "id": "feature-gen-v2",
 *   "version": "1.2.0",
 *   "entryNodeId": "intake",
 *   "nodes": [ ... ],
 *   "edges": [ ... ]
 * }
 * ```
 */
export interface PipelineDefinition {
  /** Unique pipeline identifier. */
  id: string
  /** Semantic version string. */
  version: string
  /** Human-readable name. */
  name: string
  /** Description for documentation and registry search. */
  description?: string
  /** Tags for categorization and search. */
  tags?: string[]
  /** Author or team identifier. */
  author?: string

  /** ID of the node where execution begins. */
  entryNodeId: string
  /** All nodes in the pipeline. */
  nodes: PipelineNode[]
  /** All edges connecting nodes. */
  edges: PipelineEdge[]

  /** Default timeout for nodes that don't specify one (ms). */
  defaultTimeoutMs?: number
  /** Default max retries for nodes that don't specify one. */
  defaultMaxRetries?: number
  /** Global budget limit for the entire pipeline (cents). */
  budgetLimitCents?: number
  /** Global token limit for the entire pipeline. */
  tokenLimit?: number

  /** Checkpoint strategy for the runtime. */
  checkpointStrategy?: 'every-node' | 'on-suspend' | 'every-n' | 'manual'
  /** For 'every-n' strategy: checkpoint interval. */
  checkpointIntervalN?: number

  /**
   * Pipeline-level metadata. Preserved across serialization.
   * Use for UI layout data, provenance info, etc.
   */
  metadata?: Record<string, unknown>
}

// ─── Validation ───────────────────────────────────────────────────────

/**
 * Result of validating a PipelineDefinition.
 */
export interface PipelineValidationResult {
  valid: boolean
  errors: PipelineValidationError[]
  warnings: PipelineValidationWarning[]
}

export interface PipelineValidationError {
  code:
    | 'MISSING_ENTRY_NODE'
    | 'DANGLING_EDGE'
    | 'ORPHAN_NODE'
    | 'UNBOUNDED_CYCLE'
    | 'DUPLICATE_NODE_ID'
    | 'MISSING_FORK_JOIN_PAIR'
    | 'INVALID_LOOP_BODY'
    | 'MISSING_PREDICATE'
    | 'TYPE_ERROR'
  message: string
  nodeId?: string
  edgeIndex?: number
}

export interface PipelineValidationWarning {
  code: 'UNREACHABLE_NODE' | 'NO_ERROR_HANDLER' | 'HIGH_MAX_ITERATIONS' | 'MISSING_TIMEOUT'
  message: string
  nodeId?: string
}
```

#### Validation Logic

```typescript
// @dzipagent/agent/src/pipeline/pipeline-validator.ts

import type {
  PipelineDefinition,
  PipelineValidationResult,
  PipelineValidationError,
  PipelineValidationWarning,
  PipelineEdge,
} from '@dzipagent/core'

/**
 * Validates a PipelineDefinition for structural correctness.
 *
 * Checks:
 * 1. Entry node exists in node list
 * 2. All edge source/target IDs reference existing nodes
 * 3. No orphan nodes (unreachable from entry)
 * 4. No duplicate node IDs
 * 5. Fork/Join pairs are balanced
 * 6. Loop body node IDs exist and form a valid sub-graph
 * 7. No unbounded cycles outside of LoopNodes
 *
 * @example
 * ```ts
 * const result = validatePipeline(definition)
 * if (!result.valid) {
 *   console.error('Pipeline errors:', result.errors)
 * }
 * ```
 */
export function validatePipeline(def: PipelineDefinition): PipelineValidationResult {
  const errors: PipelineValidationError[] = []
  const warnings: PipelineValidationWarning[] = []
  const nodeIds = new Set(def.nodes.map(n => n.id))

  // 1. Entry node
  if (!nodeIds.has(def.entryNodeId)) {
    errors.push({
      code: 'MISSING_ENTRY_NODE',
      message: `Entry node "${def.entryNodeId}" not found in node list`,
    })
  }

  // 2. Duplicate node IDs
  const seen = new Set<string>()
  for (const node of def.nodes) {
    if (seen.has(node.id)) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node ID "${node.id}"`,
        nodeId: node.id,
      })
    }
    seen.add(node.id)
  }

  // 3. Dangling edges
  for (let i = 0; i < def.edges.length; i++) {
    const edge = def.edges[i]!
    if (!nodeIds.has(edge.sourceNodeId)) {
      errors.push({
        code: 'DANGLING_EDGE',
        message: `Edge source "${edge.sourceNodeId}" not found`,
        edgeIndex: i,
      })
    }
    const targets = getEdgeTargets(edge)
    for (const t of targets) {
      if (!nodeIds.has(t)) {
        errors.push({
          code: 'DANGLING_EDGE',
          message: `Edge target "${t}" not found`,
          edgeIndex: i,
        })
      }
    }
  }

  // 4. Reachability (warnings for unreachable nodes)
  const reachable = computeReachable(def)
  for (const node of def.nodes) {
    if (!reachable.has(node.id) && node.id !== def.entryNodeId) {
      // Check if node is inside a loop body (still reachable)
      const inLoopBody = def.nodes.some(
        n => n.type === 'loop' && n.bodyNodeIds.includes(node.id),
      )
      if (!inLoopBody) {
        warnings.push({
          code: 'UNREACHABLE_NODE',
          message: `Node "${node.id}" is unreachable from entry`,
          nodeId: node.id,
        })
      }
    }
  }

  // 5. Fork/Join pairing
  const forkNodes = def.nodes.filter(n => n.type === 'fork')
  const joinNodes = def.nodes.filter(n => n.type === 'join')
  for (const join of joinNodes) {
    if (join.type !== 'join') continue
    if (!forkNodes.some(f => f.id === join.forkNodeId)) {
      errors.push({
        code: 'MISSING_FORK_JOIN_PAIR',
        message: `JoinNode "${join.id}" references ForkNode "${join.forkNodeId}" which does not exist`,
        nodeId: join.id,
      })
    }
  }

  // 6. Loop body validation
  for (const node of def.nodes) {
    if (node.type !== 'loop') continue
    for (const bodyId of node.bodyNodeIds) {
      if (!nodeIds.has(bodyId)) {
        errors.push({
          code: 'INVALID_LOOP_BODY',
          message: `LoopNode "${node.id}" references body node "${bodyId}" which does not exist`,
          nodeId: node.id,
        })
      }
    }
    if (node.maxIterations > 100) {
      warnings.push({
        code: 'HIGH_MAX_ITERATIONS',
        message: `LoopNode "${node.id}" has maxIterations=${node.maxIterations} which may be expensive`,
        nodeId: node.id,
      })
    }
  }

  // 7. Unbounded cycle detection (cycles not inside LoopNodes)
  const loopBodyIds = new Set(
    def.nodes
      .filter(n => n.type === 'loop')
      .flatMap(n => n.type === 'loop' ? n.bodyNodeIds : []),
  )
  const nonLoopEdges = def.edges.filter(
    e => !loopBodyIds.has(e.sourceNodeId) || !loopBodyIds.has(getFirstTarget(e)),
  )
  if (hasCycle(def.nodes.filter(n => !loopBodyIds.has(n.id)), nonLoopEdges)) {
    errors.push({
      code: 'UNBOUNDED_CYCLE',
      message: 'Pipeline contains a cycle outside of a LoopNode. Wrap cycles in a LoopNode with maxIterations.',
    })
  }

  // 8. Missing timeout warnings
  for (const node of def.nodes) {
    if (node.type === 'agent' && !node.timeoutMs && !def.defaultTimeoutMs) {
      warnings.push({
        code: 'MISSING_TIMEOUT',
        message: `AgentNode "${node.id}" has no timeout configured`,
        nodeId: node.id,
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/** Extract all target node IDs from an edge. */
function getEdgeTargets(edge: PipelineEdge): string[] {
  switch (edge.type) {
    case 'sequential':
    case 'error':
      return [edge.targetNodeId]
    case 'conditional':
      return [
        ...Object.values(edge.branches),
        ...(edge.defaultTargetNodeId ? [edge.defaultTargetNodeId] : []),
      ]
  }
}

function getFirstTarget(edge: PipelineEdge): string {
  return getEdgeTargets(edge)[0] ?? ''
}

/** BFS reachability from entry node. */
function computeReachable(def: PipelineDefinition): Set<string> {
  const adj = new Map<string, string[]>()
  for (const edge of def.edges) {
    const existing = adj.get(edge.sourceNodeId) ?? []
    existing.push(...getEdgeTargets(edge))
    adj.set(edge.sourceNodeId, existing)
  }
  // Also add fork targets
  for (const node of def.nodes) {
    if (node.type === 'fork') {
      const existing = adj.get(node.id) ?? []
      existing.push(...node.targetNodeIds)
      adj.set(node.id, existing)
    }
    if (node.type === 'loop') {
      const existing = adj.get(node.id) ?? []
      existing.push(...node.bodyNodeIds)
      adj.set(node.id, existing)
    }
  }

  const visited = new Set<string>()
  const queue = [def.entryNodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const neighbor of adj.get(current) ?? []) {
      if (!visited.has(neighbor)) queue.push(neighbor)
    }
  }
  return visited
}

/** Detect cycles using DFS coloring (white/gray/black). */
function hasCycle(
  nodes: Array<{ id: string }>,
  edges: PipelineEdge[],
): boolean {
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    const existing = adj.get(edge.sourceNodeId) ?? []
    existing.push(...getEdgeTargets(edge))
    adj.set(edge.sourceNodeId, existing)
  }

  const white = new Set(nodes.map(n => n.id))
  const gray = new Set<string>()

  function dfs(id: string): boolean {
    if (gray.has(id)) return true // back-edge found
    if (!white.has(id)) return false // already fully processed
    white.delete(id)
    gray.add(id)
    for (const neighbor of adj.get(id) ?? []) {
      if (dfs(neighbor)) return true
    }
    gray.delete(id)
    return false
  }

  for (const node of nodes) {
    if (white.has(node.id) && dfs(node.id)) return true
  }
  return false
}
```

---

### F2: Unified Execution Engine (P1, 12h)

**Owner:** `@dzipagent/agent/src/pipeline/`

The `PipelineRuntime` is the single execution engine for all `PipelineDefinition` instances. It replaces both the `CompiledWorkflow.run()` execution and the `PipelineExecutor.execute()` method.

#### Types

```typescript
// @dzipagent/agent/src/pipeline/pipeline-runtime.ts

import type {
  PipelineDefinition,
  PipelineNode,
  PipelineEdge,
  ConditionalEdge,
} from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

// ─── Pipeline State ───────────────────────────────────────────────────

/**
 * Mutable state threaded through pipeline execution.
 *
 * This is a string-keyed record. Each node reads from and writes to
 * this state. The runtime merges node outputs into the state after
 * each node completes.
 */
export type PipelineState = Record<string, unknown>

// ─── Node Executors ───────────────────────────────────────────────────

/**
 * Function that executes a single pipeline node.
 *
 * Receives the current state and returns the state delta (new/changed keys).
 * The runtime merges the delta into the pipeline state.
 */
export type NodeExecutor = (
  state: Readonly<PipelineState>,
  ctx: NodeExecutionContext,
) => Promise<PipelineState>

/**
 * Context available to node executors during execution.
 */
export interface NodeExecutionContext {
  /** Current node being executed. */
  node: PipelineNode
  /** Pipeline-level run ID. */
  pipelineRunId: string
  /** Pipeline definition ID. */
  pipelineId: string
  /** AbortSignal for cancellation. */
  signal: AbortSignal
  /** Event bus for emitting pipeline events. */
  eventBus: DzipEventBus
  /** For loops: current iteration number (0-indexed). */
  loopIteration?: number
  /** Budget tracker for cost-aware execution. */
  budgetRemaining?: { cents: number; tokens: number }
}

// ─── Registries ───────────────────────────────────────────────────────

/**
 * Named predicate function used by ConditionalEdges and GateNodes.
 */
export type PredicateFn = (
  state: Readonly<PipelineState>,
  iteration?: number,
) => string | boolean | Promise<string | boolean>

/**
 * Named transform function used by TransformNodes.
 */
export type TransformFn = (
  state: Readonly<PipelineState>,
) => PipelineState | Promise<PipelineState>

/**
 * Named merge function used by JoinNodes with 'custom' strategy.
 */
export type MergeFn = (
  branchResults: PipelineState[],
) => PipelineState | Promise<PipelineState>

/**
 * Registry of functions referenced by name in PipelineDefinition.
 *
 * Since PipelineDefinition is JSON-serializable, it cannot contain
 * function references directly. Instead, it references functions by
 * name, and the runtime resolves them from this registry.
 */
export interface PipelineFunctionRegistry {
  predicates: Map<string, PredicateFn>
  transforms: Map<string, TransformFn>
  merges: Map<string, MergeFn>
  nodeExecutors: Map<string, NodeExecutor>
}

// ─── Runtime Configuration ────────────────────────────────────────────

export interface PipelineRuntimeConfig {
  /** Event bus for pipeline events. */
  eventBus: DzipEventBus
  /** Checkpoint store for persistence. Optional — if absent, no checkpointing. */
  checkpointStore?: PipelineCheckpointStore
  /** Function registry for resolving named predicates, transforms, etc. */
  functions: PipelineFunctionRegistry
  /** AbortController for pipeline-level cancellation. */
  abortController?: AbortController
  /** Callback for progress updates. */
  onProgress?: (nodeId: string, status: 'started' | 'completed' | 'failed' | 'skipped') => void
}

// ─── Execution Result ─────────────────────────────────────────────────

export interface NodeResult {
  nodeId: string
  status: 'completed' | 'skipped' | 'failed' | 'timeout' | 'suspended'
  durationMs: number
  retries: number
  error?: string
  /** State delta produced by this node. */
  output?: PipelineState
}

export interface PipelineRunResult {
  pipelineRunId: string
  pipelineId: string
  status: 'completed' | 'failed' | 'suspended' | 'cancelled'
  nodeResults: NodeResult[]
  finalState: PipelineState
  totalDurationMs: number
  totalCostCents?: number
  /** If suspended, which node caused the suspension. */
  suspendedAtNodeId?: string
  /** If suspended, the reason. */
  suspendReason?: string
}

// ─── Pipeline Events (extends DzipEvent) ─────────────────────────────

/**
 * Pipeline-specific events emitted through DzipEventBus.
 *
 * NOTE: These extend the existing pipeline events in event-types.ts.
 * They should be added to the DzipEvent union in @dzipagent/core.
 */
export type PipelineRuntimeEvent =
  | { type: 'pipeline:started'; pipelineRunId: string; pipelineId: string }
  | { type: 'pipeline:node_started'; pipelineRunId: string; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; pipelineRunId: string; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; pipelineRunId: string; nodeId: string; error: string; retryCount: number }
  | { type: 'pipeline:node_skipped'; pipelineRunId: string; nodeId: string; reason: string }
  | { type: 'pipeline:suspended'; pipelineRunId: string; nodeId: string; reason: string }
  | { type: 'pipeline:resumed'; pipelineRunId: string; nodeId: string }
  | { type: 'pipeline:loop_iteration'; pipelineRunId: string; nodeId: string; iteration: number; maxIterations: number }
  | { type: 'pipeline:checkpoint_saved'; pipelineRunId: string; nodeId: string }
  | { type: 'pipeline:completed'; pipelineRunId: string; durationMs: number; totalCostCents?: number }
  | { type: 'pipeline:failed'; pipelineRunId: string; error: string; failedNodeId: string }
  | { type: 'pipeline:cancelled'; pipelineRunId: string }

// ─── Runtime API ──────────────────────────────────────────────────────

/**
 * PipelineRuntime — executes PipelineDefinition instances.
 *
 * The runtime is stateless between runs. All execution state is
 * threaded through PipelineState and optionally persisted via
 * PipelineCheckpointStore.
 *
 * @example
 * ```ts
 * const runtime = new PipelineRuntime({
 *   eventBus,
 *   checkpointStore: new InMemoryPipelineCheckpointStore(),
 *   functions: {
 *     predicates: new Map([['isValid', (s) => s.quality > 80]]),
 *     transforms: new Map(),
 *     merges: new Map(),
 *     nodeExecutors: new Map([
 *       ['agent', createAgentExecutor(agentRegistry)],
 *       ['tool', createToolExecutor(toolRegistry)],
 *     ]),
 *   },
 * })
 *
 * const result = await runtime.execute(pipelineDefinition, { spec: '...' })
 * ```
 */
export interface PipelineRuntimeAPI {
  /**
   * Execute a pipeline from the beginning with the given initial state.
   *
   * If the pipeline suspends, the result will have status 'suspended'
   * and a pipelineRunId that can be used to resume later.
   */
  execute(
    definition: PipelineDefinition,
    initialState: PipelineState,
    options?: { pipelineRunId?: string },
  ): Promise<PipelineRunResult>

  /**
   * Resume a suspended pipeline from its last checkpoint.
   *
   * The resumePayload is merged into the pipeline state before
   * execution continues from the suspended node's successor.
   */
  resume(
    pipelineRunId: string,
    resumePayload?: PipelineState,
  ): Promise<PipelineRunResult>

  /**
   * Cancel a running or suspended pipeline.
   */
  cancel(pipelineRunId: string): Promise<void>

  /**
   * Get the current execution state of a pipeline run.
   */
  getRunState(pipelineRunId: string): Promise<ExecutionState | null>

  /**
   * Register a named predicate function.
   */
  registerPredicate(name: string, fn: PredicateFn): void

  /**
   * Register a named transform function.
   */
  registerTransform(name: string, fn: TransformFn): void

  /**
   * Register a named merge function.
   */
  registerMerge(name: string, fn: MergeFn): void

  /**
   * Register a node executor for a given node type.
   */
  registerNodeExecutor(nodeType: string, executor: NodeExecutor): void
}
```

#### Execution Algorithm (Pseudocode)

```
function execute(definition, initialState):
  validate(definition)  // fail fast on invalid DAGs
  state = { ...initialState }
  runId = generateId()

  // Build adjacency list from edges
  adjList = buildAdjacencyList(definition.edges)

  // Topologically sort non-loop nodes
  executionOrder = topologicalSort(definition.nodes, adjList, definition.entryNodeId)

  completedNodes = Set()

  for node in executionOrder:
    if signal.aborted:
      return { status: 'cancelled', ... }

    // Check if all predecessor edges are satisfied
    if not allPredecessorsComplete(node, adjList, completedNodes):
      skip(node, 'unmet dependencies')
      continue

    // Evaluate conditional incoming edges
    incomingEdge = getActiveIncomingEdge(node, definition.edges, state)
    if incomingEdge is None and node != entryNode:
      skip(node, 'no active incoming edge')
      continue

    match node.type:
      case 'agent' | 'tool' | 'transform':
        result = executeWithRetry(node, state, config)
        state = { ...state, ...result }
        completedNodes.add(node.id)
        checkpoint(runId, state, completedNodes)

      case 'gate':
        if gateType == 'approval':
          checkpoint(runId, state, completedNodes)
          return { status: 'suspended', suspendedAtNodeId: node.id }
        elif gateType == 'budget':
          if state.totalCostCents > node.budgetLimitCents:
            return { status: 'failed', error: 'budget exceeded' }
        elif gateType == 'quality':
          if state.quality < node.qualityThreshold:
            return { status: 'failed', error: 'quality below threshold' }
        completedNodes.add(node.id)

      case 'fork':
        // Execute all target nodes in parallel
        results = await Promise.all(
          node.targetNodeIds.map(id => executeNode(getNode(id), state))
        )
        // Results collected by corresponding JoinNode
        state.__forkResults[node.id] = results
        completedNodes.add(node.id)

      case 'join':
        // Merge results from fork branches
        branchResults = state.__forkResults[node.forkNodeId]
        merged = merge(branchResults, node.mergeStrategy)
        state = { ...state, ...merged }
        completedNodes.add(node.id)

      case 'loop':
        for iteration in 0..node.maxIterations:
          emit('pipeline:loop_iteration', { iteration, maxIterations })
          // Execute body nodes in sequence
          for bodyNodeId in node.bodyNodeIds:
            bodyResult = executeNode(getNode(bodyNodeId), state, { loopIteration: iteration })
            state = { ...state, ...bodyResult }
          // Check continue condition
          shouldContinue = predicates.get(node.continuePredicateName)(state, iteration)
          if not shouldContinue:
            break
          // Check loop budget
          if node.loopBudgetCents and state.totalCostCents > node.loopBudgetCents:
            break
        completedNodes.add(node.id)

      case 'suspend':
        checkpoint(runId, state, completedNodes)
        return { status: 'suspended', suspendedAtNodeId: node.id, reason: node.reason }

  return { status: 'completed', finalState: state }
```

---

### F3: Workflow Persistence (P1, 8h)

**Owner:** `@dzipagent/core` (interfaces), `@dzipagent/server` (Postgres impl), `@dzipagent/agent` (in-memory impl)

#### Checkpoint Store Interface

```typescript
// @dzipagent/core/src/pipeline/pipeline-checkpoint-store.ts

/**
 * Persistent store for pipeline execution state.
 *
 * Enables crash recovery and suspend/resume across process restarts.
 * The interface is intentionally simple — implementations handle
 * serialization and storage strategy.
 */
export interface PipelineCheckpointStore {
  /**
   * Save execution state. Overwrites any existing checkpoint for this runId.
   */
  save(checkpoint: PipelineCheckpoint): Promise<void>

  /**
   * Load the most recent checkpoint for a pipeline run.
   * Returns null if no checkpoint exists.
   */
  load(pipelineRunId: string): Promise<PipelineCheckpoint | null>

  /**
   * Load a specific checkpoint version.
   */
  loadVersion(pipelineRunId: string, version: number): Promise<PipelineCheckpoint | null>

  /**
   * List all checkpoint versions for a pipeline run (most recent first).
   */
  listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]>

  /**
   * Delete all checkpoints for a pipeline run.
   */
  delete(pipelineRunId: string): Promise<void>

  /**
   * Delete checkpoints older than maxAge ms.
   */
  prune(maxAgeMs: number): Promise<number>
}

/**
 * Full checkpoint — everything needed to resume execution.
 */
export interface PipelineCheckpoint {
  /** Unique pipeline run identifier. */
  pipelineRunId: string
  /** Reference to the pipeline definition used. */
  pipelineId: string
  pipelineVersion: string
  /** Auto-incrementing version for this checkpoint. */
  version: number
  /** Serialized pipeline state (JSON-safe). */
  state: Record<string, unknown>
  /** IDs of nodes that have completed. */
  completedNodeIds: string[]
  /** If suspended, which node caused it. */
  suspendedAtNodeId?: string
  /** If suspended, the reason. */
  suspendReason?: string
  /** Node-level results for completed nodes. */
  nodeResults: SerializedNodeResult[]
  /** Budget state at checkpoint time. */
  budgetState?: {
    totalCostCents: number
    totalTokens: number
  }
  /** Schema version for forward compatibility. */
  schemaVersion: number
  /** ISO timestamp. */
  createdAt: string
}

export interface SerializedNodeResult {
  nodeId: string
  status: 'completed' | 'skipped' | 'failed'
  durationMs: number
  retries: number
  error?: string
}

export interface PipelineCheckpointSummary {
  pipelineRunId: string
  version: number
  completedNodeCount: number
  suspendedAtNodeId?: string
  createdAt: string
}
```

#### Execution State (Runtime Internal)

```typescript
// @dzipagent/agent/src/pipeline/execution-state.ts

import type { PipelineCheckpoint, PipelineCheckpointStore } from '@dzipagent/core'
import type { NodeResult } from './pipeline-runtime.js'

/**
 * Mutable execution state maintained by PipelineRuntime during execution.
 *
 * This is the in-memory representation. It is serialized to a
 * PipelineCheckpoint for persistence.
 */
export interface ExecutionState {
  pipelineRunId: string
  pipelineId: string
  pipelineVersion: string
  /** Current pipeline state (mutable). */
  state: Record<string, unknown>
  /** Set of completed node IDs. */
  completedNodeIds: Set<string>
  /** Ordered list of node results. */
  nodeResults: NodeResult[]
  /** Currently executing node (null if idle). */
  currentNodeId: string | null
  /** If suspended. */
  suspendedAtNodeId?: string
  suspendReason?: string
  /** Budget tracking. */
  totalCostCents: number
  totalTokens: number
  /** Checkpoint version counter. */
  checkpointVersion: number
  /** Pipeline start time. */
  startedAt: number
}

/**
 * Serialize ExecutionState to a PipelineCheckpoint for storage.
 */
export function serializeExecutionState(exec: ExecutionState): PipelineCheckpoint {
  return {
    pipelineRunId: exec.pipelineRunId,
    pipelineId: exec.pipelineId,
    pipelineVersion: exec.pipelineVersion,
    version: exec.checkpointVersion,
    state: structuredClone(exec.state),
    completedNodeIds: [...exec.completedNodeIds],
    suspendedAtNodeId: exec.suspendedAtNodeId,
    suspendReason: exec.suspendReason,
    nodeResults: exec.nodeResults.map(r => ({
      nodeId: r.nodeId,
      status: r.status === 'timeout' ? 'failed' : r.status === 'suspended' ? 'completed' : r.status,
      durationMs: r.durationMs,
      retries: r.retries,
      error: r.error,
    })),
    budgetState: {
      totalCostCents: exec.totalCostCents,
      totalTokens: exec.totalTokens,
    },
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Restore ExecutionState from a PipelineCheckpoint.
 */
export function deserializeExecutionState(
  checkpoint: PipelineCheckpoint,
): ExecutionState {
  return {
    pipelineRunId: checkpoint.pipelineRunId,
    pipelineId: checkpoint.pipelineId,
    pipelineVersion: checkpoint.pipelineVersion,
    state: structuredClone(checkpoint.state),
    completedNodeIds: new Set(checkpoint.completedNodeIds),
    nodeResults: checkpoint.nodeResults.map(r => ({
      nodeId: r.nodeId,
      status: r.status,
      durationMs: r.durationMs,
      retries: r.retries,
      error: r.error,
    })),
    currentNodeId: null,
    suspendedAtNodeId: checkpoint.suspendedAtNodeId,
    suspendReason: checkpoint.suspendReason,
    totalCostCents: checkpoint.budgetState?.totalCostCents ?? 0,
    totalTokens: checkpoint.budgetState?.totalTokens ?? 0,
    checkpointVersion: checkpoint.version,
    startedAt: Date.now(),
  }
}
```

#### In-Memory Implementation

```typescript
// @dzipagent/agent/src/pipeline/in-memory-checkpoint-store.ts

import type {
  PipelineCheckpointStore,
  PipelineCheckpoint,
  PipelineCheckpointSummary,
} from '@dzipagent/core'

/**
 * In-memory checkpoint store for development and testing.
 *
 * Data is lost on process restart. Use PostgresPipelineCheckpointStore
 * for production.
 */
export class InMemoryPipelineCheckpointStore implements PipelineCheckpointStore {
  private store = new Map<string, PipelineCheckpoint[]>()

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const versions = this.store.get(checkpoint.pipelineRunId) ?? []
    versions.push(structuredClone(checkpoint))
    this.store.set(checkpoint.pipelineRunId, versions)
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | null> {
    const versions = this.store.get(pipelineRunId)
    if (!versions || versions.length === 0) return null
    return structuredClone(versions[versions.length - 1]!)
  }

  async loadVersion(
    pipelineRunId: string,
    version: number,
  ): Promise<PipelineCheckpoint | null> {
    const versions = this.store.get(pipelineRunId)
    if (!versions) return null
    const match = versions.find(v => v.version === version)
    return match ? structuredClone(match) : null
  }

  async listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]> {
    const versions = this.store.get(pipelineRunId) ?? []
    return versions
      .map(v => ({
        pipelineRunId: v.pipelineRunId,
        version: v.version,
        completedNodeCount: v.completedNodeIds.length,
        suspendedAtNodeId: v.suspendedAtNodeId,
        createdAt: v.createdAt,
      }))
      .reverse()
  }

  async delete(pipelineRunId: string): Promise<void> {
    this.store.delete(pipelineRunId)
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs
    let pruned = 0
    for (const [runId, versions] of this.store) {
      const remaining = versions.filter(
        v => new Date(v.createdAt).getTime() > cutoff,
      )
      pruned += versions.length - remaining.length
      if (remaining.length === 0) {
        this.store.delete(runId)
      } else {
        this.store.set(runId, remaining)
      }
    }
    return pruned
  }
}
```

#### Postgres Implementation (Sketch)

```typescript
// @dzipagent/server/src/persistence/postgres-pipeline-checkpoint-store.ts

import type {
  PipelineCheckpointStore,
  PipelineCheckpoint,
  PipelineCheckpointSummary,
} from '@dzipagent/core'
import type { DrizzleDB } from '../db/drizzle.js'

/**
 * PostgreSQL-backed checkpoint store using Drizzle ORM.
 *
 * Schema:
 *   pipeline_checkpoints (
 *     pipeline_run_id TEXT NOT NULL,
 *     version INTEGER NOT NULL,
 *     pipeline_id TEXT NOT NULL,
 *     pipeline_version TEXT NOT NULL,
 *     state JSONB NOT NULL,
 *     completed_node_ids TEXT[] NOT NULL,
 *     suspended_at_node_id TEXT,
 *     suspend_reason TEXT,
 *     node_results JSONB NOT NULL,
 *     budget_state JSONB,
 *     schema_version INTEGER NOT NULL DEFAULT 1,
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     PRIMARY KEY (pipeline_run_id, version)
 *   )
 *
 *   CREATE INDEX idx_checkpoint_run ON pipeline_checkpoints(pipeline_run_id);
 *   CREATE INDEX idx_checkpoint_created ON pipeline_checkpoints(created_at);
 */
export class PostgresPipelineCheckpointStore implements PipelineCheckpointStore {
  constructor(private db: DrizzleDB) {}

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    // Upsert into pipeline_checkpoints table
    // Implementation uses Drizzle insert().onConflictDoUpdate()
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | null> {
    // SELECT * FROM pipeline_checkpoints
    // WHERE pipeline_run_id = $1
    // ORDER BY version DESC LIMIT 1
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }

  async loadVersion(pipelineRunId: string, version: number): Promise<PipelineCheckpoint | null> {
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }

  async listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]> {
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }

  async delete(pipelineRunId: string): Promise<void> {
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }

  async prune(maxAgeMs: number): Promise<number> {
    // DELETE FROM pipeline_checkpoints WHERE created_at < NOW() - interval '$1 ms'
    throw new Error('Implementation deferred to @dzipagent/server dev agent')
  }
}
```

---

### F4: Conditional Loops (P1, 4h)

**Owner:** `@dzipagent/agent/src/pipeline/`

Loops are first-class nodes in the `PipelineDefinition`. The `LoopNode` type was defined in F1. This section specifies the execution semantics and built-in loop predicates.

#### Loop Execution Semantics

```typescript
// @dzipagent/agent/src/pipeline/loop-executor.ts

import type {
  LoopNode,
  PipelineNode,
} from '@dzipagent/core'
import type {
  PipelineState,
  NodeExecutionContext,
  NodeResult,
  PredicateFn,
} from './pipeline-runtime.js'

/**
 * Metrics accumulated during loop execution.
 */
export interface LoopMetrics {
  /** Total iterations executed. */
  iterationCount: number
  /** Total cost across all iterations (cents). */
  totalCostCents: number
  /** Duration of each iteration (ms). */
  iterationDurations: number[]
  /** Whether the loop terminated because the condition was met. */
  conditionMet: boolean
  /** Whether the loop was capped by maxIterations. */
  hitMaxIterations: boolean
  /** Whether the loop was capped by budget. */
  hitBudgetLimit: boolean
  /**
   * Convergence rate: how much the "quality" or "score" state key
   * changed between the last two iterations. Undefined if not applicable.
   */
  convergenceRate?: number
}

/**
 * Execute a LoopNode.
 *
 * Algorithm:
 * 1. For iteration = 0 to maxIterations - 1:
 *    a. Execute each body node in sequence
 *    b. Evaluate the continue predicate
 *    c. If predicate returns false, break (success)
 *    d. If loop budget exceeded, break (budget)
 * 2. If maxIterations reached and failOnMaxIterations, mark as failed
 * 3. Return accumulated state and metrics
 */
export async function executeLoop(
  loopNode: LoopNode,
  bodyNodes: PipelineNode[],
  state: PipelineState,
  ctx: NodeExecutionContext,
  continuePredicate: PredicateFn,
  executeBodyNode: (
    node: PipelineNode,
    state: PipelineState,
    ctx: NodeExecutionContext,
  ) => Promise<{ state: PipelineState; result: NodeResult }>,
): Promise<{
  state: PipelineState
  metrics: LoopMetrics
  nodeResults: NodeResult[]
  failed: boolean
  error?: string
}> {
  let currentState = { ...state }
  const allNodeResults: NodeResult[] = []
  const iterationDurations: number[] = []
  let conditionMet = false
  let hitBudget = false
  let iterationCount = 0

  for (let i = 0; i < loopNode.maxIterations; i++) {
    iterationCount = i + 1
    const iterStart = Date.now()

    ctx.eventBus.emit({
      type: 'pipeline:loop_iteration',
      pipelineRunId: ctx.pipelineRunId,
      nodeId: loopNode.id,
      iteration: i,
      maxIterations: loopNode.maxIterations,
    } as never) // cast needed until event types are extended

    // Execute body nodes in sequence
    for (const bodyNode of bodyNodes) {
      if (ctx.signal.aborted) {
        return {
          state: currentState,
          metrics: buildMetrics(iterationCount, iterationDurations, conditionMet, false, hitBudget),
          nodeResults: allNodeResults,
          failed: false,
          error: 'Cancelled',
        }
      }

      const { state: newState, result } = await executeBodyNode(
        bodyNode,
        currentState,
        { ...ctx, loopIteration: i },
      )
      currentState = newState
      allNodeResults.push(result)

      if (result.status === 'failed') {
        return {
          state: currentState,
          metrics: buildMetrics(iterationCount, iterationDurations, false, false, hitBudget),
          nodeResults: allNodeResults,
          failed: true,
          error: `Loop body node "${bodyNode.id}" failed: ${result.error}`,
        }
      }
    }

    iterationDurations.push(Date.now() - iterStart)

    // Evaluate continue condition
    const shouldContinue = await continuePredicate(currentState, i)
    if (!shouldContinue || shouldContinue === 'false') {
      conditionMet = true
      break
    }

    // Check loop budget
    if (loopNode.loopBudgetCents !== undefined) {
      const currentCost = typeof currentState['totalCostCents'] === 'number'
        ? currentState['totalCostCents']
        : 0
      if (currentCost > loopNode.loopBudgetCents) {
        hitBudget = true
        break
      }
    }
  }

  const hitMax = !conditionMet && !hitBudget
  const failed = hitMax && (loopNode.failOnMaxIterations ?? true)

  return {
    state: {
      ...currentState,
      [`__loop_${loopNode.id}_metrics`]: buildMetrics(
        iterationCount,
        iterationDurations,
        conditionMet,
        hitMax,
        hitBudget,
      ),
    },
    metrics: buildMetrics(iterationCount, iterationDurations, conditionMet, hitMax, hitBudget),
    nodeResults: allNodeResults,
    failed,
    error: failed
      ? `Loop "${loopNode.id}" reached maxIterations (${loopNode.maxIterations}) without condition being met`
      : undefined,
  }
}

function buildMetrics(
  iterationCount: number,
  iterationDurations: number[],
  conditionMet: boolean,
  hitMaxIterations: boolean,
  hitBudgetLimit: boolean,
): LoopMetrics {
  const totalCost = iterationDurations.reduce((a, b) => a + b, 0)
  return {
    iterationCount,
    totalCostCents: 0, // Populated by runtime from budget tracker
    iterationDurations,
    conditionMet,
    hitMaxIterations,
    hitBudgetLimit,
  }
}
```

#### Built-in Loop Predicates

```typescript
// @dzipagent/agent/src/pipeline/loop-predicates.ts

import type { PredicateFn } from './pipeline-runtime.js'

/**
 * Continue while a state key is falsy.
 * Useful for: "keep looping until state.valid is true"
 */
export function untilTruthy(stateKey: string): PredicateFn {
  return (state) => !state[stateKey]
}

/**
 * Continue while a numeric state key is below a threshold.
 * Useful for: "keep looping until quality > 80"
 */
export function untilAboveThreshold(stateKey: string, threshold: number): PredicateFn {
  return (state) => {
    const value = state[stateKey]
    return typeof value === 'number' ? value < threshold : true
  }
}

/**
 * Continue while errors exist in a state array.
 * Useful for: "keep looping until state.errors is empty"
 */
export function untilNoErrors(stateKey: string): PredicateFn {
  return (state) => {
    const errors = state[stateKey]
    return Array.isArray(errors) && errors.length > 0
  }
}

/**
 * Continue while the score delta between iterations exceeds epsilon.
 * Useful for: "keep looping until convergence"
 */
export function untilConverged(
  stateKey: string,
  epsilon: number,
): PredicateFn {
  let previousValue: number | undefined

  return (state) => {
    const value = state[stateKey]
    if (typeof value !== 'number') return true

    if (previousValue === undefined) {
      previousValue = value
      return true // Always run at least once more
    }

    const delta = Math.abs(value - previousValue)
    previousValue = value
    return delta > epsilon
  }
}

/**
 * Registry of built-in loop predicates.
 * Pipeline definitions reference these by name.
 */
export const BUILTIN_LOOP_PREDICATES: Record<string, (...args: unknown[]) => PredicateFn> = {
  'until-truthy': (key: unknown) => untilTruthy(String(key)),
  'until-above-threshold': (key: unknown, threshold: unknown) =>
    untilAboveThreshold(String(key), Number(threshold)),
  'until-no-errors': (key: unknown) => untilNoErrors(String(key)),
  'until-converged': (key: unknown, epsilon: unknown) =>
    untilConverged(String(key), Number(epsilon)),
}
```

---

### F5: Sub-Graph Composition (P2, 8h)

**Owner:** `@dzipagent/agent/src/pipeline/`

Pipelines can nest other pipelines. A `SubGraphNode` references another `PipelineDefinition` by ID (resolved from the pipeline registry or a provided map) and maps inputs/outputs between the parent and child graphs.

#### Types

```typescript
// @dzipagent/core/src/pipeline/pipeline-definition.ts (additions)

/**
 * SubGraphNode — embeds another PipelineDefinition as a node.
 *
 * The child pipeline runs in an isolated execution context but
 * shares the parent's budget constraints. Input/output mapping
 * controls what state crosses the boundary.
 */
export interface SubGraphNode extends PipelineNodeBase {
  type: 'subgraph'
  /** ID of the child pipeline definition. Resolved from registry. */
  childPipelineId: string
  /** Version constraint (semver). If omitted, latest is used. */
  childPipelineVersion?: string
  /**
   * Map parent state keys to child state keys.
   * Keys are child state keys, values are parent state keys.
   *
   * @example { spec: 'featureSpec', techStack: 'techStack' }
   * This maps parent.featureSpec -> child.spec
   */
  inputMapping: Record<string, string>
  /**
   * Map child output state keys back to parent state keys.
   * Keys are parent state keys, values are child state keys.
   *
   * @example { generatedFiles: 'files', testResults: 'tests' }
   * This maps child.files -> parent.generatedFiles
   */
  outputMapping: Record<string, string>
  /**
   * Budget allocation for the child pipeline.
   * If 'inherit', child shares parent's remaining budget.
   * If a number, child gets a fixed budget (parent's is reduced).
   */
  budgetAllocation?: 'inherit' | number
}
```

#### Execution Semantics

```typescript
// @dzipagent/agent/src/pipeline/subgraph-executor.ts

import type { PipelineDefinition, SubGraphNode } from '@dzipagent/core'
import type { PipelineState, NodeExecutionContext, PipelineRunResult } from './pipeline-runtime.js'

/**
 * Resolver for child pipeline definitions.
 * Can be backed by a registry, a static map, or inline definitions.
 */
export interface PipelineResolver {
  resolve(pipelineId: string, version?: string): Promise<PipelineDefinition | null>
}

/**
 * Execute a sub-graph node.
 *
 * 1. Resolve the child pipeline definition
 * 2. Map parent state to child initial state via inputMapping
 * 3. Allocate budget to child
 * 4. Execute child pipeline using the same PipelineRuntime
 * 5. Map child final state back to parent via outputMapping
 *
 * If the child pipeline suspends, the parent pipeline also suspends.
 * When the parent is resumed, the child resumes first, then the
 * parent continues.
 */
export async function executeSubGraph(
  node: SubGraphNode,
  parentState: PipelineState,
  ctx: NodeExecutionContext,
  resolver: PipelineResolver,
  executeChildPipeline: (
    def: PipelineDefinition,
    state: PipelineState,
    budgetCents?: number,
  ) => Promise<PipelineRunResult>,
): Promise<{
  parentStateDelta: PipelineState
  childResult: PipelineRunResult
}> {
  // 1. Resolve child definition
  const childDef = await resolver.resolve(node.childPipelineId, node.childPipelineVersion)
  if (!childDef) {
    throw new Error(
      `SubGraphNode "${node.id}": child pipeline "${node.childPipelineId}" not found`,
    )
  }

  // 2. Build child initial state from input mapping
  const childState: PipelineState = {}
  for (const [childKey, parentKey] of Object.entries(node.inputMapping)) {
    if (parentKey in parentState) {
      childState[childKey] = parentState[parentKey]
    }
  }

  // 3. Determine budget
  let budgetCents: number | undefined
  if (typeof node.budgetAllocation === 'number') {
    budgetCents = node.budgetAllocation
  }

  // 4. Execute child
  const childResult = await executeChildPipeline(childDef, childState, budgetCents)

  // 5. Map output back to parent
  const parentStateDelta: PipelineState = {}
  for (const [parentKey, childKey] of Object.entries(node.outputMapping)) {
    if (childKey in childResult.finalState) {
      parentStateDelta[parentKey] = childResult.finalState[childKey]
    }
  }

  // Propagate child status metadata
  parentStateDelta[`__subgraph_${node.id}_status`] = childResult.status
  parentStateDelta[`__subgraph_${node.id}_duration`] = childResult.totalDurationMs

  return { parentStateDelta, childResult }
}
```

---

### F6: Pipeline Registry (P2, 8h)

**Owner:** `@dzipagent/core` (interface), `@dzipagent/server` (Postgres impl), `@dzipagent/agent` (in-memory impl)

#### Interface

```typescript
// @dzipagent/core/src/pipeline/pipeline-registry.ts

import type { PipelineDefinition } from './pipeline-definition.js'

/**
 * Registry for storing, versioning, and discovering pipeline definitions.
 */
export interface PipelineRegistry {
  /**
   * Save a pipeline definition. If a pipeline with the same ID exists,
   * this creates a new version. The version field in the definition
   * must be newer than the latest stored version (semver comparison).
   */
  save(definition: PipelineDefinition): Promise<void>

  /**
   * Get a specific version of a pipeline. If version is omitted,
   * returns the latest version.
   */
  get(pipelineId: string, version?: string): Promise<PipelineDefinition | null>

  /**
   * Get the latest version of a pipeline.
   */
  getLatest(pipelineId: string): Promise<PipelineDefinition | null>

  /**
   * List all versions of a pipeline (newest first).
   */
  listVersions(pipelineId: string): Promise<PipelineVersionSummary[]>

  /**
   * Search pipelines by criteria.
   */
  search(query: PipelineSearchQuery): Promise<PipelineSearchResult[]>

  /**
   * Delete a specific version. Deleting the latest version makes the
   * previous version "latest".
   */
  deleteVersion(pipelineId: string, version: string): Promise<void>

  /**
   * Delete all versions of a pipeline.
   */
  deleteAll(pipelineId: string): Promise<void>

  /**
   * Record a pipeline execution for usage tracking.
   */
  recordExecution(pipelineId: string, version: string, durationMs: number, success: boolean): Promise<void>
}

export interface PipelineVersionSummary {
  pipelineId: string
  version: string
  name: string
  createdAt: string
  nodeCount: number
  /** Number of times this version was executed. */
  executionCount: number
}

export interface PipelineSearchQuery {
  /** Full-text search across name, description, tags. */
  text?: string
  /** Filter by tags (AND). */
  tags?: string[]
  /** Filter by author. */
  author?: string
  /** Sort field. */
  sortBy?: 'name' | 'created' | 'popularity'
  /** Sort direction. */
  sortOrder?: 'asc' | 'desc'
  /** Pagination. */
  limit?: number
  offset?: number
}

export interface PipelineSearchResult {
  pipelineId: string
  latestVersion: string
  name: string
  description?: string
  tags: string[]
  author?: string
  /** Total executions across all versions. */
  totalExecutions: number
  createdAt: string
  updatedAt: string
}
```

---

### F7: Pipeline Templates (P1, 4h)

**Owner:** `@dzipagent/agent/src/pipeline/`

Pre-built `PipelineDefinition` factories for common patterns. Each template returns a `PipelineDefinition` that can be customized via parameters before execution.

```typescript
// @dzipagent/agent/src/pipeline/pipeline-templates.ts

import type { PipelineDefinition } from '@dzipagent/core'

/**
 * Template parameters for customizing pre-built pipelines.
 */
export interface TemplateParams {
  /** Pipeline ID override. */
  id?: string
  /** Pipeline name override. */
  name?: string
  /** Global timeout override. */
  defaultTimeoutMs?: number
  /** Global budget override. */
  budgetLimitCents?: number
  /** Additional metadata. */
  metadata?: Record<string, unknown>
}

// ─── Feature Generation Pipeline ──────────────────────────────────────

/**
 * 12-stage feature generation pipeline.
 *
 * intake -> clarify -> plan -> [gate: plan_approval] ->
 * [fork: gen_db, gen_backend, gen_frontend, gen_tests] -> [join] ->
 * run_tests -> validate -> [loop: fix_cycle { fix -> validate }] ->
 * review -> publish
 */
export function featureGenerationPipeline(
  params?: TemplateParams & {
    /** Max fix iterations. Default: 3. */
    maxFixIterations?: number
    /** Quality threshold (0-100). Default: 80. */
    qualityThreshold?: number
    /** Whether plan requires human approval. Default: true. */
    requirePlanApproval?: boolean
  },
): PipelineDefinition {
  const maxFix = params?.maxFixIterations ?? 3
  const threshold = params?.qualityThreshold ?? 80
  const requireApproval = params?.requirePlanApproval ?? true

  return {
    id: params?.id ?? 'feature-generation',
    version: '1.0.0',
    name: params?.name ?? 'Feature Generation Pipeline',
    description: '12-stage pipeline for generating complete features with DB, backend, frontend, and tests',
    tags: ['codegen', 'feature', 'full-stack'],
    entryNodeId: 'intake',
    defaultTimeoutMs: params?.defaultTimeoutMs ?? 120_000,
    budgetLimitCents: params?.budgetLimitCents,
    checkpointStrategy: 'every-node',
    nodes: [
      { id: 'intake', name: 'Intake', type: 'agent', agentId: 'intake-agent', description: 'Parse and validate feature request' },
      { id: 'clarify', name: 'Clarify', type: 'agent', agentId: 'clarify-agent', description: 'Clarify ambiguous requirements' },
      { id: 'plan', name: 'Plan', type: 'agent', agentId: 'plan-agent', description: 'Generate implementation plan' },
      ...(requireApproval
        ? [{ id: 'plan-approval', name: 'Plan Approval', type: 'gate' as const, gateType: 'approval' as const, approvalTimeoutMs: 600_000 }]
        : []),
      { id: 'gen-fork', name: 'Generation Fork', type: 'fork', targetNodeIds: ['gen-db', 'gen-backend', 'gen-frontend', 'gen-tests'] },
      { id: 'gen-db', name: 'Generate DB', type: 'agent', agentId: 'db-gen-agent', description: 'Generate database schema and migrations' },
      { id: 'gen-backend', name: 'Generate Backend', type: 'agent', agentId: 'backend-gen-agent', description: 'Generate API routes and services' },
      { id: 'gen-frontend', name: 'Generate Frontend', type: 'agent', agentId: 'frontend-gen-agent', description: 'Generate UI components and pages' },
      { id: 'gen-tests', name: 'Generate Tests', type: 'agent', agentId: 'test-gen-agent', description: 'Generate test suites' },
      { id: 'gen-join', name: 'Generation Join', type: 'join', forkNodeId: 'gen-fork', mergeStrategy: 'merge-objects' },
      { id: 'run-tests', name: 'Run Tests', type: 'tool', toolName: 'run-tests' },
      { id: 'validate', name: 'Validate', type: 'agent', agentId: 'validation-agent', description: 'Quality scoring and validation' },
      {
        id: 'fix-cycle', name: 'Fix Cycle', type: 'loop',
        continuePredicateName: 'until-above-threshold',
        maxIterations: maxFix,
        bodyNodeIds: ['fix', 'revalidate'],
        failOnMaxIterations: false,
      },
      { id: 'fix', name: 'Fix', type: 'agent', agentId: 'fix-agent', description: 'Fix validation and test failures' },
      { id: 'revalidate', name: 'Revalidate', type: 'agent', agentId: 'validation-agent', description: 'Re-run validation' },
      { id: 'review', name: 'Review', type: 'gate', gateType: 'quality', qualityThreshold: threshold },
      { id: 'publish', name: 'Publish', type: 'agent', agentId: 'publish-agent', description: 'Publish generated feature' },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'intake', targetNodeId: 'clarify' },
      { type: 'sequential', sourceNodeId: 'clarify', targetNodeId: 'plan' },
      ...(requireApproval
        ? [
            { type: 'sequential' as const, sourceNodeId: 'plan', targetNodeId: 'plan-approval' },
            { type: 'sequential' as const, sourceNodeId: 'plan-approval', targetNodeId: 'gen-fork' },
          ]
        : [{ type: 'sequential' as const, sourceNodeId: 'plan', targetNodeId: 'gen-fork' }]),
      { type: 'sequential', sourceNodeId: 'gen-join', targetNodeId: 'run-tests' },
      { type: 'sequential', sourceNodeId: 'run-tests', targetNodeId: 'validate' },
      {
        type: 'conditional', sourceNodeId: 'validate',
        predicateName: 'validation-router',
        branches: { pass: 'review', fail: 'fix-cycle' },
      },
      { type: 'sequential', sourceNodeId: 'fix-cycle', targetNodeId: 'review' },
      { type: 'sequential', sourceNodeId: 'review', targetNodeId: 'publish' },
    ],
    metadata: params?.metadata,
  }
}

// ─── Code Review Pipeline ─────────────────────────────────────────────

/**
 * Code review pipeline: analyze -> review -> report
 */
export function codeReviewPipeline(
  params?: TemplateParams,
): PipelineDefinition {
  return {
    id: params?.id ?? 'code-review',
    version: '1.0.0',
    name: params?.name ?? 'Code Review Pipeline',
    description: 'Automated code review with analysis, review, and report generation',
    tags: ['review', 'quality'],
    entryNodeId: 'analyze',
    defaultTimeoutMs: params?.defaultTimeoutMs ?? 60_000,
    checkpointStrategy: 'on-suspend',
    nodes: [
      { id: 'analyze', name: 'Analyze', type: 'agent', agentId: 'analysis-agent', description: 'Static analysis and code parsing' },
      { id: 'security-review', name: 'Security Review', type: 'agent', agentId: 'security-agent', description: 'Security vulnerability scan' },
      { id: 'quality-review', name: 'Quality Review', type: 'agent', agentId: 'quality-agent', description: 'Code quality assessment' },
      { id: 'review-fork', name: 'Review Fork', type: 'fork', targetNodeIds: ['security-review', 'quality-review'] },
      { id: 'review-join', name: 'Review Join', type: 'join', forkNodeId: 'review-fork', mergeStrategy: 'merge-objects' },
      { id: 'report', name: 'Report', type: 'agent', agentId: 'report-agent', description: 'Generate consolidated review report' },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'analyze', targetNodeId: 'review-fork' },
      { type: 'sequential', sourceNodeId: 'review-join', targetNodeId: 'report' },
    ],
    metadata: params?.metadata,
  }
}

// ─── Migration Pipeline ───────────────────────────────────────────────

/**
 * Migration pipeline: analyze -> plan -> [gate: approval] -> execute -> verify
 */
export function migrationPipeline(
  params?: TemplateParams & { requireApproval?: boolean },
): PipelineDefinition {
  const requireApproval = params?.requireApproval ?? true

  return {
    id: params?.id ?? 'migration',
    version: '1.0.0',
    name: params?.name ?? 'Migration Pipeline',
    description: 'Database or code migration with analysis, planning, execution, and verification',
    tags: ['migration', 'database'],
    entryNodeId: 'analyze',
    defaultTimeoutMs: params?.defaultTimeoutMs ?? 180_000,
    checkpointStrategy: 'every-node',
    nodes: [
      { id: 'analyze', name: 'Analyze', type: 'agent', agentId: 'migration-analyst', description: 'Analyze current state and migration scope' },
      { id: 'plan', name: 'Plan', type: 'agent', agentId: 'migration-planner', description: 'Generate migration plan with rollback strategy' },
      ...(requireApproval
        ? [{ id: 'approval', name: 'Approval Gate', type: 'gate' as const, gateType: 'approval' as const, approvalTimeoutMs: 3600_000 }]
        : []),
      { id: 'execute', name: 'Execute', type: 'agent', agentId: 'migration-executor', description: 'Execute migration steps' },
      { id: 'verify', name: 'Verify', type: 'agent', agentId: 'migration-verifier', description: 'Verify migration success and data integrity' },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'analyze', targetNodeId: 'plan' },
      ...(requireApproval
        ? [
            { type: 'sequential' as const, sourceNodeId: 'plan', targetNodeId: 'approval' },
            { type: 'sequential' as const, sourceNodeId: 'approval', targetNodeId: 'execute' },
          ]
        : [{ type: 'sequential' as const, sourceNodeId: 'plan', targetNodeId: 'execute' }]),
      { type: 'sequential', sourceNodeId: 'execute', targetNodeId: 'verify' },
      { type: 'error', sourceNodeId: 'execute', targetNodeId: 'verify' },
    ],
    metadata: params?.metadata,
  }
}

// ─── RAG Pipeline ─────────────────────────────────────────────────────

/**
 * RAG pipeline: retrieve -> augment -> generate -> validate
 */
export function ragPipeline(
  params?: TemplateParams,
): PipelineDefinition {
  return {
    id: params?.id ?? 'rag',
    version: '1.0.0',
    name: params?.name ?? 'RAG Pipeline',
    description: 'Retrieval-Augmented Generation with validation',
    tags: ['rag', 'retrieval', 'generation'],
    entryNodeId: 'retrieve',
    defaultTimeoutMs: params?.defaultTimeoutMs ?? 30_000,
    checkpointStrategy: 'on-suspend',
    nodes: [
      { id: 'retrieve', name: 'Retrieve', type: 'tool', toolName: 'vector-search', description: 'Retrieve relevant documents' },
      { id: 'augment', name: 'Augment', type: 'transform', transformName: 'augment-context', description: 'Augment prompt with retrieved context' },
      { id: 'generate', name: 'Generate', type: 'agent', agentId: 'generation-agent', description: 'Generate answer from augmented context' },
      { id: 'validate', name: 'Validate', type: 'agent', agentId: 'validation-agent', description: 'Validate answer against sources' },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'retrieve', targetNodeId: 'augment' },
      { type: 'sequential', sourceNodeId: 'augment', targetNodeId: 'generate' },
      { type: 'sequential', sourceNodeId: 'generate', targetNodeId: 'validate' },
    ],
    metadata: params?.metadata,
  }
}

/**
 * Index of all built-in pipeline templates.
 */
export const PIPELINE_TEMPLATES = {
  'feature-generation': featureGenerationPipeline,
  'code-review': codeReviewPipeline,
  'migration': migrationPipeline,
  'rag': ragPipeline,
} as const

export type PipelineTemplateName = keyof typeof PIPELINE_TEMPLATES
```

---

### F8: Visual Pipeline Editor Data Model (P3, 8h)

**Owner:** `@dzipagent/core` (types), `@dzipagent/agent` (conversion utilities)

The visual editor data model extends `PipelineDefinition.metadata` with layout information compatible with React Flow and Vue Flow.

```typescript
// @dzipagent/core/src/pipeline/pipeline-visual.ts

/**
 * Layout information for a pipeline node in a visual editor.
 * Stored in PipelineDefinition.metadata.layout
 */
export interface PipelineLayout {
  /** Node positions and dimensions. Keyed by node ID. */
  nodes: Record<string, NodeLayout>
  /** Viewport state. */
  viewport?: {
    x: number
    y: number
    zoom: number
  }
}

export interface NodeLayout {
  /** X position in canvas coordinates. */
  x: number
  /** Y position in canvas coordinates. */
  y: number
  /** Width (optional, auto-sized if omitted). */
  width?: number
  /** Height (optional, auto-sized if omitted). */
  height?: number
}

/**
 * Convert a PipelineDefinition to React Flow / Vue Flow compatible format.
 *
 * React Flow expects arrays of { id, type, position, data } nodes
 * and { id, source, target, ... } edges.
 */
export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: {
    label: string
    description?: string
    nodeType: string // PipelineNode.type
    config: Record<string, unknown>
  }
  width?: number
  height?: number
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  type?: 'default' | 'smoothstep' | 'step'
  label?: string
  animated?: boolean
  style?: Record<string, string>
  data?: {
    edgeType: string // PipelineEdge.type
    condition?: string
  }
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  viewport?: { x: number; y: number; zoom: number }
}
```

```typescript
// @dzipagent/agent/src/pipeline/pipeline-visual-converter.ts

import type { PipelineDefinition, PipelineEdge } from '@dzipagent/core'
import type { FlowGraph, FlowNode, FlowEdge, PipelineLayout } from '@dzipagent/core'

/**
 * Convert PipelineDefinition to FlowGraph for visual editors.
 *
 * If the definition has layout metadata, positions come from there.
 * Otherwise, an auto-layout algorithm places nodes in a top-down DAG layout.
 */
export function pipelineToFlowGraph(def: PipelineDefinition): FlowGraph {
  const layout = (def.metadata?.['layout'] as PipelineLayout | undefined) ?? autoLayout(def)

  const flowNodes: FlowNode[] = def.nodes.map(node => ({
    id: node.id,
    type: mapNodeTypeToFlowType(node.type),
    position: layout.nodes[node.id] ?? { x: 0, y: 0 },
    data: {
      label: node.name,
      description: node.description,
      nodeType: node.type,
      config: node as unknown as Record<string, unknown>,
    },
  }))

  const flowEdges: FlowEdge[] = def.edges.flatMap((edge, i) =>
    expandEdge(edge, i),
  )

  return {
    nodes: flowNodes,
    edges: flowEdges,
    viewport: layout.viewport,
  }
}

/**
 * Convert FlowGraph back to PipelineDefinition layout metadata.
 * The pipeline structure (nodes, edges) is NOT modified — only positions.
 */
export function flowGraphToLayout(flow: FlowGraph): PipelineLayout {
  const nodes: Record<string, { x: number; y: number; width?: number; height?: number }> = {}
  for (const node of flow.nodes) {
    nodes[node.id] = {
      x: node.position.x,
      y: node.position.y,
      width: node.width,
      height: node.height,
    }
  }
  return { nodes, viewport: flow.viewport }
}

/**
 * Export pipeline as Mermaid graph syntax for documentation.
 */
export function pipelineToMermaid(def: PipelineDefinition): string {
  const lines: string[] = ['graph TD']

  for (const node of def.nodes) {
    const shape = getMermaidShape(node.type)
    lines.push(`  ${node.id}${shape[0]}"${node.name}"${shape[1]}`)
  }

  for (const edge of def.edges) {
    switch (edge.type) {
      case 'sequential':
        lines.push(`  ${edge.sourceNodeId} --> ${edge.targetNodeId}`)
        break
      case 'conditional':
        for (const [label, target] of Object.entries(edge.branches)) {
          lines.push(`  ${edge.sourceNodeId} -->|${label}| ${target}`)
        }
        break
      case 'error':
        lines.push(`  ${edge.sourceNodeId} -.->|error| ${edge.targetNodeId}`)
        break
    }
  }

  return lines.join('\n')
}

function mapNodeTypeToFlowType(type: string): string {
  const mapping: Record<string, string> = {
    agent: 'agentNode',
    tool: 'toolNode',
    transform: 'transformNode',
    gate: 'gateNode',
    fork: 'forkNode',
    join: 'joinNode',
    loop: 'loopNode',
    suspend: 'suspendNode',
    subgraph: 'subgraphNode',
  }
  return mapping[type] ?? 'default'
}

function expandEdge(edge: PipelineEdge, index: number): FlowEdge[] {
  switch (edge.type) {
    case 'sequential':
      return [{
        id: `e-${index}`,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        type: 'smoothstep',
        data: { edgeType: 'sequential' },
      }]
    case 'conditional':
      return Object.entries(edge.branches).map(([label, target], j) => ({
        id: `e-${index}-${j}`,
        source: edge.sourceNodeId,
        target,
        type: 'smoothstep',
        label,
        animated: true,
        data: { edgeType: 'conditional', condition: label },
      }))
    case 'error':
      return [{
        id: `e-${index}`,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        type: 'step',
        label: 'error',
        style: { stroke: '#ef4444' },
        data: { edgeType: 'error' },
      }]
  }
}

function getMermaidShape(type: string): [string, string] {
  const shapes: Record<string, [string, string]> = {
    agent: ['[', ']'],
    tool: ['(', ')'],
    transform: ['{{', '}}'],
    gate: ['{', '}'],
    fork: ['[/', '\\]'],
    join: ['[\\', '/]'],
    loop: ['[[', ']]'],
    suspend: ['([', '])'],
    subgraph: ['[/', '/]'],
  }
  return shapes[type] ?? ['[', ']']
}

function autoLayout(def: PipelineDefinition): PipelineLayout {
  // Simple top-down layout: BFS from entry, each level gets Y += 120
  const nodes: Record<string, { x: number; y: number }> = {}
  const adj = new Map<string, string[]>()

  for (const edge of def.edges) {
    const targets = edge.type === 'conditional'
      ? Object.values(edge.branches)
      : [edge.type === 'sequential' || edge.type === 'error' ? edge.targetNodeId : '']
    const existing = adj.get(edge.sourceNodeId) ?? []
    existing.push(...targets.filter(Boolean))
    adj.set(edge.sourceNodeId, existing)
  }

  const visited = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: def.entryNodeId, depth: 0 }]
  const depthCounts = new Map<number, number>()

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const xIndex = depthCounts.get(depth) ?? 0
    depthCounts.set(depth, xIndex + 1)

    nodes[id] = { x: xIndex * 250, y: depth * 120 }

    for (const next of adj.get(id) ?? []) {
      if (!visited.has(next)) queue.push({ id: next, depth: depth + 1 })
    }
  }

  // Place any unvisited nodes at the bottom
  let unvisitedX = 0
  const maxDepth = Math.max(...[...depthCounts.keys()], 0) + 1
  for (const node of def.nodes) {
    if (!visited.has(node.id)) {
      nodes[node.id] = { x: unvisitedX * 250, y: maxDepth * 120 }
      unvisitedX++
    }
  }

  return { nodes }
}
```

---

### F9: Pipeline Analytics (P2, 6h)

**Owner:** `@dzipagent/agent/src/pipeline/` (collector), `@dzipagent/server` (storage)

#### Types

```typescript
// @dzipagent/core/src/pipeline/pipeline-analytics.ts

/**
 * Per-node execution metrics for a single pipeline run.
 */
export interface NodeMetrics {
  nodeId: string
  nodeName: string
  nodeType: string
  /** Execution duration in ms. */
  durationMs: number
  /** Number of retries before success/failure. */
  retries: number
  /** LLM cost for this node (cents). */
  costCents: number
  /** Token usage for this node. */
  tokens: { input: number; output: number }
  /** Final status. */
  status: 'completed' | 'skipped' | 'failed' | 'timeout'
  /** Error message if failed. */
  error?: string
  /** For loop nodes: iteration metrics. */
  loopMetrics?: {
    iterationCount: number
    avgIterationMs: number
    converged: boolean
  }
}

/**
 * Pipeline-level execution metrics for a single run.
 */
export interface PipelineMetrics {
  pipelineRunId: string
  pipelineId: string
  pipelineVersion: string
  /** Total execution duration. */
  totalDurationMs: number
  /** Total LLM cost. */
  totalCostCents: number
  /** Total token usage. */
  totalTokens: { input: number; output: number }
  /** Overall status. */
  status: 'completed' | 'failed' | 'suspended' | 'cancelled'
  /** Per-node metrics. */
  nodeMetrics: NodeMetrics[]
  /** Identified bottleneck (longest node). */
  bottleneckNodeId: string
  /** Nodes that could potentially run in parallel but don't. */
  parallelizationOpportunities: Array<{
    nodeIds: string[]
    potentialSavingsMs: number
  }>
  /** Timestamp. */
  recordedAt: string
}

/**
 * Historical analytics across multiple runs of the same pipeline.
 */
export interface PipelineHistoricalAnalytics {
  pipelineId: string
  /** Number of runs analyzed. */
  runCount: number
  /** Average total duration across runs. */
  avgDurationMs: number
  /** P95 duration. */
  p95DurationMs: number
  /** Average total cost. */
  avgCostCents: number
  /** Success rate (0-1). */
  successRate: number
  /** Per-node historical stats. */
  nodeStats: Record<string, {
    avgDurationMs: number
    p95DurationMs: number
    avgCostCents: number
    successRate: number
    avgRetries: number
  }>
  /** Optimization suggestions. */
  suggestions: AnalyticsSuggestion[]
}

export interface AnalyticsSuggestion {
  type: 'parallelize' | 'cache' | 'reduce-retries' | 'increase-timeout' | 'reduce-loop-iterations'
  nodeIds: string[]
  description: string
  estimatedSavingsMs?: number
  estimatedSavingsCents?: number
}
```

#### Analytics Collector

```typescript
// @dzipagent/agent/src/pipeline/pipeline-analytics-collector.ts

import type { DzipEventBus } from '@dzipagent/core'
import type { PipelineMetrics, NodeMetrics } from '@dzipagent/core'
import type { PipelineRunResult } from './pipeline-runtime.js'

/**
 * Collects metrics from pipeline execution events and produces
 * a PipelineMetrics summary.
 *
 * Usage:
 * 1. Create collector before pipeline execution
 * 2. Collector subscribes to DzipEventBus pipeline events
 * 3. After execution, call collector.finalize() to get metrics
 *
 * @example
 * ```ts
 * const collector = new PipelineAnalyticsCollector(eventBus, pipelineRunId)
 * const result = await runtime.execute(def, state)
 * const metrics = collector.finalize(result)
 * ```
 */
export class PipelineAnalyticsCollector {
  private nodeStartTimes = new Map<string, number>()
  private unsubscribers: Array<() => void> = []

  constructor(
    private eventBus: DzipEventBus,
    private pipelineRunId: string,
  ) {
    this.subscribe()
  }

  private subscribe(): void {
    // Subscribe to pipeline events for timing data
    // (Implementation subscribes to pipeline:node_started, pipeline:node_completed, etc.)
  }

  /**
   * Produce final metrics from the pipeline run result.
   */
  finalize(result: PipelineRunResult): PipelineMetrics {
    // Unsubscribe from events
    for (const unsub of this.unsubscribers) unsub()

    const nodeMetrics: NodeMetrics[] = result.nodeResults.map(nr => ({
      nodeId: nr.nodeId,
      nodeName: nr.nodeId, // Resolved from definition
      nodeType: 'unknown', // Resolved from definition
      durationMs: nr.durationMs,
      retries: nr.retries,
      costCents: 0, // Populated from budget tracker
      tokens: { input: 0, output: 0 },
      status: nr.status === 'suspended' ? 'completed' : nr.status,
      error: nr.error,
    }))

    const bottleneck = nodeMetrics
      .filter(n => n.status === 'completed')
      .reduce((max, n) => n.durationMs > max.durationMs ? n : max, nodeMetrics[0]!)

    return {
      pipelineRunId: this.pipelineRunId,
      pipelineId: result.pipelineId,
      pipelineVersion: '', // From definition
      totalDurationMs: result.totalDurationMs,
      totalCostCents: result.totalCostCents ?? 0,
      totalTokens: { input: 0, output: 0 },
      status: result.status,
      nodeMetrics,
      bottleneckNodeId: bottleneck?.nodeId ?? '',
      parallelizationOpportunities: [], // Computed from DAG analysis
      recordedAt: new Date().toISOString(),
    }
  }
}
```

---

## 3. State Machine

### 3.1 Pipeline Execution State Diagram

```
                        +-----------+
                        |  CREATED  |
                        +-----+-----+
                              |
                        execute(def, state)
                              |
                              v
                        +-----------+
                +------>|  RUNNING  |<------+
                |       +-----+-----+       |
                |             |             |
                |    +--------+--------+    |
                |    |        |        |    |
                |    v        v        v    |
           resume() |   +---------+   |    |
                |   |   |SUSPENDED|   | cancel()
                |   |   +----+----+   |    |
                |   |        |        |    |
                |   |   resume()      |    |
                |   |        |        |    |
                |   +--------+--------+    |
                |             |             |
                |    +--------+--------+    |
                |    |                 |    |
                |    v                 v    |
           +-----------+       +-----------+
           | COMPLETED |       |  FAILED   |
           +-----------+       +-----------+
                                     |
                                     |  (if error edge exists)
                                     |
                                     v
                               +-----------+
                               |  RUNNING  | (error recovery path)
                               +-----------+

                        +-----------+
                        | CANCELLED |
                        +-----------+
```

### 3.2 Node Execution Lifecycle

```
                    +----------+
                    | PENDING  |
                    +----+-----+
                         |
                    check dependencies
                    check conditions
                         |
                +--------+--------+
                |                 |
           deps met          deps unmet
           cond true         or cond false
                |                 |
                v                 v
           +----------+    +---------+
           | EXECUTING|    | SKIPPED |
           +----+-----+    +---------+
                |
         +------+------+
         |             |
      success       failure
         |             |
         |      +------+------+
         |      |             |
         |   retries       no retries
         |   remaining     (or max reached)
         |      |             |
         |      v             v
         |  +----------+  +--------+
         |  | RETRYING |  | FAILED |
         |  +----+-----+  +--------+
         |       |
         |  (back to EXECUTING)
         |
         v
    +-----------+
    | COMPLETED |
    +-----------+
         |
    checkpoint (if configured)
```

### 3.3 Checkpoint and Recovery Flow

```
  Normal execution:

  Node A completes
       |
       v
  Save checkpoint (version N)
       |
       v
  Node B starts
       |
       v
  [CRASH / DEPLOY]

  Recovery:

  Load checkpoint (version N)
       |
       v
  Restore state + completedNodes
       |
       v
  Skip Node A (already in completedNodes)
       |
       v
  Execute Node B (first non-completed node)
       |
       v
  Continue normal execution

  Suspend/Resume:

  Gate node reached
       |
       v
  Save checkpoint with suspendedAtNodeId
       |
       v
  Return { status: 'suspended' }
       |
       v
  [External signal: resume(runId, payload)]
       |
       v
  Load checkpoint
       |
       v
  Merge resumePayload into state
       |
       v
  Mark gate node as completed
       |
       v
  Execute next node after gate
```

---

## 4. Data Models

### 4.1 PipelineDefinition JSON Schema (Summary)

The full TypeScript types were defined in F1. Here is the JSON Schema equivalent for validation and documentation.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forgeagent.dev/schemas/pipeline-definition/v1",
  "title": "PipelineDefinition",
  "type": "object",
  "required": ["id", "version", "name", "entryNodeId", "nodes", "edges"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "author": { "type": "string" },
    "entryNodeId": { "type": "string" },
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "name", "type"],
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "type": {
            "enum": ["agent", "tool", "transform", "gate", "fork", "join", "loop", "suspend", "subgraph"]
          }
        },
        "discriminator": { "propertyName": "type" }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "sourceNodeId"],
        "properties": {
          "type": { "enum": ["sequential", "conditional", "error"] },
          "sourceNodeId": { "type": "string" }
        },
        "discriminator": { "propertyName": "type" }
      }
    },
    "defaultTimeoutMs": { "type": "number", "minimum": 0 },
    "defaultMaxRetries": { "type": "integer", "minimum": 0 },
    "budgetLimitCents": { "type": "number", "minimum": 0 },
    "tokenLimit": { "type": "integer", "minimum": 0 },
    "checkpointStrategy": {
      "enum": ["every-node", "on-suspend", "every-n", "manual"]
    },
    "checkpointIntervalN": { "type": "integer", "minimum": 1 },
    "metadata": { "type": "object" }
  }
}
```

### 4.2 ExecutionState for Persistence

See F3 `PipelineCheckpoint` type. The Postgres table schema:

```sql
CREATE TABLE pipeline_checkpoints (
  pipeline_run_id  TEXT        NOT NULL,
  version          INTEGER     NOT NULL,
  pipeline_id      TEXT        NOT NULL,
  pipeline_version TEXT        NOT NULL,
  state            JSONB       NOT NULL,
  completed_node_ids TEXT[]    NOT NULL DEFAULT '{}',
  suspended_at_node_id TEXT,
  suspend_reason   TEXT,
  node_results     JSONB       NOT NULL DEFAULT '[]',
  budget_state     JSONB,
  schema_version   INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (pipeline_run_id, version)
);

CREATE INDEX idx_pipeline_checkpoint_run
  ON pipeline_checkpoints (pipeline_run_id);

CREATE INDEX idx_pipeline_checkpoint_created
  ON pipeline_checkpoints (created_at);
```

### 4.3 Pipeline Registry Table

```sql
CREATE TABLE pipeline_definitions (
  pipeline_id   TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  description   TEXT,
  tags          TEXT[]      NOT NULL DEFAULT '{}',
  author        TEXT,
  definition    JSONB       NOT NULL,
  node_count    INTEGER     NOT NULL,
  execution_count INTEGER   NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (pipeline_id, version)
);

CREATE INDEX idx_pipeline_def_tags
  ON pipeline_definitions USING GIN (tags);

CREATE INDEX idx_pipeline_def_search
  ON pipeline_definitions USING GIN (to_tsvector('english', name || ' ' || COALESCE(description, '')));
```

### 4.4 Pipeline Analytics Table

```sql
CREATE TABLE pipeline_metrics (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id  TEXT        NOT NULL,
  pipeline_id      TEXT        NOT NULL,
  pipeline_version TEXT        NOT NULL,
  status           TEXT        NOT NULL,
  total_duration_ms INTEGER   NOT NULL,
  total_cost_cents  NUMERIC(10, 4) NOT NULL DEFAULT 0,
  total_input_tokens INTEGER  NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  node_metrics     JSONB       NOT NULL DEFAULT '[]',
  bottleneck_node_id TEXT,
  suggestions      JSONB       NOT NULL DEFAULT '[]',
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipeline_metrics_pipeline
  ON pipeline_metrics (pipeline_id);

CREATE INDEX idx_pipeline_metrics_recorded
  ON pipeline_metrics (recorded_at);
```

---

## 5. File Structure

### 5.1 New Files in `@dzipagent/core`

```
packages/forgeagent-core/src/pipeline/
  pipeline-definition.ts       — PipelineDefinition, PipelineNode, PipelineEdge types (F1)
  pipeline-checkpoint-store.ts — PipelineCheckpointStore interface (F3)
  pipeline-registry.ts         — PipelineRegistry interface (F6)
  pipeline-analytics.ts        — PipelineMetrics, NodeMetrics types (F9)
  pipeline-visual.ts           — FlowGraph, PipelineLayout types (F8)
  index.ts                     — Re-exports
```

### 5.2 New Files in `@dzipagent/agent`

```
packages/forgeagent-agent/src/pipeline/
  pipeline-runtime.ts              — PipelineRuntime class (F2)
  pipeline-validator.ts            — validatePipeline() (F1)
  execution-state.ts               — ExecutionState, serialize/deserialize (F3)
  in-memory-checkpoint-store.ts    — InMemoryPipelineCheckpointStore (F3)
  loop-executor.ts                 — executeLoop() (F4)
  loop-predicates.ts               — Built-in loop predicates (F4)
  subgraph-executor.ts             — executeSubGraph() (F5)
  pipeline-templates.ts            — Pre-built pipeline templates (F7)
  pipeline-visual-converter.ts     — pipelineToFlowGraph(), pipelineToMermaid() (F8)
  pipeline-analytics-collector.ts  — PipelineAnalyticsCollector (F9)
  index.ts                         — Re-exports
```

### 5.3 Modified Files

```
packages/forgeagent-agent/src/workflow/workflow-builder.ts
  — Add .toPipelineDefinition() method to WorkflowBuilder
  — CompiledWorkflow gains .toPipelineDefinition() and .runOnRuntime() methods
  — Existing .build() and .run() APIs remain unchanged (backward compatible)

packages/forgeagent-codegen/src/pipeline/gen-pipeline-builder.ts
  — Add .toPipelineDefinition() method to GenPipelineBuilder
  — Existing .getPhases() API remains unchanged

packages/forgeagent-core/src/events/event-types.ts
  — Add pipeline runtime events to DzipEvent union

packages/forgeagent-core/src/index.ts
  — Re-export pipeline types

packages/forgeagent-agent/src/index.ts
  — Re-export pipeline runtime, templates, validator
```

### 5.4 New Files in `@dzipagent/server`

```
packages/forgeagent-server/src/persistence/
  postgres-pipeline-checkpoint-store.ts — PostgresPipelineCheckpointStore (F3)

packages/forgeagent-server/src/pipeline/
  pipeline-registry-store.ts            — PostgresPipelineRegistry (F6)
  pipeline-metrics-store.ts             — PostgresPipelineMetricsStore (F9)

packages/forgeagent-server/src/routes/
  pipeline-routes.ts                    — REST API for pipeline CRUD, execution, resume
```

### 5.5 Consolidation Strategy

The existing `PipelineExecutor` in `@dzipagent/codegen` is NOT removed. It continues to work for codegen consumers who depend on its API. Instead:

1. `GenPipelineBuilder` gains `.toPipelineDefinition()` for new consumers
2. `PipelineExecutor` is marked as `@deprecated` with a migration note pointing to `PipelineRuntime`
3. A future major version (v0.2.0) removes `PipelineExecutor` after migration

The existing `CompiledWorkflow` in `@dzipagent/agent` similarly gains `.toPipelineDefinition()` without breaking existing `.run()` consumers.

---

## 6. Testing Strategy

### 6.1 DAG Execution Correctness (Unit, `@dzipagent/agent`)

```
pipeline-runtime.test.ts
  - executes a linear 3-node pipeline in correct order
  - executes fork/join with parallel branches
  - handles conditional edges (routes to correct branch)
  - handles error edges (routes to error handler on failure)
  - skips nodes with unmet dependencies
  - respects node timeouts (times out after configured ms)
  - retries failed nodes up to maxRetries
  - applies exponential backoff on retries
  - emits correct events for each node transition
  - rejects pipelines that fail validation
  - cancels via AbortController
  - threads state correctly between nodes

pipeline-validator.test.ts
  - accepts valid linear pipeline
  - accepts valid pipeline with fork/join
  - rejects pipeline with missing entry node
  - rejects pipeline with duplicate node IDs
  - rejects pipeline with dangling edges
  - rejects pipeline with unbounded cycle
  - accepts pipeline with bounded loop (LoopNode)
  - warns on unreachable nodes
  - warns on high maxIterations
  - warns on missing timeouts for agent nodes
  - validates fork/join pairing
  - validates loop body node references
```

### 6.2 Persistence and Recovery (Integration, `@dzipagent/agent`)

```
pipeline-persistence.test.ts
  - checkpoints state after each node (every-node strategy)
  - checkpoints only on suspend (on-suspend strategy)
  - resumes from checkpoint with correct state
  - resumes from checkpoint with correct completedNodes (skips completed)
  - merges resume payload into state
  - handles checkpoint version incrementing
  - prunes old checkpoints
  - recovers from crash mid-node (resumes at failed node, not next)
  - suspend node produces recoverable checkpoint
  - resume after suspend continues at correct next node
```

### 6.3 Loop Termination (Unit, `@dzipagent/agent`)

```
loop-executor.test.ts
  - terminates when condition becomes false
  - terminates at maxIterations
  - terminates when loop budget exceeded
  - accumulates state across iterations
  - emits loop_iteration events with correct counts
  - fails if body node fails
  - handles cancellation mid-loop
  - built-in predicate: untilTruthy
  - built-in predicate: untilAboveThreshold
  - built-in predicate: untilNoErrors
  - built-in predicate: untilConverged (epsilon check)
  - reports correct LoopMetrics (convergence, iteration count)
  - marks as failed when failOnMaxIterations is true and max reached
  - marks as completed when failOnMaxIterations is false and max reached
```

### 6.4 Sub-Graph Composition (Integration, `@dzipagent/agent`)

```
subgraph-executor.test.ts
  - resolves child pipeline from resolver
  - maps parent state to child via inputMapping
  - maps child output back to parent via outputMapping
  - child pipeline executes fully before parent continues
  - child inherits parent budget when budgetAllocation is 'inherit'
  - child gets fixed budget when budgetAllocation is a number
  - parent suspends when child suspends
  - parent fails when child fails
  - handles missing child pipeline (throws descriptive error)
  - handles empty input/output mappings
```

### 6.5 Builder Compilation (Unit)

```
workflow-builder-compile.test.ts  (@dzipagent/agent)
  - .toPipelineDefinition() produces valid PipelineDefinition
  - then() becomes sequential edge
  - parallel() becomes fork/join pair
  - branch() becomes conditional edge
  - suspend() becomes suspend node
  - round-trip: build() then toPipelineDefinition() produces equivalent execution

gen-pipeline-builder-compile.test.ts  (@dzipagent/codegen)
  - .toPipelineDefinition() produces valid PipelineDefinition
  - generation phases become agent nodes
  - validation phases become agent nodes with quality gate
  - fix phases become loop nodes
  - review phases become gate nodes
  - subagent phases become agent nodes with sub-agent config
```

### 6.6 Pipeline Templates (Unit, `@dzipagent/agent`)

```
pipeline-templates.test.ts
  - featureGenerationPipeline() passes validation
  - codeReviewPipeline() passes validation
  - migrationPipeline() passes validation
  - ragPipeline() passes validation
  - template parameters override defaults
  - featureGenerationPipeline() without approval skips gate node
  - all templates have unique node IDs
  - all templates have correct entry node
```

### 6.7 Visual Conversion (Unit, `@dzipagent/agent`)

```
pipeline-visual-converter.test.ts
  - pipelineToFlowGraph() produces correct node count
  - pipelineToFlowGraph() produces correct edge count
  - pipelineToFlowGraph() uses layout from metadata when available
  - pipelineToFlowGraph() auto-layouts when no metadata
  - flowGraphToLayout() extracts positions correctly
  - round-trip: layout -> metadata -> layout preserves positions
  - pipelineToMermaid() produces valid Mermaid syntax
  - conditional edges produce labeled Mermaid arrows
  - error edges produce dotted Mermaid arrows
```

---

## 7. Implementation Estimates

| Feature | Priority | Hours | Files | ~LOC | Depends On |
|---------|----------|-------|-------|------|------------|
| F1: Pipeline Definition Protocol | P1 | 8 | 3 | 450 | -- |
| F2: Unified Execution Engine | P1 | 12 | 2 | 550 | F1 |
| F3: Workflow Persistence | P1 | 8 | 4 | 350 | F1, F2 |
| F4: Conditional Loops | P1 | 4 | 2 | 250 | F1, F2 |
| F5: Sub-Graph Composition | P2 | 8 | 2 | 200 | F1, F2, F6 |
| F6: Pipeline Registry | P2 | 8 | 3 | 300 | F1 |
| F7: Pipeline Templates | P1 | 4 | 1 | 300 | F1 |
| F8: Visual Editor Data Model | P3 | 8 | 2 | 350 | F1 |
| F9: Pipeline Analytics | P2 | 6 | 3 | 300 | F1, F2 |
| **Builder migration** (.toPipelineDefinition) | P1 | 4 | 2 | 150 | F1 |
| **Tests** | P1 | 12 | 8 | 800 | All |
| **Total** | | **82** | **32** | **4,000** | |

---

## 8. Migration Path

### Phase 1 (Weeks 1-2): Foundation

1. Add `PipelineDefinition` types to `@dzipagent/core`
2. Implement `PipelineRuntime` in `@dzipagent/agent`
3. Implement `InMemoryPipelineCheckpointStore`
4. Implement pipeline templates
5. Add `.toPipelineDefinition()` to `WorkflowBuilder`

### Phase 2 (Weeks 3-4): Persistence and Registry

1. Implement `PostgresPipelineCheckpointStore` in `@dzipagent/server`
2. Implement `PipelineRegistry` interface and Postgres backend
3. Add pipeline REST routes to server
4. Add `.toPipelineDefinition()` to `GenPipelineBuilder`

### Phase 3 (Weeks 5-6): Advanced Features

1. Implement sub-graph composition
2. Implement pipeline analytics
3. Implement visual editor data model
4. Deprecate `PipelineExecutor` with migration docs

### Backward Compatibility Guarantees

- `GenPipelineBuilder.getPhases()` continues to work unchanged
- `WorkflowBuilder.build().run()` continues to work unchanged
- `PipelineExecutor.execute()` continues to work (deprecated, not removed)
- All new functionality is additive (new methods, new types)
- No existing imports break
- No existing tests break

---

## 9. Open Questions

1. **LangGraph compilation**: Should `PipelineRuntime` optionally compile to a LangGraph `StateGraph` for interop, or should it be a standalone engine? The current plan uses a standalone engine. LangGraph compilation could be a future adapter.

2. **Distributed execution**: Should fork/join support distributing branches across worker processes (via BullMQ or similar)? Current plan is in-process only. Distributed execution would be a `@dzipagent/server` concern.

3. **Pipeline versioning semantics**: Should saving a pipeline with the same version overwrite or reject? Current plan: reject (immutable versions). Use a new version for changes.

4. **Checkpoint storage size**: For large pipeline states (e.g., with VFS snapshots), checkpoint size could be significant. Should we support external blob storage for large state fields?

5. **Event ordering guarantees**: When fork branches emit events concurrently, should the event bus provide ordering guarantees? Current plan: no ordering guarantees for parallel events.
