/**
 * Convention Extractor — detects project coding conventions from code samples
 * and checks conformance of new code against stored conventions.
 *
 * Works with or without an LLM. Conventions are persisted via MemoryService
 * in a dedicated namespace and optionally indexed in a SemanticStore.
 *
 * Thin coordinator; pure logic lives in sibling modules: convention-heuristics,
 * -analyzer, -conformance, -codec, -merge, -store, -utils.
 */
import type { MemoryService } from '../memory-service.js'
import type { SemanticStoreAdapter } from '../memory-types.js'
import type {
  ConventionExtractorConfig,
  ConventionFilter,
  ConsolidateOptions,
  DetectedConvention,
  ConventionCheckResult,
} from './types.js'
import { analyzeWithHeuristics, analyzeWithLLM } from './convention-analyzer.js'
import { checkWithHeuristics, checkWithLLM } from './convention-conformance.js'
import { recordToConvention } from './convention-codec.js'
import { deduplicateStrings } from './convention-utils.js'
import { formatConventionsAsMarkdown, mergeSimilarConventions } from './convention-merge.js'
import {
  CONVENTION_SCOPE_KEY,
  applyConventionFilters,
  embedConventions,
  findExistingConvention,
  semanticRerank,
  storeConvention,
  tombstoneConvention,
} from './convention-store.js'

const DEFAULT_NAMESPACE = '__conventions'

export class ConventionExtractor {
  private readonly memoryService: MemoryService
  private readonly llm: ((prompt: string) => Promise<string>) | undefined
  private readonly namespace: string
  private readonly semanticStore: SemanticStoreAdapter | undefined

  constructor(config: ConventionExtractorConfig) {
    this.memoryService = config.memoryService
    this.llm = config.llm
    this.namespace = config.namespace ?? DEFAULT_NAMESPACE
    this.semanticStore = config.semanticStore
  }

  /**
   * Analyze code files to detect conventions.
   * Returns newly detected or updated conventions.
   */
  async analyzeCode(
    files: Array<{ path: string; content: string }>,
  ): Promise<DetectedConvention[]> {
    const allContent = files.map(f => f.content).join('\n')
    const detected = this.llm
      ? await analyzeWithLLM(this.llm, files)
      : analyzeWithHeuristics(allContent)

    const results: DetectedConvention[] = []
    for (const conv of detected) {
      const existing = await findExistingConvention(this.memoryService, this.namespace, conv.id)
      const next: DetectedConvention = existing
        ? {
            ...existing,
            occurrences: existing.occurrences + conv.occurrences,
            confidence: Math.max(existing.confidence, conv.confidence),
            examples: deduplicateStrings([...existing.examples, ...conv.examples]).slice(0, 5),
          }
        : conv
      await storeConvention(this.memoryService, this.namespace, next)
      results.push(next)
    }

    if (this.semanticStore) {
      await embedConventions(this.semanticStore, results)
    }

    return results
  }

  /**
   * Get all stored conventions, optionally filtered.
   */
  async getConventions(filter?: ConventionFilter): Promise<DetectedConvention[]> {
    const records = await this.memoryService.get(this.namespace, { scope: CONVENTION_SCOPE_KEY })
    let conventions = applyConventionFilters(records.map(r => recordToConvention(r)), filter)

    if (filter?.query && this.semanticStore) {
      conventions = await semanticRerank(this.semanticStore, filter.query, conventions)
    }
    return conventions
  }

  /**
   * Check code conformance against stored conventions.
   */
  async checkConformance(
    code: string,
    conventions?: DetectedConvention[],
  ): Promise<ConventionCheckResult> {
    const activeConventions = conventions ?? await this.getActiveConventions()
    if (activeConventions.length === 0) {
      return { conformanceScore: 1.0, followed: [], violated: [] }
    }
    return this.llm
      ? checkWithLLM(this.llm, code, activeConventions)
      : checkWithHeuristics(code, activeConventions)
  }

  /**
   * Set human verdict on a convention.
   * Confirmed: confidence set to 1.0, humanVerified = true
   * Rejected: confidence set to 0, humanVerified = false
   */
  async setHumanVerdict(conventionId: string, confirmed: boolean): Promise<void> {
    const existing = await findExistingConvention(this.memoryService, this.namespace, conventionId)
    if (!existing) return
    await storeConvention(this.memoryService, this.namespace, {
      ...existing,
      confidence: confirmed ? 1.0 : 0,
      humanVerified: confirmed,
    })
  }

  /**
   * Format conventions as markdown for system prompts.
   */
  async formatForPrompt(filter?: ConventionFilter): Promise<string> {
    const effectiveFilter: ConventionFilter = {
      ...filter,
      minConfidence: filter?.minConfidence ?? 0.5,
    }
    const conventions = await this.getConventions(effectiveFilter)
    return formatConventionsAsMarkdown(conventions, effectiveFilter)
  }

  /**
   * Consolidate: merge similar conventions, prune low-confidence ones.
   */
  async consolidate(options?: ConsolidateOptions): Promise<{ merged: number; pruned: number }> {
    const minConfidence = options?.minConfidence ?? 0.3
    const mergeSimilarity = options?.mergeSimilarity ?? 0.8

    const all = await this.getConventions()

    // Phase 1: merge similar conventions within each category
    const byCategory = new Map<string, DetectedConvention[]>()
    for (const c of all) {
      const arr = byCategory.get(c.category) ?? []
      arr.push(c)
      byCategory.set(c.category, arr)
    }

    let merged = 0
    const surviving = new Map<string, DetectedConvention>()
    for (const [, items] of byCategory) {
      const mergedItems = mergeSimilarConventions(items, mergeSimilarity)
      merged += items.length - mergedItems.length
      for (const item of mergedItems) surviving.set(item.id, item)
    }

    // Phase 2: prune low-confidence non-verified conventions
    let pruned = 0
    for (const [id, conv] of [...surviving]) {
      if (conv.confidence < minConfidence && conv.humanVerified !== true) {
        surviving.delete(id)
        pruned++
      }
    }

    // Tombstone everything that didn't survive (MemoryService has no delete).
    for (const conv of all) {
      if (!surviving.has(conv.id)) {
        await tombstoneConvention(this.memoryService, this.namespace, conv.id)
      }
    }

    // Persist surviving (possibly merged) conventions
    for (const conv of surviving.values()) {
      await storeConvention(this.memoryService, this.namespace, conv)
    }

    return { merged, pruned }
  }

  private async getActiveConventions(): Promise<DetectedConvention[]> {
    const all = await this.getConventions()
    return all.filter(c => c.confidence > 0 && c.humanVerified !== false)
  }
}
