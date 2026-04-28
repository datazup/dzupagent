/**
 * Stage 4 lowerer — pipeline-loop target.
 *
 * Receives a pre-validated, router-dispatched AST that MAY contain `for_each`
 * nodes (the router guarantees FOR_EACH bit is set). Emits a `PipelineDefinition`
 * artifact and an array of non-fatal warnings.
 *
 * Delegates all node-level work to `lowerNodeToPipeline` from `_shared.ts`
 * with `allowForEach: true`, then wraps the flat node/edge lists in a
 * `PipelineDefinition`.
 *
 * @module lower/lower-pipeline-loop
 */

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import type { PipelineDefinition } from '@dzupagent/core'

import { lowerNodeToPipeline } from './_shared.js'
import type { LoweringMode, LowerPipelineContext } from './_shared.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LowerPipelineLoopInput {
  ast: FlowNode
  resolved: Map<string, ResolvedTool>
  resolvedPersonas: Map<string, string>
  /**
   * Optional ID injected for snapshot-stable tests.
   * Forwarded to the shared lowerer as `ctx.idGen`.
   */
  idGen?: () => string
  /**
   * Human-readable name for the emitted pipeline.
   * Defaults to `"flow-pipeline"` when not provided.
   */
  name?: string
  /**
   * Pipeline version string.
   * Defaults to `"0.0.0"` when not provided.
   */
  version?: string
  /**
   * Pipeline ID.
   * When not provided, a fresh ID is generated via `idGen` (or `crypto.randomUUID`).
   */
  id?: string
  /**
   * Defaults to executable lowering. Diagnostic lowering may emit unresolved
   * action stubs with warnings for authoring tools and tests.
   */
  mode?: LoweringMode
}

export function lowerPipelineLoop(input: LowerPipelineLoopInput): {
  artifact: PipelineDefinition
  warnings: string[]
} {
  const ctx: LowerPipelineContext = {
    resolved: input.resolved,
    resolvedPersonas: input.resolvedPersonas,
    mode: input.mode ?? 'executable',
    allowForEach: true,
    idGen: input.idGen,
  }

  const result = lowerNodeToPipeline(input.ast, ctx, 'root')

  const entryNode = result.nodes[0]
  if (entryNode === undefined) {
    throw new Error(
      'lowerPipelineLoop: no nodes produced from AST — cannot emit an empty PipelineDefinition',
    )
  }

  const pipelineId =
    input.id !== undefined
      ? input.id
      : input.idGen !== undefined
        ? input.idGen()
        : crypto.randomUUID()

  const artifact: PipelineDefinition = {
    id: pipelineId,
    name: input.name ?? 'flow-pipeline',
    version: input.version ?? '0.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: entryNode.id,
    nodes: result.nodes,
    edges: result.edges,
  }

  return { artifact, warnings: result.warnings }
}
