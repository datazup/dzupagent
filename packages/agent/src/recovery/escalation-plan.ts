/**
 * Builds the canonical "max attempts exceeded" escalation plan used by
 * {@link RecoveryCopilot} when a run has exhausted its recovery budget.
 *
 * @module recovery/escalation-plan
 */

import type { FailureContext, RecoveryPlan } from './recovery-types.js'

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
    strategies: [{
      name: 'human_escalation',
      description: `Max recovery attempts (${maxAttempts}) exceeded — escalating to human operator`,
      confidence: 1.0,
      risk: 'low',
      estimatedSteps: 1,
      actions: [{
        type: 'human_escalation',
        params: {
          reason: `${failureContext.previousAttempts} previous recovery attempts failed`,
          error: failureContext.error,
        },
        description: 'Escalate to human operator for manual intervention',
      }],
    }],
    selectedStrategy: null,
    status: 'failed',
    createdAt: new Date(),
    executionError: 'Max recovery attempts exceeded',
  }
}
