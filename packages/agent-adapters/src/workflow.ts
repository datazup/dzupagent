/**
 * @dzupagent/agent-adapters/workflow
 *
 * Workflow DSL plane: builder, executor, template resolver, and validator.
 */

export {
  AdapterWorkflowBuilder,
  AdapterWorkflow,
  defineWorkflow,
  typedStep,
} from './workflow/adapter-workflow.js'
export type {
  AdapterWorkflowConfig,
  AdapterStepConfig,
  AdapterWorkflowResult,
  AdapterStepResult,
  AdapterWorkflowEvent,
  BranchCondition,
  LoopConfig,
} from './workflow/adapter-workflow.js'

export { WorkflowStepResolver } from './workflow/template-resolver.js'
export type { TemplateContext, TemplateReference } from './workflow/template-resolver.js'

export { WorkflowValidator } from './workflow/workflow-validator.js'
export type { ValidationError, ValidationResult } from './workflow/workflow-validator.js'
