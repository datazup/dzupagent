/**
 * Builds the canonical "max attempts exceeded" escalation plan used by
 * {@link RecoveryCopilot} when a run has exhausted its recovery budget.
 *
 * @module recovery/escalation-plan
 */

import type {
  FailureContext,
  RecoveryPlan,
  RecoveryStrategy,
} from './recovery-types.js'

/** Build the canonical terminal human-escalation strategy. */
export function buildHumanEscalationStrategy(opts: {
  failureContext: FailureContext
  description: string
  reason: string
}): RecoveryStrategy {
  const { failureContext, description, reason } = opts
  return {
    name: 'human_escalation',
    description,
    confidence: 1.0,
    risk: 'low',
    estimatedSteps: 1,
    actions: [{
      type: 'human_escalation',
      params: {
        reason,
        error: failureContext.error,
        type: failureContext.type,
      },
      description: 'Escalate to human operator for manual intervention',
    }],
  }
}

/**
 * Construct an escalation {@link RecoveryPlan} that requests human
 * intervention. Marked `failed` so callers can short-circuit further
 * automated recovery for the run.
 */
export function buildEscalationPlan(opts: {
  id: string
  failureContext: FailureContext
  maxAttempts: number
}): RecoveryPlan {
  const { id, failureContext, maxAttempts } = opts
  return {
    id,
    failureContext,
    strategies: [buildHumanEscalationStrategy({
      failureContext,
      description: `Max recovery attempts (${maxAttempts}) exceeded — escalating to human operator`,
      reason: `${failureContext.previousAttempts} previous recovery attempts failed`,
    })],
    selectedStrategy: null,
    status: 'failed',
    createdAt: new Date(),
    executionError: 'Max recovery attempts exceeded',
  }
}
