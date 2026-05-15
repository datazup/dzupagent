/**
 * LearningCandidate — reviewable staging layer for recovery lessons.
 *
 * Lessons produced by RecoveryFeedback are staged as LearningCandidates
 * before being promoted to durable memory. Operators can review, approve,
 * or reject candidates via LearningCandidateService before they influence
 * future recovery strategy selection.
 *
 * @module self-correction/learning-candidate
 */

import type { RecoveryLesson } from './recovery-lesson-types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a LearningCandidate. */
export type CandidateStatus = 'pending' | 'promoted' | 'rejected'

/** A single audit entry recording a lifecycle transition. */
export interface AuditEntry {
  /** The candidate this entry belongs to. */
  candidateId: string
  /** Pipeline run ID that produced the lesson. */
  runId: string
  /** Pipeline node where the failure occurred. */
  nodeId: string
  /** The event that occurred. */
  event: 'staged' | 'promoted' | 'rejected' | 'policy_applied' | 'validation_recorded' | 'auto_promoted' | 'auto_rejected'
  /** Whether this was triggered by the system or an operator. */
  actor: 'system' | 'operator'
  /** Human-readable description of what happened. */
  detail: string
  /** When this entry was recorded. */
  timestamp: Date
}

/**
 * Configuration controlling when a LearningCandidate is auto-promoted from
 * `pending` to `promoted` (or auto-rejected) based on accumulated validation
 * outcomes. Apps wire this into {@link RecoveryFeedback.recordValidationOutcome}.
 */
export interface CandidatePromotionPolicy {
  /** Minimum average validation score (0-100) required to auto-promote. Default 75. */
  minScore: number
  /** Minimum consecutive successful validations required to auto-promote. Default 3. */
  minSuccessRuns: number
  /**
   * Failure-run count at which the candidate is auto-rejected. Default 3.
   * Reaching this count moves the candidate to `rejected` even if some runs
   * succeeded earlier — repeated regressions invalidate the lesson.
   */
  maxFailureRuns: number
}

export const DEFAULT_PROMOTION_POLICY: CandidatePromotionPolicy = {
  minScore: 75,
  minSuccessRuns: 3,
  maxFailureRuns: 3,
}

/** A recovery lesson staged for operator review before durable persistence. */
export interface LearningCandidate {
  /** Unique candidate ID (format: `cand_<timestamp>_<n>`). */
  id: string
  /** The underlying recovery lesson. */
  lesson: RecoveryLesson
  /** Current lifecycle status. */
  status: CandidateStatus
  /** When the candidate was created. */
  createdAt: Date
  /** When the candidate was reviewed (promote or reject). */
  reviewedAt?: Date
  /** Identity of the reviewer (system or operator id). */
  reviewedBy?: string
  /** Ordered audit trail of all lifecycle events. */
  auditTrail: AuditEntry[]
  /**
   * Most recent validation score recorded against this candidate (0-100).
   * Set by `RecoveryFeedback.recordValidationOutcome()`.
   */
  latestValidationScore?: number
  /** Rolling average validation score across all recorded outcomes. */
  avgValidationScore?: number
  /** Number of validation runs that succeeded (score >= policy.minScore). */
  successRunCount?: number
  /** Number of validation runs that failed (score < policy.minScore). */
  failureRunCount?: number
  /** Promotion policy applied to this candidate. Defaults to {@link DEFAULT_PROMOTION_POLICY}. */
  promotionPolicy?: CandidatePromotionPolicy
}

// ---------------------------------------------------------------------------
// In-memory candidate store
// ---------------------------------------------------------------------------

/** Minimal interface for storing/querying LearningCandidates. */
export interface LearningCandidateStore {
  add(candidate: LearningCandidate): void
  get(id: string): LearningCandidate | undefined
  listByStatus(status: CandidateStatus): LearningCandidate[]
  update(candidate: LearningCandidate): void
}

/**
 * Simple in-memory implementation of LearningCandidateStore.
 * Suitable for use within a single process. For multi-process or
 * persistent deployments, replace with a database-backed implementation.
 */
export class InMemoryLearningCandidateStore implements LearningCandidateStore {
  private readonly candidates = new Map<string, LearningCandidate>()

  add(candidate: LearningCandidate): void {
    this.candidates.set(candidate.id, candidate)
  }

  get(id: string): LearningCandidate | undefined {
    return this.candidates.get(id)
  }

  listByStatus(status: CandidateStatus): LearningCandidate[] {
    return [...this.candidates.values()].filter(c => c.status === status)
  }

  update(candidate: LearningCandidate): void {
    this.candidates.set(candidate.id, candidate)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append an audit entry to a candidate's trail (mutates in place). */
export function appendAuditEntry(
  candidate: LearningCandidate,
  entry: Omit<AuditEntry, 'candidateId'>,
): void {
  candidate.auditTrail.push({ ...entry, candidateId: candidate.id })
}
