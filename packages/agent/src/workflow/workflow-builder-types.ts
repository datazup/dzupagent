/**
 * Public configuration types for the workflow builder.
 * Separated to break the import cycle between workflow-builder.ts and
 * workflow-compiler.ts.
 */
import type { WorkflowStep } from './workflow-types.js'

export interface WorkflowConfig {
  id: string
  description?: string
}

/**
 * Error handler registered via {@link WorkflowBuilder.onError}.
 *
 * On a matching predicate, the registered `recoverySteps` are executed in
 * sequence with the current state augmented with `error` (an `Error`-shaped
 * record). The combined output is merged back into the workflow state and
 * the workflow continues from the next node as if the failing step had
 * succeeded.
 */
export interface WorkflowErrorHandler {
  /** Predicate selecting the errors this handler should recover. */
  predicate: (err: Error) => boolean
  /** Recovery sub-graph executed on a matching error. */
  recoverySteps: WorkflowStep[]
}
