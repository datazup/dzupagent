/**
 * _shared.ts — Shared lowering helper for pipeline lowerers.
 *
 * Both lower-pipeline-flat.ts (allowForEach: false) and
 * lower-pipeline-loop.ts (allowForEach: true) import from here.
 *
 * Maps each FlowNode variant to PipelineNode + PipelineEdge constructs
 * from @dzupagent/core pipeline-definition types.
 *
 * This module is a thin barrel; implementation lives in sibling modules:
 *   - `_shared-types.ts`     context/result types and handle re-exports
 *   - `_shared-handles.ts`   ResolvedTool → handle narrowing helpers
 *   - `_shared-utils.ts`     internal helpers (id gen, edges, child merging)
 *   - `_shared-leaf.ts`      action / for_each / clarification / complete lowerers
 *   - `_shared-composite.ts` sequence/branch/parallel/approval/persona/route +
 *                            top-level dispatcher `lowerNodeToPipeline`
 *
 * Callers continue to import from this barrel — no caller changes needed.
 *
 * @module lower/_shared
 */

// Public types and handle re-exports
export type {
  AgentHandle,
  LoweringMode,
  LowerPipelineContext,
  LowerPipelineResult,
  McpToolHandle,
  SkillHandle,
  WorkflowHandle,
} from './_shared-types.js'

// Handle narrowing helpers
export {
  asAgentHandle,
  asMcpToolHandle,
  asSkillHandle,
  asWorkflowHandle,
} from './_shared-handles.js'

// Edge stitching utility used by top-level lowerers to join skill chains
export { chainEdges } from './_shared-utils.js'

// Top-level dispatcher
export { lowerNodeToPipeline } from './_shared-composite.js'
