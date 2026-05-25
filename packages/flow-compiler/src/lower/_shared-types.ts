/**
 * _shared-types.ts — Public types and handle re-exports for the shared
 * lowering helper.
 *
 * Re-exported via the `_shared.ts` barrel; callers should import from
 * `_shared.ts` to keep the public surface stable.
 *
 * @module lower/_shared-types
 */

import type {
  AgentHandle,
  McpToolHandle,
  SkillHandle,
  WorkflowHandle,
} from '@dzupagent/core/advanced'
import type { ResolvedTool } from '@dzupagent/flow-ast'
import type {
  PipelineEdge,
  PipelineNode,
} from '@dzupagent/core/orchestration'

// Re-export handle types for internal consumers that previously imported
// them from `_shared.ts`. Keeps the public surface of that module stable
// while the canonical definitions live in `@dzupagent/core/advanced`.
export type { AgentHandle, McpToolHandle, SkillHandle, WorkflowHandle }

// ---------------------------------------------------------------------------
// Context and result types
// ---------------------------------------------------------------------------

export type LoweringMode = 'executable' | 'diagnostic'

export interface LowerPipelineContext {
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  /**
   * Executable lowering is fail-closed: unresolved semantic references must not
   * become runtime nodes. Diagnostic lowering keeps best-effort stub emission.
   */
  mode?: LoweringMode
  /**
   * lower-pipeline-flat passes false; lower-pipeline-loop passes true.
   * When false, encountering a for_each node throws a router-contract error.
   */
  allowForEach: boolean
  /**
   * ID generator for fresh node IDs.
   * Defaults to crypto.randomUUID when not provided.
   */
  idGen?: () => string
}

export interface LowerPipelineResult {
  /**
   * Flat list of PipelineNode objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.nodes.
   *
   * Type: PipelineNode[]
   */
  nodes: PipelineNode[]
  /**
   * Flat list of PipelineEdge objects produced by lowering this subtree.
   * Consumers accumulate these into PipelineDefinition.edges.
   */
  edges: PipelineEdge[]
  warnings: string[]
  /**
   * Terminal node IDs that must receive a continuation edge when a sibling
   * node follows this subtree. Most lowerers expose a single tail (the last
   * node in `nodes`), but control-flow that fans out (e.g. a `branch` with
   * both then- and else-paths) exposes one tail per path so the continuation
   * is stitched onto *every* path, not just the last node emitted.
   *
   * When omitted, callers fall back to the last node in `nodes` — preserving
   * the historical single-tail behaviour for simple subtrees.
   */
  tails?: string[]
}
