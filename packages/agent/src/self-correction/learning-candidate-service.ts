/**
 * LearningCandidateService — operator review surface for LearningCandidates.
 *
 * A pure, framework-agnostic class that wraps RecoveryFeedback and exposes
 * listPending / promote / reject operations. HTTP adapters in consuming apps
 * (e.g. apps/codev-app) can wrap this class without pulling in Express/Hono
 * as a framework dependency.
 *
 * @module self-correction/learning-candidate-service
 */

import type {
  RecoveryFeedback,
  CandidateValidationOutcome,
  ValidationOutcomeResult,
} from './recovery-feedback.js'
import type { LearningCandidate } from './learning-candidate.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteResult {
  success: boolean
  candidateId: string
  /** Reason for failure when success is false. */
  reason?: string
}

export interface RejectResult {
  success: boolean
  candidateId: string
  reason?: string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Operator-facing service for reviewing and actioning LearningCandidates.
 *
 * Wire this into an HTTP layer (REST, tRPC, etc.) in the consuming app.
 * The service itself is framework-free.
 */
export class LearningCandidateService {
  constructor(private readonly feedback: RecoveryFeedback) {}

  private matchesTenant(candidate: LearningCandidate, tenantId: string): boolean {
    return (candidate.lesson.tenantId ?? 'default') === tenantId
  }

  /**
   * List all pending candidates awaiting operator review.
   */
  listPending(tenantId = 'default'): LearningCandidate[] {
    return this.feedback
      .listPendingCandidates()
      .filter((candidate) => this.matchesTenant(candidate, tenantId))
  }

  /**
   * Get a single candidate by ID (any status).
   * Returns undefined if not found.
   */
  get(candidateId: string, tenantId = 'default'): LearningCandidate | undefined {
    const candidate = this.feedback.getCandidate(candidateId)
    if (!candidate || !this.matchesTenant(candidate, tenantId)) return undefined
    return candidate
  }

  /**
   * Promote a pending candidate to durable memory.
   */
  async promote(
    candidateId: string,
    reviewedBy = 'operator',
    tenantId = 'default',
  ): Promise<PromoteResult> {
    const candidate = this.get(candidateId, tenantId)
    if (!candidate) {
      return { success: false, candidateId, reason: 'Candidate not found' }
    }
    if (candidate.status !== 'pending') {
      return { success: false, candidateId, reason: `Candidate already ${candidate.status}` }
    }

    const ok = await this.feedback.promoteCandidate(candidateId, reviewedBy)
    return ok
      ? { success: true, candidateId }
      : { success: false, candidateId, reason: 'Promotion failed' }
  }

  /**
   * Record a validation outcome that may trigger auto-promotion or
   * auto-rejection per the candidate's promotion policy. See
   * {@link RecoveryFeedback.recordValidationOutcome}.
   */
  recordValidation(
    outcome: CandidateValidationOutcome,
    tenantId = 'default',
  ): Promise<ValidationOutcomeResult> {
    const candidate = this.feedback.getCandidate(outcome.candidateId)
    if (!candidate || !this.matchesTenant(candidate, tenantId)) {
      return Promise.resolve({
        candidateId: outcome.candidateId,
        status: 'pending',
        autoActioned: false,
        successRunCount: 0,
        failureRunCount: 0,
        avgValidationScore: 0,
      })
    }
    return this.feedback.recordValidationOutcome(outcome)
  }

  /**
   * Reject a pending candidate.
   */
  reject(candidateId: string, reviewedBy = 'operator', tenantId = 'default'): RejectResult {
    const candidate = this.get(candidateId, tenantId)
    if (!candidate) {
      return { success: false, candidateId, reason: 'Candidate not found' }
    }
    if (candidate.status !== 'pending') {
      return { success: false, candidateId, reason: `Candidate already ${candidate.status}` }
    }

    const ok = this.feedback.rejectCandidate(candidateId, reviewedBy)
    return ok
      ? { success: true, candidateId }
      : { success: false, candidateId, reason: 'Rejection failed' }
  }
}
