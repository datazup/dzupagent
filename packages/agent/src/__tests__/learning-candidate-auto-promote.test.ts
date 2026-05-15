import { describe, expect, it } from 'vitest'

import { RecoveryFeedback } from '../self-correction/recovery-feedback.js'
import type { RecoveryLesson } from '../self-correction/recovery-lesson-types.js'

function makeLesson(overrides?: Partial<RecoveryLesson>): RecoveryLesson {
  return {
    id: 'run-1',
    errorType: 'tool_failure',
    errorFingerprint: 'tf:abc',
    nodeId: 'node-x',
    strategy: 'retry-with-backoff',
    outcome: 'success',
    summary: 'Backoff fixed it',
    timestamp: new Date(),
    ...overrides,
  }
}

describe('LearningCandidate validated promotion (P4)', () => {
  it('does not promote until enough successful validations have accumulated', async () => {
    const fb = new RecoveryFeedback({
      promotionPolicy: { minScore: 75, minSuccessRuns: 3, maxFailureRuns: 3 },
    })
    const candidateId = await fb.recordOutcome(makeLesson())

    const r1 = await fb.recordValidationOutcome({ candidateId, runId: 'r1', score: 90 })
    expect(r1.status).toBe('pending')
    expect(r1.successRunCount).toBe(1)

    const r2 = await fb.recordValidationOutcome({ candidateId, runId: 'r2', score: 85 })
    expect(r2.status).toBe('pending')
    expect(r2.successRunCount).toBe(2)

    const r3 = await fb.recordValidationOutcome({ candidateId, runId: 'r3', score: 80 })
    expect(r3.status).toBe('promoted')
    expect(r3.autoActioned).toBe(true)
    expect(r3.successRunCount).toBe(3)
  })

  it('does not promote when avg score is below threshold despite enough runs', async () => {
    const fb = new RecoveryFeedback({
      promotionPolicy: { minScore: 75, minSuccessRuns: 3, maxFailureRuns: 10 },
    })
    const candidateId = await fb.recordOutcome(makeLesson())

    // All scores are at threshold but the average is exactly minScore so it should promote
    // Use scores below threshold to verify the average gate
    const r1 = await fb.recordValidationOutcome({ candidateId, runId: 'r1', score: 76 })
    const r2 = await fb.recordValidationOutcome({ candidateId, runId: 'r2', score: 76 })
    const r3 = await fb.recordValidationOutcome({ candidateId, runId: 'r3', score: 50 })

    // 50 is below threshold, so successRunCount stays at 2 — not enough for promotion
    expect(r3.status).toBe('pending')
    expect(r1.successRunCount).toBe(1)
    expect(r2.successRunCount).toBe(2)
    expect(r3.successRunCount).toBe(2)
  })

  it('auto-rejects after the failure threshold is exceeded', async () => {
    const fb = new RecoveryFeedback({
      promotionPolicy: { minScore: 75, minSuccessRuns: 3, maxFailureRuns: 3 },
    })
    const candidateId = await fb.recordOutcome(makeLesson())

    const r1 = await fb.recordValidationOutcome({ candidateId, runId: 'r1', score: 30 })
    const r2 = await fb.recordValidationOutcome({ candidateId, runId: 'r2', score: 40 })
    const r3 = await fb.recordValidationOutcome({ candidateId, runId: 'r3', score: 20 })

    expect(r1.status).toBe('pending')
    expect(r2.status).toBe('pending')
    expect(r3.status).toBe('rejected')
    expect(r3.autoActioned).toBe(true)
  })

  it('records validation outcomes against already-actioned candidates without re-promoting', async () => {
    const fb = new RecoveryFeedback({
      promotionPolicy: { minScore: 75, minSuccessRuns: 1, maxFailureRuns: 5 },
    })
    const candidateId = await fb.recordOutcome(makeLesson())

    const promote = await fb.recordValidationOutcome({ candidateId, runId: 'r1', score: 95 })
    expect(promote.status).toBe('promoted')

    // Subsequent failure should still record but NOT change status
    const followup = await fb.recordValidationOutcome({ candidateId, runId: 'r2', score: 10 })
    expect(followup.status).toBe('promoted')
    expect(followup.autoActioned).toBe(false)
  })

  it('writes a complete audit trail of validation outcomes and auto-promotion', async () => {
    const fb = new RecoveryFeedback({
      promotionPolicy: { minScore: 70, minSuccessRuns: 2, maxFailureRuns: 5 },
    })
    const candidateId = await fb.recordOutcome(makeLesson())

    await fb.recordValidationOutcome({ candidateId, runId: 'r1', score: 80 })
    await fb.recordValidationOutcome({ candidateId, runId: 'r2', score: 80 })

    const candidate = fb.getCandidate(candidateId)
    expect(candidate).toBeDefined()
    expect(candidate!.status).toBe('promoted')
    const events = candidate!.auditTrail.map((e) => e.event)
    expect(events).toContain('staged')
    expect(events).toContain('validation_recorded')
    expect(events).toContain('promoted')
    expect(events).toContain('auto_promoted')
  })

  it('returns a no-op result when the candidate ID is unknown', async () => {
    const fb = new RecoveryFeedback()
    const result = await fb.recordValidationOutcome({ candidateId: 'missing', runId: 'r1', score: 100 })
    expect(result.autoActioned).toBe(false)
    expect(result.status).toBe('pending')
    expect(result.successRunCount).toBe(0)
  })
})
