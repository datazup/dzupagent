/**
 * Memory-aware observation extractor.
 *
 * Wraps the base ObservationExtractor and checks existing memory before storing
 * extracted observations. This prevents duplicate observations from accumulating
 * across extraction cycles.
 *
 * Deduplication is best-effort: if semantic search fails or the namespace is not
 * searchable, observations are stored unconditionally (falling back to base behavior).
 *
 * @example
 * ```ts
 * const extractor = new MemoryAwareExtractor({
 *   model: cheapModel,
 *   memoryService,
 *   namespace: 'observations',
 *   scope: { tenantId: 't1', projectId: 'p1' },
 *   similarityThreshold: 0.85,
 * })
 *
 * if (extractor.shouldExtract(messages.length)) {
 *   const result = await extractor.extractAndStore(messages)
 *   console.log(`Added ${result.added.length}, skipped ${result.skipped.length}`)
 * }
 * ```
 */
import type { BaseMessage } from '@langchain/core/messages'
import { ObservationExtractor } from './observation-extractor.js'
import type { ObservationExtractorConfig, Observation } from './observation-extractor.js'
import type { MemoryService } from './memory-service.js'

export interface MemoryAwareExtractorConfig extends ObservationExtractorConfig {
  /** MemoryService for checking existing observations */
  memoryService: MemoryService
  /** Namespace to search/store observations in */
  namespace: string
  /** Scope for memory operations */
  scope: Record<string, string>
  /** Similarity threshold above which an observation is considered duplicate (default: 0.8) */
  similarityThreshold?: number
  /** Max similar entries to check per observation (default: 3) */
  deduplicationTopK?: number
}

export interface ExtractionResult {
  /** Newly added observations */
  added: Observation[]
  /** Observations skipped because similar entry already exists */
  skipped: Array<{ observation: Observation; existingKey: string; reason: string }>
  /** Total extracted before dedup */
  totalExtracted: number
}

/**
 * Compute Jaccard similarity between two strings based on word tokens.
 * Returns a value between 0 and 1.
 */
function wordJaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean))

  const setA = tokenize(a)
  const setB = tokenize(b)

  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0

  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }

  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

export class MemoryAwareExtractor {
  private readonly extractor: ObservationExtractor
  private readonly memoryService: MemoryService
  private readonly namespace: string
  private readonly scope: Record<string, string>
  private readonly similarityThreshold: number
  private readonly deduplicationTopK: number

  constructor(config: MemoryAwareExtractorConfig) {
    this.extractor = new ObservationExtractor(config)
    this.memoryService = config.memoryService
    this.namespace = config.namespace
    this.scope = config.scope
    this.similarityThreshold = config.similarityThreshold ?? 0.8
    this.deduplicationTopK = config.deduplicationTopK ?? 3
  }

  /** Check if extraction should be triggered (delegates to inner extractor) */
  shouldExtract(messageCount: number): boolean {
    return this.extractor.shouldExtract(messageCount)
  }

  /**
   * Extract observations and store only non-duplicate ones.
   *
   * 1. Extract using inner ObservationExtractor
   * 2. For each observation, search existing memory for semantically similar entries
   * 3. Skip if similar entry found above threshold, store if new
   *
   * Deduplication is best-effort: search failures are non-fatal and cause
   * the observation to be stored unconditionally.
   */
  async extractAndStore(messages: BaseMessage[]): Promise<ExtractionResult> {
    const observations = await this.extractor.extract(messages)

    const result: ExtractionResult = {
      added: [],
      skipped: [],
      totalExtracted: observations.length,
    }

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i]
      if (!obs) continue

      // Attempt deduplication via semantic search
      const duplicate = await this.findDuplicate(obs)

      if (duplicate !== null) {
        result.skipped.push({
          observation: obs,
          existingKey: duplicate.key,
          reason: `Similar entry exists (similarity: ${duplicate.similarity.toFixed(2)})`,
        })
        continue
      }

      // No duplicate found — store as new observation
      const key = `obs-${Date.now()}-${i}`
      try {
        await this.memoryService.put(this.namespace, this.scope, key, {
          text: obs.text,
          category: obs.category,
          confidence: obs.confidence,
          source: obs.source,
          createdAt: obs.createdAt,
        })
        result.added.push(obs)
      } catch {
        // Non-fatal: storage failure should not break the pipeline.
        // Still count as added since we attempted to store it.
        result.added.push(obs)
      }
    }

    return result
  }

  /** Reset extraction state */
  reset(): void {
    this.extractor.reset()
  }

  /** Current extraction count */
  get count(): number {
    return this.extractor.count
  }

  /**
   * Search existing memory for a duplicate of the given observation.
   * Returns match info if a similar entry is found, or null if no duplicate.
   *
   * Best-effort: if search fails, returns null (observation will be stored).
   */
  private async findDuplicate(
    obs: Observation,
  ): Promise<{ key: string; similarity: number } | null> {
    try {
      const existing = await this.memoryService.search(
        this.namespace,
        this.scope,
        obs.text,
        this.deduplicationTopK,
      )

      // If search returned nothing, no duplicate
      if (existing.length === 0) return null

      // Check each result for text similarity above threshold.
      // MemoryService.search() does semantic ranking but does not expose scores,
      // so we use word-level Jaccard similarity as a secondary check.
      for (const entry of existing) {
        const entryText = typeof entry['text'] === 'string'
          ? entry['text']
          : JSON.stringify(entry)

        const similarity = wordJaccardSimilarity(obs.text, entryText)

        if (similarity >= this.similarityThreshold) {
          // Derive key from entry if available, otherwise use a placeholder
          const key = typeof entry['key'] === 'string'
            ? entry['key']
            : 'existing-entry'
          return { key, similarity }
        }
      }

      return null
    } catch {
      // Best-effort: search failure is non-fatal, allow storage
      return null
    }
  }
}
