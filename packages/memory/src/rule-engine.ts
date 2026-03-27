/**
 * DynamicRuleEngine — auto-generate behavioral rules from error patterns.
 *
 * Learns rules from errors, conventions, human input, and evals, then
 * retrieves and formats them for prompt injection. Includes Jaccard-based
 * deduplication, confidence decay, and application tracking.
 *
 * Usage:
 *   const engine = new DynamicRuleEngine({ store })
 *   const rule = await engine.learnFromError({ errorType: 'ValidationError', ... })
 *   const rules = await engine.getRulesForContext({ nodeId: 'gen_backend' })
 *   const prompt = engine.formatForPrompt(rules)
 */
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source from which a rule was derived */
export type RuleSource = 'error' | 'convention' | 'human' | 'eval'

/** A behavioral rule that can be injected into prompts */
export interface Rule {
  id: string
  /** Where this rule came from */
  source: RuleSource
  /** Natural language rule content */
  content: string
  /** Scope: which nodes/task types this applies to */
  scope: string[]
  /** Confidence 0-1, decays if not applied successfully */
  confidence: number
  /** How many times this rule was applied */
  applyCount: number
  /** Success rate when applied (0-1) */
  successRate: number
  createdAt: string
  lastAppliedAt?: string
}

export interface RuleEngineConfig {
  /** Store for persistence */
  store: BaseStore
  /** Namespace (default: ['rules']) */
  namespace?: string[]
  /** Minimum confidence to include in prompts (default: 0.5) */
  minConfidence?: number
  /** Max rules per context (default: 10) */
  maxRulesPerContext?: number
  /** Jaccard similarity threshold for dedup (default: 0.7) */
  dedupThreshold?: number
}

export interface LearnFromErrorParams {
  errorType: string
  errorMessage: string
  resolution: string
  nodeId: string
  taskType?: string
}

export interface AddRuleParams {
  content: string
  scope: string[]
  source?: 'human' | 'convention'
  confidence?: number
}

export interface GetRulesParams {
  nodeId?: string
  taskType?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Helpers
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

/** Generate a rule ID with timestamp and random suffix */
function generateRuleId(): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `rule_${Date.now()}_${suffix}`
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Convert a Rule to a plain record for BaseStore */
function ruleToRecord(rule: Rule): Record<string, unknown> {
  return {
    id: rule.id,
    source: rule.source,
    content: rule.content,
    scope: rule.scope,
    confidence: rule.confidence,
    applyCount: rule.applyCount,
    successRate: rule.successRate,
    createdAt: rule.createdAt,
    lastAppliedAt: rule.lastAppliedAt ?? null,
    // text field for searchability
    text: rule.content,
  }
}

/** Reconstruct a Rule from a plain store record */
function recordToRule(value: Record<string, unknown>): Rule | null {
  if (typeof value['id'] !== 'string' || typeof value['content'] !== 'string') {
    return null
  }
  return {
    id: value['id'] as string,
    source: (value['source'] as RuleSource) ?? 'human',
    content: value['content'] as string,
    scope: Array.isArray(value['scope']) ? (value['scope'] as string[]) : [],
    confidence: typeof value['confidence'] === 'number' ? value['confidence'] : 0.5,
    applyCount: typeof value['applyCount'] === 'number' ? value['applyCount'] : 0,
    successRate: typeof value['successRate'] === 'number' ? value['successRate'] : 1,
    createdAt: (value['createdAt'] as string) ?? new Date().toISOString(),
    lastAppliedAt: typeof value['lastAppliedAt'] === 'string'
      ? value['lastAppliedAt']
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// DynamicRuleEngine
// ---------------------------------------------------------------------------

export class DynamicRuleEngine {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly minConfidence: number
  private readonly maxRulesPerContext: number
  private readonly dedupThreshold: number

  constructor(config: RuleEngineConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['rules']
    this.minConfidence = config.minConfidence ?? 0.5
    this.maxRulesPerContext = config.maxRulesPerContext ?? 10
    this.dedupThreshold = config.dedupThreshold ?? 0.7
  }

  // ---------- learnFromError -------------------------------------------------

  /**
   * Generate a rule from an error and its resolution.
   * Template-based (no LLM calls).
   */
  async learnFromError(params: LearnFromErrorParams): Promise<Rule> {
    const { errorType, errorMessage: _errorMessage, resolution, nodeId, taskType } = params

    const content = `When ${errorType} occurs at ${nodeId}: ${resolution}`
    const scope = [nodeId]
    if (taskType) scope.push(taskType)

    const rule: Rule = {
      id: generateRuleId(),
      source: 'error',
      content,
      scope,
      confidence: 0.7,
      applyCount: 0,
      successRate: 1,
      createdAt: new Date().toISOString(),
    }

    await this.storeWithDedup(rule)
    return rule
  }

  // ---------- addRule --------------------------------------------------------

  /**
   * Add a human-defined or convention-based rule.
   */
  async addRule(params: AddRuleParams): Promise<Rule> {
    const { content, scope, source = 'human', confidence = 0.8 } = params

    const rule: Rule = {
      id: generateRuleId(),
      source,
      content,
      scope,
      confidence: Math.min(1.0, Math.max(0, confidence)),
      applyCount: 0,
      successRate: 1,
      createdAt: new Date().toISOString(),
    }

    await this.storeWithDedup(rule)
    return rule
  }

  // ---------- getRulesForContext ----------------------------------------------

  /**
   * Retrieve applicable rules for a given context.
   * Filters by scope match and minimum confidence, then sorts by
   * confidence * successRate descending.
   */
  async getRulesForContext(params: GetRulesParams): Promise<Rule[]> {
    const { nodeId, taskType, limit } = params
    const effectiveLimit = limit ?? this.maxRulesPerContext

    const allRules = await this.loadAllRules()

    // Filter by scope match and minimum confidence
    const matched = allRules.filter(rule => {
      if (rule.confidence < this.minConfidence) return false

      // If no filters provided, return all above minConfidence
      if (!nodeId && !taskType) return true

      const scopeLower = rule.scope.map(s => s.toLowerCase())
      if (nodeId && scopeLower.includes(nodeId.toLowerCase())) return true
      if (taskType && scopeLower.includes(taskType.toLowerCase())) return true

      return false
    })

    // Sort by confidence * successRate descending
    matched.sort((a, b) => {
      const scoreA = a.confidence * a.successRate
      const scoreB = b.confidence * b.successRate
      return scoreB - scoreA
    })

    return matched.slice(0, effectiveLimit)
  }

  // ---------- formatForPrompt ------------------------------------------------

  /**
   * Format rules as a markdown bullet list for prompt injection.
   */
  formatForPrompt(rules: Rule[]): string {
    if (rules.length === 0) return ''

    const lines = rules.map(rule => {
      const pct = Math.round(rule.confidence * 100)
      return `- [${pct}%] ${rule.content}`
    })

    return `## Dynamic Rules\n\n${lines.join('\n')}`
  }

  // ---------- recordApplication ----------------------------------------------

  /**
   * Record that a rule was applied and whether it helped.
   * Updates applyCount, successRate (running average), and lastAppliedAt.
   */
  async recordApplication(ruleId: string, success: boolean): Promise<void> {
    try {
      const item = await this.store.get(this.namespace, ruleId)
      if (!item) return

      const value = item.value as Record<string, unknown>
      const rule = recordToRule(value)
      if (!rule) return

      // Running average: new rate = (old rate * old count + new result) / (old count + 1)
      const oldTotal = rule.applyCount
      const oldSuccesses = Math.round(rule.successRate * oldTotal)
      const newSuccesses = oldSuccesses + (success ? 1 : 0)
      rule.applyCount = oldTotal + 1
      rule.successRate = rule.applyCount > 0 ? newSuccesses / rule.applyCount : 1
      rule.lastAppliedAt = new Date().toISOString()

      await this.store.put(this.namespace, ruleId, ruleToRecord(rule))
    } catch {
      // Non-fatal — recording application is best-effort
    }
  }

  // ---------- decayStaleRules ------------------------------------------------

  /**
   * Decay confidence for rules not applied recently.
   * Call periodically (e.g., after consolidation).
   * Returns count of decayed rules. Deletes rules with confidence < 0.1.
   */
  async decayStaleRules(maxAgeDays = 30, decayFactor = 0.9): Promise<number> {
    try {
      const allRules = await this.loadAllRules()
      const now = Date.now()
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
      let decayedCount = 0

      for (const rule of allRules) {
        const lastActivity = rule.lastAppliedAt
          ? new Date(rule.lastAppliedAt).getTime()
          : new Date(rule.createdAt).getTime()

        const age = now - lastActivity
        if (age <= maxAgeMs) continue

        rule.confidence *= decayFactor
        decayedCount++

        if (rule.confidence < 0.1) {
          await this.store.delete(this.namespace, rule.id)
        } else {
          await this.store.put(this.namespace, rule.id, ruleToRecord(rule))
        }
      }

      return decayedCount
    } catch {
      return 0
    }
  }

  // ---------- count ----------------------------------------------------------

  /**
   * Get total rule count in the store.
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
   * Load all rules from the store.
   */
  private async loadAllRules(): Promise<Rule[]> {
    try {
      const items = await this.store.search(this.namespace, { limit: 1000 })
      const rules: Rule[] = []
      for (const item of items) {
        const rule = recordToRule(item.value as Record<string, unknown>)
        if (rule) rules.push(rule)
      }
      return rules
    } catch {
      return []
    }
  }

  /**
   * Store a rule after checking for duplicates.
   * If a similar rule exists (Jaccard >= threshold), merge by boosting
   * the existing rule's confidence instead of creating a new entry.
   */
  private async storeWithDedup(rule: Rule): Promise<void> {
    try {
      const existing = await this.loadAllRules()
      const newTokens = tokenize(rule.content)

      for (const existingRule of existing) {
        const existingTokens = tokenize(existingRule.content)
        const similarity = jaccardSimilarity(newTokens, existingTokens)

        if (similarity >= this.dedupThreshold) {
          // Merge: boost confidence of existing rule
          existingRule.confidence = Math.min(1.0, existingRule.confidence + 0.1)
          await this.store.put(
            this.namespace,
            existingRule.id,
            ruleToRecord(existingRule),
          )
          // Update the new rule's id/confidence for the caller
          rule.id = existingRule.id
          rule.confidence = existingRule.confidence
          return
        }
      }

      // No duplicate found — store as new
      await this.store.put(this.namespace, rule.id, ruleToRecord(rule))
    } catch {
      // Non-fatal — rule storage failures should not break pipelines
    }
  }
}
