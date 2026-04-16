/**
 * State contract for textual workflow orchestration.
 * Documentation interfaces only -- not enforced at runtime.
 */

/** Keys the step reads from accumulated state. */
export interface ChainStepInput {
  userMessage: string
  stepIndex: number
  skillId: string
  previousOutputs: Record<string, string>
}

/** Keys the step writes back (merged into state). */
export interface ChainStepOutput {
  [skillId: string]: string
}

/** Full accumulated state after chain completion. */
export interface ChainFinalState extends ChainStepInput {
  previousOutputs: Record<string, string>
  lastOutput?: string
  [key: string]: unknown
}

/**
 * Pure state transform applied between steps.
 * MUST return a new object, not mutate the input.
 */
export type StateTransformer = (state: Record<string, unknown>) => Record<string, unknown>
