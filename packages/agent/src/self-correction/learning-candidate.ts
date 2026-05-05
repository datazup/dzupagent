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

import type { RecoveryLesson } from './recovery-feedback.js'

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
  event: 'staged' | 'promoted' | 'rejected' | 'policy_applied'
  /** Whether this was triggered by the system or an operator. */
  actor: 'system' | 'operator'
  /** Human-readable description of what happened. */
  detail: string
  /** When this entry was recorded. */
  timestamp: Date
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
