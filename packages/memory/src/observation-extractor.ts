/**
 * Observation extractor — automatically extracts structured facts from conversations.
 *
 * Runs a cheap LLM model on recent messages to extract observations
 * (facts, preferences, decisions, conventions) with confidence scores.
 * Debounced to avoid excessive LLM calls.
 *
 * @example
 * ```ts
 * const extractor = new ObservationExtractor({
 *   model: cheapModel,
 *   minMessages: 8,
 *   debounceMs: 30_000,
 * })
 *
 * // After each conversation turn:
 * if (extractor.shouldExtract(messages.length)) {
 *   const observations = await extractor.extract(recentMessages)
 *   for (const obs of observations) {
 *     await memoryService.put('observations', scope, obs.text, obs)
 *   }
 * }
 * ```
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'

export type ObservationCategory = 'fact' | 'preference' | 'decision' | 'convention' | 'constraint'

export interface Observation {
  text: string
  category: ObservationCategory
  confidence: number // 0-1
  source: 'extracted' | 'explicit'
  createdAt: number
}

export interface ObservationExtractorConfig {
  /** LLM model for extraction (use cheap/fast tier) */
  model: BaseChatModel
  /** Minimum messages before triggering extraction (default: 10) */
  minMessages?: number | undefined
  /** Minimum interval between extractions in ms (default: 30_000) */
  debounceMs?: number | undefined
  /** Maximum observations per session (default: 50) */
  maxObservations?: number | undefined
}

const EXTRACTION_PROMPT = `Extract key observations from this conversation. For each observation, provide:
- text: A concise, factual statement
- category: One of: fact, preference, decision, convention, constraint
- confidence: A number 0-1 indicating how certain this observation is

Rules:
- Only extract clearly stated or strongly implied observations
- Keep each observation to one sentence
- Avoid duplicating information already known
- Maximum 5 observations per extraction

Respond as a JSON array:
[{ "text": "...", "category": "...", "confidence": 0.9 }]`

export class ObservationExtractor {
  private lastExtractedAt = 0
  private extractionCount = 0
  private readonly minMessages: number
  private readonly debounceMs: number
  private readonly maxObservations: number

  constructor(private config: ObservationExtractorConfig) {
    this.minMessages = config.minMessages ?? 10
    this.debounceMs = config.debounceMs ?? 30_000
    this.maxObservations = config.maxObservations ?? 50
  }

  /** Check if extraction should be triggered */
  shouldExtract(messageCount: number): boolean {
    if (messageCount < this.minMessages) return false
    if (this.extractionCount >= this.maxObservations) return false
    if (Date.now() - this.lastExtractedAt < this.debounceMs) return false
    return true
  }

  /** Extract observations from recent messages */
  async extract(messages: BaseMessage[]): Promise<Observation[]> {
    this.lastExtractedAt = Date.now()

    const conversationText = messages
      .map(m => {
        const role = m._getType()
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `${role}: ${content}`
      })
      .join('\n\n')

    try {
      const response = await this.config.model.invoke([
        new SystemMessage(EXTRACTION_PROMPT),
        new HumanMessage(`Recent conversation:\n\n${conversationText}`),
      ])

      const text = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

      const observations = this.parseObservations(text)
      this.extractionCount += observations.length
      return observations
    } catch {
      // Extraction is non-fatal
      return []
    }
  }

  /** Current extraction count this session */
  get count(): number {
    return this.extractionCount
  }

  /** Reset extraction state */
  reset(): void {
    this.lastExtractedAt = 0
    this.extractionCount = 0
  }

  private parseObservations(text: string): Observation[] {
    // Try to extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    try {
      const raw = JSON.parse(jsonMatch[0]) as Array<{
        text?: string
        category?: string
        confidence?: number
      }>

      const validCategories = new Set<string>(['fact', 'preference', 'decision', 'convention', 'constraint'])
      const now = Date.now()

      return raw
        .filter(r => r.text && r.category && validCategories.has(r.category))
        .map(r => ({
          text: r.text!,
          category: r.category as ObservationCategory,
          confidence: Math.max(0, Math.min(1, r.confidence ?? 0.5)),
          source: 'extracted' as const,
          createdAt: now,
        }))
    } catch {
      return []
    }
  }
}
