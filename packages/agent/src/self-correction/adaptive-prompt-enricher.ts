/**
 * Adaptive Prompt Enricher — builds per-node enriched prompts from memory.
 *
 * Before each pipeline node executes, this module retrieves learned knowledge
 * (lessons, rules, quality baselines, past error warnings) from the store and
 * formats them into a markdown prompt section that can be prepended to the
 * node's system prompt.
 *
 * Priority ordering (highest first): rules > warnings > lessons > baselines.
 *
 * Usage:
 *   const enricher = new AdaptivePromptEnricher({ store })
 *   const enrichment = await enricher.enrich({ nodeId: 'gen_backend' })
 *   const systemPrompt = enrichment.content + '\n\n' + originalPrompt
 *
 * @module self-correction/adaptive-prompt-enricher
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Formatted enrichment result ready to prepend to a system prompt. */
export interface PromptEnrichment {
  /** Formatted prompt section to prepend to system prompt */
  content: string
  /** Number of items injected */
  itemCount: number
  /** Sources used */
  sources: string[]
  /** Estimated token count (chars/4) */
  estimatedTokens: number
}

/** Configuration for the AdaptivePromptEnricher. */
export interface EnricherConfig {
  /** Store for reading enrichment data */
  store: BaseStore
  /** Max total tokens for enrichment (default: 1000) */
  maxTokenBudget?: number
  /** Namespaces for different data sources */
  namespaces?: {
    lessons?: string[]
    rules?: string[]
    trajectories?: string[]
    errors?: string[]
  }
  /** Max items per source (default: 5) */
  maxItemsPerSource?: number
}

/** Parameters for the enrich method. */
export interface EnrichParams {
  nodeId: string
  taskType?: string
  riskClass?: string
  /** Current run context (e.g., feature name, tech stack) */
  context?: Record<string, string>
}

/** Parameters for the enrichWithBudget method. */
export interface EnrichWithBudgetParams {
  nodeId: string
  taskType?: string
  tokenBudget: number
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EnrichmentSection {
  heading: string
  items: string[]
  source: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars).trimEnd()
}

// ---------------------------------------------------------------------------
// AdaptivePromptEnricher
// ---------------------------------------------------------------------------

/**
 * Retrieves learned knowledge from multiple store namespaces and formats
 * it into a markdown prompt enrichment section for a specific pipeline node.
 */
export class AdaptivePromptEnricher {
  private readonly store: BaseStore
  private readonly maxTokenBudget: number
  private readonly maxItemsPerSource: number
  private readonly namespaces: {
    lessons: string[]
    rules: string[]
    trajectories: string[]
    errors: string[]
  }

  constructor(config: EnricherConfig) {
    this.store = config.store
    this.maxTokenBudget = config.maxTokenBudget ?? 1000
    this.maxItemsPerSource = config.maxItemsPerSource ?? 5
    this.namespaces = {
      lessons: config.namespaces?.lessons ?? ['lessons'],
      rules: config.namespaces?.rules ?? ['rules'],
      trajectories: config.namespaces?.trajectories ?? ['trajectories'],
      errors: config.namespaces?.errors ?? ['errors'],
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build an enriched prompt section for a specific pipeline node.
   * Combines lessons, rules, baselines, and warnings.
   */
  async enrich(params: EnrichParams): Promise<PromptEnrichment> {
    return this.buildEnrichment(params.nodeId, params.taskType, this.maxTokenBudget, params.riskClass, params.context)
  }

  /**
   * Build enrichment for a node, respecting an explicit token budget.
   * Prioritizes: rules > warnings > lessons > baselines
   */
  async enrichWithBudget(params: EnrichWithBudgetParams): Promise<PromptEnrichment> {
    return this.buildEnrichment(params.nodeId, params.taskType, params.tokenBudget)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async buildEnrichment(
    nodeId: string,
    taskType: string | undefined,
    tokenBudget: number,
    riskClass?: string,
    context?: Record<string, string>,
  ): Promise<PromptEnrichment> {
    // Gather all sections in parallel
    const [rules, errors, lessons, baselines] = await Promise.all([
      this.fetchRules(nodeId, taskType),
      this.fetchErrors(nodeId),
      this.fetchLessons(nodeId, taskType, riskClass, context),
      this.fetchBaselines(nodeId, taskType),
    ])

    // Priority ordering: rules > warnings > lessons > baselines
    const sections: EnrichmentSection[] = []
    if (rules.items.length > 0) sections.push(rules)
    if (errors.items.length > 0) sections.push(errors)
    if (lessons.items.length > 0) sections.push(lessons)
    if (baselines.items.length > 0) sections.push(baselines)

    if (sections.length === 0) {
      return { content: '', itemCount: 0, sources: [], estimatedTokens: 0 }
    }

    // Build markdown
    const parts: string[] = ['## Generation Context (from past runs)', '']
    let totalItems = 0
    const sources: string[] = []

    for (const section of sections) {
      parts.push(`### ${section.heading}`)
      for (const item of section.items) {
        parts.push(`- ${item}`)
        totalItems++
      }
      parts.push('')
      sources.push(section.source)
    }

    let content = parts.join('\n').trimEnd()

    // Truncate if exceeding budget
    content = truncateToTokenBudget(content, tokenBudget)

    return {
      content,
      itemCount: totalItems,
      sources,
      estimatedTokens: estimateTokens(content),
    }
  }

  // -------------------------------------------------------------------------
  // Source fetchers
  // -------------------------------------------------------------------------

  private async fetchRules(
    nodeId: string,
    taskType?: string,
  ): Promise<EnrichmentSection> {
    const items: string[] = []
    try {
      const results = await this.store.search(this.namespaces.rules, {
        limit: this.maxItemsPerSource * 3,
      })

      for (const item of results) {
        if (items.length >= this.maxItemsPerSource) break
        const value = item.value as Record<string, unknown>

        // Filter: rule must apply to this node (scope contains nodeId or is global)
        const scope = value['scope']
        if (scope !== undefined && scope !== null) {
          if (typeof scope === 'string' && !scope.includes(nodeId) && scope !== '*') continue
          if (Array.isArray(scope) && !(scope as string[]).includes(nodeId) && !(scope as string[]).includes('*')) continue
        }

        // Optionally filter by taskType
        if (taskType && value['taskType'] && value['taskType'] !== taskType) continue

        const text = typeof value['text'] === 'string'
          ? value['text']
          : typeof value['content'] === 'string'
            ? value['content']
            : typeof value['rule'] === 'string'
              ? value['rule']
              : null

        if (text) items.push(text)
      }
    } catch {
      // Store may be empty or unavailable
    }

    return { heading: 'Rules (must follow)', items, source: 'rules' }
  }

  private async fetchErrors(nodeId: string): Promise<EnrichmentSection> {
    const items: string[] = []
    try {
      const results = await this.store.search(this.namespaces.errors, {
        limit: this.maxItemsPerSource * 3,
      })

      for (const item of results) {
        if (items.length >= this.maxItemsPerSource) break
        const value = item.value as Record<string, unknown>

        // Filter: error must be for this node
        if (value['nodeId'] && value['nodeId'] !== nodeId) continue

        const text = typeof value['text'] === 'string'
          ? value['text']
          : typeof value['summary'] === 'string'
            ? value['summary']
            : typeof value['message'] === 'string'
              ? value['message']
              : null

        if (text) items.push(text)
      }
    } catch {
      // Store may be empty or unavailable
    }

    return { heading: 'Warnings (avoid past mistakes)', items, source: 'errors' }
  }

  private async fetchLessons(
    nodeId: string,
    taskType?: string,
    _riskClass?: string,
    _context?: Record<string, string>,
  ): Promise<EnrichmentSection> {
    const items: string[] = []
    try {
      const results = await this.store.search(this.namespaces.lessons, {
        limit: this.maxItemsPerSource * 3,
      })

      for (const item of results) {
        if (items.length >= this.maxItemsPerSource) break
        const value = item.value as Record<string, unknown>

        // Filter by nodeId if present
        if (value['nodeId'] && value['nodeId'] !== nodeId) continue

        // Filter by taskType if present
        if (taskType && value['taskType'] && value['taskType'] !== taskType) continue

        const text = typeof value['text'] === 'string'
          ? value['text']
          : typeof value['summary'] === 'string'
            ? value['summary']
            : typeof value['content'] === 'string'
              ? value['content']
              : null

        if (!text) continue

        // Include confidence if available
        const confidence = typeof value['confidence'] === 'number'
          ? value['confidence']
          : null

        if (confidence !== null) {
          items.push(`[${Math.round(confidence * 100)}%] ${text}`)
        } else {
          items.push(text)
        }
      }
    } catch {
      // Store may be empty or unavailable
    }

    return { heading: 'Lessons (guidance)', items, source: 'lessons' }
  }

  private async fetchBaselines(
    nodeId: string,
    _taskType?: string,
  ): Promise<EnrichmentSection> {
    const items: string[] = []
    try {
      const ns = [...this.namespaces.trajectories, 'steps', nodeId]
      const results = await this.store.search(ns, {
        limit: 100,
      })

      if (results.length === 0) {
        return { heading: 'Quality Expectations', items: [], source: 'trajectories' }
      }

      // Compute average quality score
      const scores: number[] = []
      for (const item of results) {
        const value = item.value as Record<string, unknown>
        // Optionally filter by taskType via runId cross-reference — skip for now
        // since trajectory steps don't always carry taskType
        const score = typeof value['qualityScore'] === 'number'
          ? value['qualityScore']
          : null
        if (score !== null) scores.push(score)
      }

      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length
        items.push(`Historical average score for this node: ${avg.toFixed(2)}/1.0`)
      }
    } catch {
      // Store may be empty or unavailable
    }

    return { heading: 'Quality Expectations', items, source: 'trajectories' }
  }
}
