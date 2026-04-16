/**
 * Types for the general-purpose workflow engine.
 */

/** A single step in a workflow */
export interface WorkflowStep<TInput = unknown, TOutput = unknown> {
  id: string
  description?: string
  execute: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>
}

/** Context passed to each workflow step */
export interface WorkflowContext {
  workflowId: string
  /** Accumulated state from previous steps */
  state: Record<string, unknown>
  /** Signal for cancellation */
  signal?: AbortSignal
}

/** Internal node representation in the workflow graph */
export type WorkflowNode =
  | { type: 'step'; step: WorkflowStep }
  | { type: 'parallel'; steps: WorkflowStep[]; mergeStrategy: MergeStrategy }
  | { type: 'branch'; condition: (state: Record<string, unknown>) => string; branches: Record<string, WorkflowStep[]> }
  | { type: 'suspend'; reason: string }

/** Strategy for merging parallel step results */
export type MergeStrategy = 'merge-objects' | 'concat-arrays' | 'last-wins'

/** Events emitted during workflow execution */
export type WorkflowEvent =
  | { type: 'step:started'; stepId: string }
  | { type: 'step:completed'; stepId: string; durationMs: number }
  | { type: 'step:failed'; stepId: string; error: string }
  | { type: 'parallel:started'; stepIds: string[] }
  | { type: 'parallel:completed'; stepIds: string[]; durationMs: number }
  | { type: 'branch:evaluated'; condition: string; selected: string }
  | { type: 'suspended'; reason: string }
  | { type: 'step:skipped'; stepId: string; reason: string }
  | { type: 'step:retrying'; stepId: string; attempt: number; maxAttempts: number; backoffMs: number }
  | { type: 'workflow:completed'; durationMs: number }
  | { type: 'workflow:failed'; error: string }
