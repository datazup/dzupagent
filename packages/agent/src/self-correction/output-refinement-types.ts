/**
 * Public types for the OutputRefinementLoop.
 *
 * @module self-correction/output-refinement-types
 */

/** Supported refinement domains. */
export type RefinementDomain = 'sql' | 'code' | 'analysis' | 'ops' | 'general'

/** Configuration for the output refinement loop. */
export interface RefinementConfig {
  /** Max refinement iterations (default: 2). */
  maxIterations: number
  /** Quality threshold --- stop refining if above this (default: 0.9). */
  qualityThreshold: number
  /** Minimum improvement required to accept refinement (default: 0.05). */
  minImprovement: number
  /** Cost budget for refinements in cents (default: 20). */
  costBudgetCents: number
  /** Domain (auto-detected if not specified). */
  domain?: RefinementDomain
  /**
   * Consecutive iterations with sub-threshold improvement before declaring
   * convergence. Detects diminishing-returns plateau across multiple
   * iterations that each individually clear `minImprovement` but together
   * show stagnation. Default: disabled (0 = no plateau detection).
   */
  convergenceWindow?: number
}

/** A single refinement iteration record. */
export interface RefinementIteration {
  /** 1-based iteration number. */
  iteration: number
  /** Domain used for critique. */
  domain: RefinementDomain
  /** Critique text from the model. */
  critique: string
  /** Refined output produced in this iteration. */
  refinedOutput: string
  /** Quality score of the original/current best output. */
  originalScore: number
  /** Quality score of the refined output. */
  refinedScore: number
  /** Score improvement (refinedScore - originalScore). */
  improvement: number
  /** Whether this refinement was accepted. */
  accepted: boolean
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** Result of the full refinement loop execution. */
export interface RefinementResult {
  /** Best output (original or refined). */
  bestOutput: string
  /** Whether any refinement was accepted. */
  wasRefined: boolean
  /** Quality score of the best output. */
  bestScore: number
  /** Quality score of the original. */
  originalScore: number
  /** Total improvement (bestScore - originalScore). */
  totalImprovement: number
  /** Domain used for critique. */
  domain: RefinementDomain
  /** Refinement history. */
  iterations: RefinementIteration[]
  /** Why refinement stopped. */
  exitReason:
    | 'quality_met'
    | 'max_iterations'
    | 'no_improvement'
    | 'convergence'
    | 'budget_exhausted'
    | 'regression_detected'
    | 'error'
  /** Total duration in milliseconds. */
  totalDurationMs: number
  /** Estimated cost in cents. */
  estimatedCostCents: number
}

/** Scoring function signature. */
export interface ScoreFn {
  (output: string, task: string): Promise<{ score: number; feedback: string }>
}
