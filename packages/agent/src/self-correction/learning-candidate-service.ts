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
  /**
   * Whether the promoted lesson was written to a durable store.
   *
   * `false` with `success: true` means the promotion exists in memory only,
   * because RecoveryFeedback has no store wired — the lesson is gone when the
   * process exits. An operator who promotes a lesson reasonably expects it to
   * survive, so a UI must not render this the same as a durable promotion.
   */
  persisted?: boolean
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

  /**
   * List all pending candidates awaiting operator review.
   */
  listPending(tenantId = 'default'): LearningCandidate[] {
    return this.feedback.listPendingCandidates(tenantId)
  }

  /**
   * Get a single candidate by ID (any status).
   * Returns undefined if not found.
   */
  get(candidateId: string, tenantId = 'default'): LearningCandidate | undefined {
    return this.feedback.getCandidate(candidateId, tenantId)
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

    const { accepted, persisted } = await this.feedback.promoteCandidateDetailed(
      candidateId,
      reviewedBy,
      tenantId,
    )
    return accepted
      ? { success: true, candidateId, persisted }
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
    return this.feedback.recordValidationOutcome(outcome, tenantId)
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

    const ok = this.feedback.rejectCandidate(candidateId, reviewedBy, tenantId)
    return ok
      ? { success: true, candidateId }
      : { success: false, candidateId, reason: 'Rejection failed' }
  }
}
