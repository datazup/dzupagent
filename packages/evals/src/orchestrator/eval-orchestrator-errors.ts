/**
 * Error types raised by EvalOrchestrator.
 *
 * Extracted from eval-orchestrator.ts in MC-016 to keep the orchestrator
 * file focused on coordination logic.
 */

export class EvalExecutionUnavailableError extends Error {
  readonly code = 'EVAL_EXECUTION_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'EvalExecutionUnavailableError'
  }
}

export class EvalRunInvalidStateError extends Error {
  readonly code = 'INVALID_STATE'

  constructor(message: string) {
    super(message)
    this.name = 'EvalRunInvalidStateError'
  }
}

export class EvalCostExceededError extends Error {
  readonly code = 'EVAL_COST_CAP_EXCEEDED'

  constructor(
    message: string,
    readonly capCents: number,
    readonly observedCents: number,
  ) {
    super(message)
    this.name = 'EvalCostExceededError'
  }
}
