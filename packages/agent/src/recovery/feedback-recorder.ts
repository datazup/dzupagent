/**
 * Best-effort persistence of recovery outcomes as lessons in the
 * {@link RecoveryFeedback} store. Used by {@link RecoveryCopilot}
 * to feed historical signal back into strategy selection.
 *
 * @module recovery/feedback-recorder
 */

import type {
  RecoveryFeedback,
  RecoveryLesson,
} from '../self-correction/recovery-feedback.js'
import type { FailureContext, RecoveryPlan } from './recovery-types.js'

/**
 * Record a recovery outcome as a {@link RecoveryLesson}. Failures in
 * persistence are swallowed — lesson recording is never allowed to
 * fail the recovery flow itself.
 */
export async function recordRecoveryFeedback(opts: {
  feedback: RecoveryFeedback
  analysis: { type: string; fingerprint: string }
  failureContext: FailureContext
  plan: RecoveryPlan
  success: boolean
  summary?: string
}): Promise<void> {
  const { feedback, analysis, failureContext, plan, success, summary } = opts

  const lesson: RecoveryLesson = {
    id: feedback.generateLessonId(),
    errorType: analysis.type as RecoveryLesson['errorType'],
    errorFingerprint: analysis.fingerprint,
    nodeId: failureContext.nodeId ?? '',
    strategy: plan.selectedStrategy?.name ?? 'none',
    outcome: success ? 'success' : 'failure',
    summary: summary ?? (success ? 'Recovery succeeded' : 'Recovery failed'),
    timestamp: new Date(),
  }

  try {
    const candidateId = await feedback.recordOutcome(lesson)
    // Append a policy_applied audit entry so the decision chain is traceable:
    // plan.id → strategy → candidateId → run → node
    feedback.appendCandidateAuditEntry(candidateId, {
      runId: failureContext.runId,
      nodeId: failureContext.nodeId ?? '',
      event: 'policy_applied',
      actor: 'system',
      detail: `Plan ${plan.id} selected strategy "${plan.selectedStrategy?.name ?? 'none'}" (confidence ${plan.selectedStrategy?.confidence?.toFixed(2) ?? 'n/a'})`,
      timestamp: new Date(),
    })
  } catch {
    // Feedback recording is best-effort — don't fail recovery over it
  }
}
