/**
 * Lesson Pipeline — extract, store, and retrieve lessons from agent runs.
 *
 * Automatically captures lessons from error recoveries, successful runs,
 * and failed strategies, then stores them in a BaseStore for future retrieval.
 * Includes Jaccard-based deduplication to prevent redundant lessons.
 *
 * Usage:
 *   const pipeline = new LessonPipeline({ store })
 *   const lesson = await pipeline.extractFromRecovery({ runId, nodeId, errorType, ... })
 *   const relevant = await pipeline.retrieveForContext({ nodeId: 'gen_backend' })
 *   const prompt = pipeline.formatForPrompt(relevant)
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The type/category of a lesson */
export type LessonType = 'error_resolution' | 'successful_pattern' | 'failed_recovery' | 'convention'

/** Evidence supporting a lesson, linking it back to the originating run */
export interface LessonEvidence {
  runId: string
  nodeId?: string
  errorType?: string
  strategyUsed?: string
  qualityBefore?: number
  qualityAfter?: number
}

/** A lesson extracted from an agent run */
export interface Lesson {
  id: string
  type: LessonType
  summary: string
  details: string
  /** Context where this lesson applies (node IDs, task types, etc.) */
  applicableContext: string[]
  /** Confidence in this lesson (0-1, decays over time) */
  confidence: number
  /** Evidence supporting this lesson */
  evidence: LessonEvidence
  createdAt: string
  lastAppliedAt?: string
  applyCount: number
}

export interface LessonPipelineConfig {
  /** LangGraph BaseStore for persistence */
  store: BaseStore
  /** Namespace prefix for lesson storage (default: ['lessons']) */
  namespace?: string[]
  /** Similarity threshold for dedup (0-1, default: 0.6) */
  dedupThreshold?: number
  /** Max lessons to keep per context (default: 50) */
  maxLessonsPerContext?: number
}

export interface RecoveryParams {
  runId: string
  nodeId: string
  errorType: string
  errorMessage: string
  strategy: string
  outcome: 'success' | 'failure'
}

export interface SuccessParams {
  runId: string
  overallScore: number
  /** Key decisions or patterns that led to success */
  patterns: string[]
}

export interface RetrieveParams {
  nodeId?: string
  taskType?: string
  errorType?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Helpers (inlined to avoid circular deps with lesson-dedup.ts)
// ---------------------------------------------------------------------------

/** Tokenize text into a set of lower-case words */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1),
  )
}

/** Jaccard similarity between two token sets */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersectionSize = 0
  for (const word of a) {
    if (b.has(word)) intersectionSize++
  }
  const unionSize = a.size + b.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}

/** Generate a lesson ID with timestamp and random suffix */
function generateLessonId(): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `lesson_${Date.now()}_${suffix}`
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Convert a Lesson to a plain record for BaseStore */
function lessonToRecord(lesson: Lesson): Record<string, unknown> {
  return {
    id: lesson.id,
    type: lesson.type,
    summary: lesson.summary,
    details: lesson.details,
    applicableContext: lesson.applicableContext,
    confidence: lesson.confidence,
    evidence: lesson.evidence,
    createdAt: lesson.createdAt,
    lastAppliedAt: lesson.lastAppliedAt ?? null,
    applyCount: lesson.applyCount,
    // text field for searchability
    text: `${lesson.summary} ${lesson.details}`,
  }
}

/** Reconstruct a Lesson from a plain store record */
function recordToLesson(value: Record<string, unknown>): Lesson | null {
  if (typeof value['id'] !== 'string' || typeof value['summary'] !== 'string') {
    return null
  }
  return {
    id: value['id'] as string,
    type: (value['type'] as LessonType) ?? 'convention',
    summary: value['summary'] as string,
    details: (value['details'] as string) ?? '',
    applicableContext: Array.isArray(value['applicableContext'])
      ? (value['applicableContext'] as string[])
      : [],
    confidence: typeof value['confidence'] === 'number' ? value['confidence'] : 0.5,
    evidence: (value['evidence'] as LessonEvidence) ?? { runId: 'unknown' },
    createdAt: (value['createdAt'] as string) ?? new Date().toISOString(),
    lastAppliedAt: typeof value['lastAppliedAt'] === 'string'
      ? value['lastAppliedAt']
      : undefined,
    applyCount: typeof value['applyCount'] === 'number' ? value['applyCount'] : 0,
  }
}

// ---------------------------------------------------------------------------
// LessonPipeline
// ---------------------------------------------------------------------------

/** Minimum success score threshold for extracting lessons from successful runs */
const MIN_SUCCESS_SCORE = 0.85

export class LessonPipeline {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly dedupThreshold: number
  private readonly maxLessonsPerContext: number

  constructor(config: LessonPipelineConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['lessons']
    this.dedupThreshold = config.dedupThreshold ?? 0.6
    this.maxLessonsPerContext = config.maxLessonsPerContext ?? 50
  }

  // ---------- Extract from recovery ------------------------------------------

  /**
   * Extract and store a lesson from an error recovery attempt.
   * Called after RecoveryCopilot resolves (or fails to resolve) an error.
   */
  async extractFromRecovery(params: RecoveryParams): Promise<Lesson> {
    const { runId, nodeId, errorType, errorMessage, strategy, outcome } = params

    const type: LessonType = outcome === 'success' ? 'error_resolution' : 'failed_recovery'
    const confidence = outcome === 'success' ? 0.8 : 0.4

    const summary = outcome === 'success'
      ? `Resolved ${errorType} in ${nodeId} using strategy: ${strategy}`
      : `Strategy "${strategy}" failed for ${errorType} in ${nodeId}`

    const details = outcome === 'success'
      ? `Error "${errorMessage}" was resolved by applying "${strategy}" in node ${nodeId}.`
      : `Attempted "${strategy}" for error "${errorMessage}" in node ${nodeId}, but it did not resolve the issue.`

    const lesson: Lesson = {
      id: generateLessonId(),
      type,
      summary,
      details,
      applicableContext: [nodeId, errorType],
      confidence,
      evidence: {
        runId,
        nodeId,
        errorType,
        strategyUsed: strategy,
      },
      createdAt: new Date().toISOString(),
      applyCount: 0,
    }

    await this.storeWithDedup(lesson)
    return lesson
  }

  // ---------- Extract from success -------------------------------------------

  /**
   * Extract lessons from a high-scoring successful run.
   * Only extracts from runs with overallScore > 0.85.
   */
  async extractFromSuccess(params: SuccessParams): Promise<Lesson[]> {
    const { runId, overallScore, patterns } = params

    if (overallScore < MIN_SUCCESS_SCORE) {
      return []
    }

    const lessons: Lesson[] = []

    for (const pattern of patterns) {
      const lesson: Lesson = {
        id: generateLessonId(),
        type: 'successful_pattern',
        summary: pattern,
        details: `Pattern observed in run ${runId} with quality score ${overallScore.toFixed(2)}.`,
        applicableContext: [],
        confidence: Math.min(overallScore, 1.0),
        evidence: {
          runId,
          qualityAfter: overallScore,
        },
        createdAt: new Date().toISOString(),
        applyCount: 0,
      }

      await this.storeWithDedup(lesson)
      lessons.push(lesson)
    }

    return lessons
  }

  // ---------- Retrieve -------------------------------------------------------

  /**
   * Retrieve relevant lessons for a given context.
   * Filters by nodeId, taskType, or errorType match, then sorts
   * by confidence * recency.
   */
  async retrieveForContext(params: RetrieveParams): Promise<Lesson[]> {
    const { nodeId, taskType, errorType, limit = 10 } = params
    const now = Date.now()

    const allLessons = await this.loadAllLessons()

    // Filter by context match
    const matched = allLessons.filter(lesson => {
      if (!nodeId && !taskType && !errorType) return true

      const ctx = lesson.applicableContext.map(c => c.toLowerCase())
      const summaryLower = lesson.summary.toLowerCase()
      const detailsLower = lesson.details.toLowerCase()

      if (nodeId && (ctx.includes(nodeId.toLowerCase()) || summaryLower.includes(nodeId.toLowerCase()))) {
        return true
      }
      if (taskType && (ctx.includes(taskType.toLowerCase()) || summaryLower.includes(taskType.toLowerCase()))) {
        return true
      }
      if (errorType && (ctx.includes(errorType.toLowerCase()) || detailsLower.includes(errorType.toLowerCase()))) {
        return true
      }

      return false
    })

    // Sort by confidence * recency (newer = higher recency score)
    matched.sort((a, b) => {
      const recencyA = 1 / (1 + (now - new Date(a.createdAt).getTime()) / (24 * 60 * 60 * 1000))
      const recencyB = 1 / (1 + (now - new Date(b.createdAt).getTime()) / (24 * 60 * 60 * 1000))
      const scoreA = a.confidence * recencyA
      const scoreB = b.confidence * recencyB
      return scoreB - scoreA
    })

    return matched.slice(0, Math.min(limit, this.maxLessonsPerContext))
  }

  // ---------- Format ---------------------------------------------------------

  /**
   * Format retrieved lessons as a markdown bullet list for prompt injection.
   */
  formatForPrompt(lessons: Lesson[]): string {
    if (lessons.length === 0) return ''

    const lines = lessons.map(lesson => {
      const pct = Math.round(lesson.confidence * 100)
      return `- [${pct}%] ${lesson.summary}`
    })

    return `## Lessons Learned\n\n${lines.join('\n')}`
  }

  // ---------- Mark applied ---------------------------------------------------

  /**
   * Increment the apply count and update lastAppliedAt for a lesson.
   */
  async markApplied(lessonId: string): Promise<void> {
    try {
      const item = await this.store.get(this.namespace, lessonId)
      if (!item) return

      const value = item.value as Record<string, unknown>
      const lesson = recordToLesson(value)
      if (!lesson) return

      lesson.applyCount += 1
      lesson.lastAppliedAt = new Date().toISOString()

      await this.store.put(this.namespace, lessonId, lessonToRecord(lesson))
    } catch {
      // Non-fatal — marking applied is best-effort
    }
  }

  // ---------- Count ----------------------------------------------------------

  /**
   * Get total lesson count in the store.
   */
  async count(): Promise<number> {
    try {
      const items = await this.store.search(this.namespace, { limit: 1000 })
      return items.length
    } catch {
      return 0
    }
  }

  // ---------- Internal -------------------------------------------------------

  /**
   * Load all lessons from the store.
   */
  private async loadAllLessons(): Promise<Lesson[]> {
    try {
      const items = await this.store.search(this.namespace, { limit: 1000 })
      const lessons: Lesson[] = []
      for (const item of items) {
        const lesson = recordToLesson(item.value as Record<string, unknown>)
        if (lesson) lessons.push(lesson)
      }
      return lessons
    } catch {
      return []
    }
  }

  /**
   * Store a lesson after checking for duplicates.
   * If a similar lesson exists (Jaccard >= threshold), merge by boosting
   * the existing lesson's confidence instead of creating a new entry.
   */
  private async storeWithDedup(lesson: Lesson): Promise<void> {
    try {
      const existing = await this.loadAllLessons()
      const newTokens = tokenize(`${lesson.summary} ${lesson.details}`)

      for (const existingLesson of existing) {
        const existingTokens = tokenize(`${existingLesson.summary} ${existingLesson.details}`)
        const similarity = jaccardSimilarity(newTokens, existingTokens)

        if (similarity >= this.dedupThreshold) {
          // Merge: boost confidence of existing lesson
          existingLesson.confidence = Math.min(1.0, existingLesson.confidence + 0.1)
          await this.store.put(
            this.namespace,
            existingLesson.id,
            lessonToRecord(existingLesson),
          )
          // Update the new lesson's id to the existing one for the caller
          lesson.id = existingLesson.id
          lesson.confidence = existingLesson.confidence
          return
        }
      }

      // No duplicate found — store as new
      await this.store.put(this.namespace, lesson.id, lessonToRecord(lesson))
    } catch {
      // Non-fatal — lesson extraction failures should not break pipelines
    }
  }
}
