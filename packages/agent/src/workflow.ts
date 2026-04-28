/**
 * @dzupagent/agent/workflow — workflow and orchestration facade.
 *
 * Use this subpath for workflow builders, orchestration patterns, delegation,
 * routing, topology, and textual skill-chain execution.
 */

export { WorkflowBuilder, CompiledWorkflow, createWorkflow } from './workflow/workflow-builder.js'
export type { WorkflowConfig } from './workflow/workflow-builder.js'
export type {
  WorkflowStep,
  WorkflowContext,
  WorkflowEvent,
  MergeStrategy,
} from './workflow/workflow-types.js'
export * from './orchestration/index.js'
export * from './skill-chain-executor/index.js'

