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
  private lessonCounter = 0

  constructor(config: RecoveryFeedbackConfig = {}) {
    this.store = config.store
    this.namespace = config.namespace ?? ['recovery', 'lessons']
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a recovery outcome as a lesson in the store.
   * No-op if no store is configured.
   */
  async recordOutcome(lesson: RecoveryLesson): Promise<void> {
    if (!this.store) return

    const key = lesson.id
    const serialized = serializeLesson(lesson)

    await this.store.put(this.namespace, key, serialized)
  }

  /**
   * Retrieve past recovery lessons for similar errors.
   *
   * Searches by errorType and nodeId to find relevant past lessons.
   * Returns up to `limit` results, sorted by most recent first.
   */
  async retrieveSimilar(
    errorType: string,
    nodeId: string,
    limit = 5,
  ): Promise<RecoveryLesson[]> {
    if (!this.store) return []

    // Search the store with a filter on errorType
    const results = await this.store.search(this.namespace, {
      filter: { errorType },
      limit: limit * 3, // over-fetch to filter by nodeId client-side
    })

    const lessons: RecoveryLesson[] = []

    for (const item of results) {
      if (!isLessonRecord(item.value)) continue
      // Match the previous behaviour: keep only entries that look like real
      // lessons (must have at least an id and errorType).
      if (typeof item.value.id !== 'string' || typeof item.value.errorType !== 'string') {
        continue
      }
      lessons.push(hydrateLesson(item.value))
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
