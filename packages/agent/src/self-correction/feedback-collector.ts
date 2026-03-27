/**
 * FeedbackCollector — captures user approval/rejection feedback from
 * plan and publish approval gates, converts it into lessons and rules
 * for downstream learning pipelines.
 *
 * Uses `BaseStore` from `@langchain/langgraph` for persistence.
 * No LLM calls — pure keyword-based text extraction.
 *
 * @module self-correction/feedback-collector
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeedbackType = 'plan_approval' | 'publish_approval'
export type FeedbackOutcome = 'approved' | 'rejected'

/** A persisted record of user feedback at an approval gate. */
export interface FeedbackRecord {
  id: string
  runId: string
  type: FeedbackType
  outcome: FeedbackOutcome
  feedback?: string
  featureCategory?: string
  riskClass?: string
  timestamp: Date
  /** Extracted action items from feedback (if rejected) */
  actionItems: string[]
}

/** Aggregated feedback statistics. */
export interface FeedbackStats {
  totalPlanFeedback: number
  planApprovalRate: number
  totalPublishFeedback: number
  publishApprovalRate: number
  commonRejectionReasons: Array<{ reason: string; count: number }>
  avgRejectionLength: number
}

/** Configuration for the FeedbackCollector. */
export interface FeedbackCollectorConfig {
  store: BaseStore
  namespace?: string[]
  /** Max feedback records to keep (default: 200) */
  maxRecords?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keywords that indicate an actionable sentence. */
const ACTION_KEYWORDS = [
  'should',
  'must',
  'need to',
  'add',
  'remove',
  'fix',
  'change',
  'include',
  'missing',
]

/** Common English stopwords for rejection reason extraction. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'its',
  'it', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'don\'t', 'doesn\'t', 'didn\'t', 'won\'t',
  'wouldn\'t', 'couldn\'t', 'shouldn\'t', 'isn\'t', 'aren\'t', 'wasn\'t',
  'weren\'t', 'hasn\'t', 'haven\'t', 'hadn\'t',
])

/** Maximum common rejection reasons returned by getStats(). */
const TOP_REASONS_LIMIT = 10

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export interface SerializedFeedbackRecord {
  id: string
  runId: string
  type: FeedbackType
  outcome: FeedbackOutcome
  feedback?: string
  featureCategory?: string
  riskClass?: string
  timestamp: string
  actionItems: string[]
}

function serializeRecord(record: FeedbackRecord): Record<string, unknown> {
  return {
    id: record.id,
    runId: record.runId,
    type: record.type,
    outcome: record.outcome,
    feedback: record.feedback,
    featureCategory: record.featureCategory,
    riskClass: record.riskClass,
    timestamp: record.timestamp.toISOString(),
    actionItems: record.actionItems,
    text: `feedback ${record.type} ${record.outcome} ${record.feedback ?? ''}`.trim(),
  }
}

function deserializeRecord(value: Record<string, unknown>): FeedbackRecord | null {
  if (typeof value['id'] !== 'string' || typeof value['runId'] !== 'string') return null
  return {
    id: value['id'] as string,
    runId: value['runId'] as string,
    type: value['type'] as FeedbackType,
    outcome: value['outcome'] as FeedbackOutcome,
    feedback: typeof value['feedback'] === 'string' ? value['feedback'] : undefined,
    featureCategory: typeof value['featureCategory'] === 'string' ? value['featureCategory'] : undefined,
    riskClass: typeof value['riskClass'] === 'string' ? value['riskClass'] : undefined,
    timestamp: typeof value['timestamp'] === 'string' ? new Date(value['timestamp'] as string) : new Date(),
    actionItems: Array.isArray(value['actionItems']) ? value['actionItems'] as string[] : [],
  }
}

// ---------------------------------------------------------------------------
// FeedbackCollector
// ---------------------------------------------------------------------------

/**
 * Captures user approval/rejection feedback from plan and publish
 * approval gates, extracts actionable items, and converts them into
 * lesson and rule formats compatible with downstream learning pipelines.
 */
export class FeedbackCollector {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly maxRecords: number
  private recordCounter = 0

  constructor(config: FeedbackCollectorConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['self_correction', 'feedback']
    this.maxRecords = config.maxRecords ?? 200
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record plan approval/rejection feedback.
   */
  async recordPlanFeedback(params: {
    runId: string
    approved: boolean
    feedback?: string
    featureCategory?: string
    riskClass?: string
  }): Promise<FeedbackRecord> {
    return this.recordFeedback('plan_approval', params)
  }

  /**
   * Record publish approval/rejection feedback.
   */
  async recordPublishFeedback(params: {
    runId: string
    approved: boolean
    feedback?: string
    featureCategory?: string
    riskClass?: string
  }): Promise<FeedbackRecord> {
    return this.recordFeedback('publish_approval', params)
  }

  /**
   * Extract actionable items from rejection feedback text.
   *
   * Splits by sentence boundaries (`.`, `!`, newlines) and filters
   * to sentences containing action keywords such as "should", "must",
   * "need to", "add", "remove", "fix", "change", "include", "missing".
   */
  extractActionItems(feedback: string): string[] {
    if (!feedback || feedback.trim().length === 0) return []

    // Split on sentence boundaries
    const sentences = feedback
      .split(/[.!]\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const actionItems: string[] = []
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase()
      const hasAction = ACTION_KEYWORDS.some((kw) => lower.includes(kw))
      if (hasAction) {
        actionItems.push(sentence)
      }
    }

    return actionItems
  }

  /**
   * Convert rejection feedback into lessons compatible with
   * LessonPipeline format.
   *
   * Each action item becomes a lesson with type = 'user_feedback'
   * and confidence = 0.9 (user feedback is high signal).
   */
  feedbackToLessons(record: FeedbackRecord): Array<{
    summary: string
    type: string
    confidence: number
    applicableContext: string[]
  }> {
    if (record.outcome !== 'rejected' || record.actionItems.length === 0) {
      return []
    }

    const context: string[] = []
    if (record.featureCategory) context.push(record.featureCategory)
    if (record.riskClass) context.push(record.riskClass)

    return record.actionItems.map((item) => ({
      summary: item,
      type: 'user_feedback',
      confidence: 0.9,
      applicableContext: context,
    }))
  }

  /**
   * Convert rejection feedback into rules compatible with
   * RuleEngine format.
   *
   * Each action item becomes a rule with source = 'human' and
   * scope derived from featureCategory and riskClass.
   */
  feedbackToRules(record: FeedbackRecord): Array<{
    content: string
    scope: string[]
    source: string
    confidence: number
  }> {
    if (record.outcome !== 'rejected' || record.actionItems.length === 0) {
      return []
    }

    const scope = [record.featureCategory, record.riskClass].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    )

    return record.actionItems.map((item) => ({
      content: item,
      scope,
      source: 'human',
      confidence: 0.9,
    }))
  }

  /**
   * Get aggregated feedback statistics.
   */
  async getStats(): Promise<FeedbackStats> {
    const records = await this.loadAllRecords()

    let totalPlanFeedback = 0
    let planApprovals = 0
    let totalPublishFeedback = 0
    let publishApprovals = 0
    let totalRejectionLength = 0
    let rejectionCount = 0

    const wordFrequency = new Map<string, number>()

    for (const record of records) {
      if (record.type === 'plan_approval') {
        totalPlanFeedback++
        if (record.outcome === 'approved') planApprovals++
      } else if (record.type === 'publish_approval') {
        totalPublishFeedback++
        if (record.outcome === 'approved') publishApprovals++
      }

      if (record.outcome === 'rejected' && record.feedback) {
        totalRejectionLength += record.feedback.length
        rejectionCount++

        // Extract keywords for common rejection reasons
        const words = record.feedback
          .toLowerCase()
          .replace(/[^a-z0-9\s'-]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2 && !STOPWORDS.has(w))

        for (const word of words) {
          wordFrequency.set(word, (wordFrequency.get(word) ?? 0) + 1)
        }
      }
    }

    // Sort by frequency descending, take top N
    const commonRejectionReasons = Array.from(wordFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_REASONS_LIMIT)
      .map(([reason, count]) => ({ reason, count }))

    return {
      totalPlanFeedback,
      planApprovalRate: totalPlanFeedback > 0 ? planApprovals / totalPlanFeedback : 0,
      totalPublishFeedback,
      publishApprovalRate: totalPublishFeedback > 0 ? publishApprovals / totalPublishFeedback : 0,
      commonRejectionReasons,
      avgRejectionLength: rejectionCount > 0 ? totalRejectionLength / rejectionCount : 0,
    }
  }

  /**
   * Get recent feedback records, sorted by timestamp descending.
   */
  async getRecent(limit = 20): Promise<FeedbackRecord[]> {
    const records = await this.loadAllRecords()
    records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    return records.slice(0, limit)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Core recording method shared by plan and publish feedback.
   */
  private async recordFeedback(
    type: FeedbackType,
    params: {
      runId: string
      approved: boolean
      feedback?: string
      featureCategory?: string
      riskClass?: string
    },
  ): Promise<FeedbackRecord> {
    const actionItems =
      !params.approved && params.feedback
        ? this.extractActionItems(params.feedback)
        : []

    const record: FeedbackRecord = {
      id: this.generateId(),
      runId: params.runId,
      type,
      outcome: params.approved ? 'approved' : 'rejected',
      feedback: params.feedback,
      featureCategory: params.featureCategory,
      riskClass: params.riskClass,
      timestamp: new Date(),
      actionItems,
    }

    const ns = [...this.namespace, 'records']
    await this.store.put(ns, record.id, serializeRecord(record))

    // Enforce max records limit
    await this.enforceMaxRecords(ns)

    return record
  }

  /**
   * Load all feedback records from the store.
   */
  private async loadAllRecords(): Promise<FeedbackRecord[]> {
    try {
      const ns = [...this.namespace, 'records']
      const items = await this.store.search(ns, { limit: this.maxRecords })
      const records: FeedbackRecord[] = []

      for (const item of items) {
        const record = deserializeRecord(item.value as Record<string, unknown>)
        if (record) records.push(record)
      }

      return records
    } catch {
      return []
    }
  }

  /**
   * Remove oldest records when exceeding maxRecords limit.
   */
  private async enforceMaxRecords(ns: string[]): Promise<void> {
    try {
      const items = await this.store.search(ns, { limit: this.maxRecords + 50 })

      if (items.length <= this.maxRecords) return

      // Sort by timestamp ascending (oldest first)
      const sorted = [...items].sort((a, b) => {
        const aTs = (a.value as Record<string, unknown>)['timestamp'] as string
        const bTs = (b.value as Record<string, unknown>)['timestamp'] as string
        return (aTs ?? '').localeCompare(bTs ?? '')
      })

      const toDelete = sorted.slice(0, items.length - this.maxRecords)
      for (const item of toDelete) {
        const id = (item.value as Record<string, unknown>)['id'] as string
        if (id) {
          await this.store.delete(ns, id)
        }
      }
    } catch {
      // best-effort pruning
    }
  }

  /**
   * Generate a unique record ID.
   */
  private generateId(): string {
    this.recordCounter++
    return `fb_${Date.now()}_${this.recordCounter}`
  }
}
