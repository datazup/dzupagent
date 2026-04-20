/**
 * Stage 4 lowerer — pipeline-flat target.
 *
 * Delegates node-level work to `lowerNodeToPipeline` from `_shared.ts` with
 * `allowForEach: false` (router contract: for_each nodes must never reach this
 * target — the router escalates them to the pipeline-loop lowerer instead).
 *
 * The entry node is the first node produced by the top-level lowering. Callers
 * receive a complete `PipelineDefinition` with all nodes and edges populated.
 *
 * Router contract violations (for_each in AST) propagate as developer errors —
 * they are unreachable in correct deployments and should never be swallowed.
 *
 * @module lower/lower-pipeline-flat
 */

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import type { PipelineDefinition } from '@dzupagent/core'

import { lowerNodeToPipeline } from './_shared.js'
import type { LowerPipelineContext } from './_shared.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LowerPipelineFlatInput {
  ast: FlowNode
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  /**
   * Human-readable name for the emitted pipeline.
   * Defaults to `"flow-pipeline"` when not provided.
   */
  name?: string
  /**
   * Semantic version to stamp on the emitted PipelineDefinition.
   * Defaults to `"0.1.0"` when not provided.
   */
  version?: string
  /**
   * Deterministic ID generator injected by tests so snapshots are stable.
   * Defaults to `crypto.randomUUID` when not provided.
   * Do NOT change the public signature — this is an internal hook.
   *
   * @internal
   */
  _idGen?: () => string
}

export function lowerPipelineFlat(input: LowerPipelineFlatInput): {
  artifact: PipelineDefinition
  warnings: string[]
} {
  const ctx: LowerPipelineContext = {
    resolved: input.resolved,
    resolvedPersonas: input.resolvedPersonas,
    allowForEach: false,
    idGen: input._idGen,
  }

  // Lower the entire AST — for_each throws if encountered (router-contract
  // violation; let it propagate unmodified).
  const result = lowerNodeToPipeline(input.ast, ctx, 'root')

  const firstNode = result.nodes[0]

  if (firstNode === undefined) {
    throw new Error(
      'lowerPipelineFlat: no nodes produced from AST — cannot emit an empty PipelineDefinition',
    )
  }

  const artifact: PipelineDefinition = {
    id: ctx.idGen !== undefined ? ctx.idGen() : crypto.randomUUID(),
    name: input.name ?? 'flow-pipeline',
    version: input.version ?? '0.1.0',
    schemaVersion: '1.0.0',
    entryNodeId: firstNode.id,
    nodes: result.nodes,
    edges: result.edges,
  }

  return { artifact, warnings: result.warnings }
}
