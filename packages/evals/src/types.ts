/**
 * Core types for the ForgeAgent evaluation framework.
 */

/** Input to an evaluation scorer */
export interface EvalInput {
  /** The prompt/task given to the agent */
  input: string
  /** The agent's response */
  output: string
  /** Expected/golden answer (optional) */
  reference?: string
  /** Additional context */
  context?: string
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>
}

/** Result of a single scorer evaluation */
export interface EvalResult {
  /** Which scorer produced this result */
  scorerId: string
  /** Normalized score (0-1) */
  score: number
  /** Whether the score meets the scorer's threshold */
  pass: boolean
  /** Human-readable explanation */
  reasoning?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/** A scorer that evaluates agent outputs */
export interface Scorer {
  id: string
  type: 'llm' | 'deterministic' | 'composite'
  /** Score threshold for pass/fail (default: 0.7) */
  threshold: number
  /** Evaluate an input and return a result */
  evaluate(input: EvalInput): Promise<EvalResult>
}

/** Stored evaluation record (for persistence) */
export interface EvalRecord {
  input: EvalInput
  results: EvalResult[]
  timestamp: Date
}

/** Store interface for persisting evaluation results */
export interface EvalResultStore {
  save(record: EvalRecord): Promise<void>
  list(filter?: { scorerId?: string; limit?: number }): Promise<EvalRecord[]>
}
