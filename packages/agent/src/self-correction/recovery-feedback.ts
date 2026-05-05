/**
 * Recovery feedback — persists recovery outcomes as lessons to memory
 * so the system can learn from past successes and failures.
 *
 * Uses `BaseStore` from `@langchain/langgraph` for persistence.
 * When no store is provided, all operations are no-ops, allowing
 * the feedback module to be optional.
 *
 * @module self-correction/recovery-feedback
 */

import type { BaseStore } from '@langchain/langgraph'
import type { FailureType } from '../recovery/recovery-types.js'
import {
  type LearningCandidate,
  type LearningCandidateStore,
  type AuditEntry,
  InMemoryLearningCandidateStore,
  appendAuditEntry,
} from './learning-candidate.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A persisted record of a recovery attempt and its outcome. */
export interface RecoveryLesson {
  /** Unique lesson identifier. */
  id: string
  /** The classified failure type (from FailureType). */
  errorType: FailureType
  /** Fingerprint from the FailureAnalyzer for dedup / matching. */
  errorFingerprint: string
  /** Pipeline node where the failure occurred (if applicable). */
  nodeId: string
  /** Name of the recovery strategy that was attempted. */
  strategy: string
  /** Whether the recovery succeeded or failed. */
  outcome: 'success' | 'failure'
  /** Human-readable summary of what happened. */
  summary: string
  /** When the lesson was recorded. */
  timestamp: Date
}

/** Configuration for the RecoveryFeedback module. */
export interface RecoveryFeedbackConfig {
  /** Memory store for persisting lessons. Optional — if not provided, feedback is no-op. */
  store?: BaseStore
  /** Namespace prefix for lesson storage (default: ['recovery', 'lessons']). */
  namespace?: string[]
  /**
   * Candidate store for the staging layer. When provided, lessons are staged
   * as LearningCandidates and must be explicitly promoted before being written
   * to the durable store. Defaults to an InMemoryLearningCandidateStore.
   */
  candidateStore?: LearningCandidateStore
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Stored representation of a {@link RecoveryLesson}.
 *
 * Declared as a type alias of an index-signature record so it satisfies the
 * `Record<string, unknown>` shape required by `BaseStore.put` without any
 * unchecked cast at the call site.
 */
type SerializedLesson = Record<string, unknown> & {
  id: string
  errorType: string
  errorFingerprint: string
  nodeId: string
  strategy: string
  outcome: 'success' | 'failure'
  summary: string
  timestamp: string
}

/**
 * Type guard that narrows an arbitrary store value to a record we can read
 * lesson fields from. Callers index this record with optional checks (e.g.
 * `value.id`, `value.outcome`) instead of trusting a wide cast.
 */
function isLessonRecord(value: unknown): value is Partial<SerializedLesson> {
  return typeof value === 'object' && value !== null
}

/**
 * Best-effort hydration of a stored value into a fully-shaped
 * `RecoveryLesson`. Missing string fields fall back to empty strings to
 * preserve the lenient behaviour of the original cast-based implementation.
 */
function hydrateLesson(value: Partial<SerializedLesson>): RecoveryLesson {
  return {
    id: value.id ?? '',
    errorType: (value.errorType ?? '') as FailureType,
    errorFingerprint: value.errorFingerprint ?? '',
    nodeId: value.nodeId ?? '',
    strategy: value.strategy ?? '',
    outcome: value.outcome === 'failure' ? 'failure' : 'success',
    summary: value.summary ?? '',
    timestamp: typeof value.timestamp === 'string' ? new Date(value.timestamp) : new Date(0),
  }
}

function serializeLesson(lesson: RecoveryLesson): SerializedLesson {
  return {
    id: lesson.id,
    errorType: lesson.errorType,
    errorFingerprint: lesson.errorFingerprint,
    nodeId: lesson.nodeId,
    strategy: lesson.strategy,
    outcome: lesson.outcome,
    summary: lesson.summary,
    timestamp: lesson.timestamp.toISOString(),
  }
}


// ---------------------------------------------------------------------------
// RecoveryFeedback
// ---------------------------------------------------------------------------

/**
 * Persists recovery outcomes (lessons) to a BaseStore and retrieves
 * similar past lessons to inform future recovery strategy selection.
 *
 * When no store is configured, all operations gracefully no-op so
 * the feedback module can be wired in without requiring persistence.
 */
export class RecoveryFeedback {
  private readonly store: BaseStore | undefined
  private readonly namespace: string[]
  private readonly candidateStore: LearningCandidateStore
  private lessonCounter = 0
  private candidateCounter = 0

  constructor(config: RecoveryFeedbackConfig = {}) {
    this.store = config.store
    this.namespace = config.namespace ?? ['recovery', 'lessons']
    this.candidateStore = config.candidateStore ?? new InMemoryLearningCandidateStore()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Stage a recovery outcome as a LearningCandidate pending operator review.
   * The lesson is NOT written to the durable store until `promoteCandidate()` is called.
   * Returns the candidate ID so callers can include it in audit chains.
   */
  async recordOutcome(lesson: RecoveryLesson): Promise<string> {
    return this.stageCandidate(lesson, 'system', `Staged from run ${lesson.id}`)
  }

  /**
   * Stage a lesson as a LearningCandidate with an explicit audit reason.
   * Returns the new candidate's ID.
   */
  stageCandidate(
    lesson: RecoveryLesson,
    actor: 'system' | 'operator' = 'system',
    detail = 'Recovery outcome staged for review',
  ): string {
    this.candidateCounter++
    const candidateId = `cand_${Date.now()}_${this.candidateCounter}`
    const now = new Date()
    const auditEntry: Omit<AuditEntry, 'candidateId'> = {
      runId: lesson.id,
      nodeId: lesson.nodeId,
      event: 'staged',
      actor,
      detail,
      timestamp: now,
    }
    const candidate: LearningCandidate = {
      id: candidateId,
      lesson,
      status: 'pending',
      createdAt: now,
      auditTrail: [],
    }
    appendAuditEntry(candidate, auditEntry)
    this.candidateStore.add(candidate)
    return candidateId
  }

  /**
   * Promote a pending candidate to durable memory.
   * No-op (returns false) if candidate not found or already reviewed.
   */
  async promoteCandidate(
    candidateId: string,
    reviewedBy = 'operator',
  ): Promise<boolean> {
    const candidate = this.candidateStore.get(candidateId)
    if (!candidate || candidate.status !== 'pending') return false

    const now = new Date()
    candidate.status = 'promoted'
    candidate.reviewedAt = now
    candidate.reviewedBy = reviewedBy
    appendAuditEntry(candidate, {
      runId: candidate.lesson.id,
      nodeId: candidate.lesson.nodeId,
      event: 'promoted',
      actor: 'operator',
      detail: `Promoted by ${reviewedBy}`,
      timestamp: now,
    })
    this.candidateStore.update(candidate)

    if (this.store) {
      const serialized = serializeLesson(candidate.lesson)
      await this.store.put(this.namespace, candidate.lesson.id, serialized)
    }

    return true
  }

  /**
   * Reject a pending candidate. The lesson is NOT written to the durable store.
   * Returns false if candidate not found or already reviewed.
   */
  rejectCandidate(
    candidateId: string,
    reviewedBy = 'operator',
  ): boolean {
    const candidate = this.candidateStore.get(candidateId)
    if (!candidate || candidate.status !== 'pending') return false

    const now = new Date()
    candidate.status = 'rejected'
    candidate.reviewedAt = now
    candidate.reviewedBy = reviewedBy
    appendAuditEntry(candidate, {
      runId: candidate.lesson.id,
      nodeId: candidate.lesson.nodeId,
      event: 'rejected',
      actor: 'operator',
      detail: `Rejected by ${reviewedBy}`,
      timestamp: now,
    })
    this.candidateStore.update(candidate)
    return true
  }

  /**
   * List all pending LearningCandidates awaiting operator review.
   */
  listPendingCandidates(): LearningCandidate[] {
    return this.candidateStore.listByStatus('pending')
  }

  /**
   * Get a specific LearningCandidate by ID.
   */
  getCandidate(candidateId: string): LearningCandidate | undefined {
    return this.candidateStore.get(candidateId)
  }

  /**
   * Append an audit entry to a candidate's trail.
   * No-op if the candidate does not exist.
   */
  appendCandidateAuditEntry(
    candidateId: string,
    entry: Omit<AuditEntry, 'candidateId'>,
  ): void {
    const candidate = this.candidateStore.get(candidateId)
    if (!candidate) return
    appendAuditEntry(candidate, entry)
    this.candidateStore.update(candidate)
  }

  /**
   * Retrieve past recovery lessons for similar errors.
   *
   * Searches both the durable store (promoted lessons) and the candidate store
   * (pending/promoted candidates) by errorType and nodeId.
   * Returns up to `limit` results, sorted by most recent first.
   */
  async retrieveSimilar(
    errorType: string,
    nodeId: string,
    limit = 5,
  ): Promise<RecoveryLesson[]> {
    const lessons: RecoveryLesson[] = []
    const seen = new Set<string>()

    // Search durable store first (promoted lessons)
    if (this.store) {
      const results = await this.store.search(this.namespace, {
        filter: { errorType },
        limit: limit * 3, // over-fetch to filter by nodeId client-side
      })

      for (const item of results) {
        if (!isLessonRecord(item.value)) continue
        if (typeof item.value.id !== 'string' || typeof item.value.errorType !== 'string') {
          continue
        }
        seen.add(item.value.id)
        lessons.push(hydrateLesson(item.value))
      }
    }

    // Also include lessons from the candidate store (any status — staged lessons
    // are immediately useful for decision-making even before promotion)
    for (const candidate of this.candidateStore.listByStatus('pending')) {
      const lesson = candidate.lesson
      if (lesson.errorType !== errorType) continue
      if (seen.has(lesson.id)) continue
      seen.add(lesson.id)
      lessons.push(lesson)
    }
    for (const candidate of this.candidateStore.listByStatus('promoted')) {
      const lesson = candidate.lesson
      if (lesson.errorType !== errorType) continue
      if (seen.has(lesson.id)) continue
      seen.add(lesson.id)
      lessons.push(lesson)
    }

    // Sort: same-node first, then by timestamp descending
    lessons.sort((a, b) => {
      const aMatchesNode = a.nodeId === nodeId ? 0 : 1
      const bMatchesNode = b.nodeId === nodeId ? 0 : 1
      if (aMatchesNode !== bMatchesNode) return aMatchesNode - bMatchesNode
      return b.timestamp.getTime() - a.timestamp.getTime()
    })

    return lessons.slice(0, limit)
  }

  /**
   * Get the success rate for a given error type.
   * Returns `{ total: 0, successes: 0, rate: 0 }` if no store or no data.
   */
  async getSuccessRate(errorType: string): Promise<{
    total: number
    successes: number
    rate: number
  }> {
    if (!this.store) return { total: 0, successes: 0, rate: 0 }

    const results = await this.store.search(this.namespace, {
      filter: { errorType },
      limit: 1000, // fetch all for this error type
    })

    let total = 0
    let successes = 0

    for (const item of results) {
      if (!isLessonRecord(item.value)) continue
      if (item.value.outcome !== 'success' && item.value.outcome !== 'failure') {
        continue
      }
      total++
      if (item.value.outcome === 'success') successes++
    }

    return {
      total,
      successes,
      rate: total > 0 ? successes / total : 0,
    }
  }

  /**
   * Generate a unique lesson ID.
   */
  generateLessonId(): string {
    this.lessonCounter++
    return `lesson_${Date.now()}_${this.lessonCounter}`
  }
}
