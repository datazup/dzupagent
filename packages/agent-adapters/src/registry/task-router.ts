/**
 * Task routing strategies for selecting the best adapter for a given task.
 *
 * Built-in strategies:
 * - TagBasedRouter: routes by task tags (reasoning→claude, execute→codex, etc.)
 * - CostOptimizedRouter: routes to cheapest available adapter
 * - RoundRobinRouter: distributes evenly across healthy adapters
 * - CompositeRouter: combines multiple strategies with weights
 */

import type {
  AdapterProviderId,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

// --- Tag mapping constants ---

/** Tags that indicate reasoning-heavy tasks (best suited for Claude) */
const REASONING_TAGS = new Set([
  'reasoning',
  'review',
  'architecture',
  'design',
  'analysis',
  'planning',
  'refactor',
  'explain',
])

/** Tags that indicate execution-heavy tasks (best suited for Codex) */
const EXECUTION_TAGS = new Set([
  'fix-tests',
  'implement',
  'execute',
  'code',
  'build',
  'debug',
  'test',
  'migrate',
])

/** Tags that indicate local/offline tasks (best suited for Crush or Qwen) */
const LOCAL_TAGS = new Set([
  'local',
  'offline',
  'private',
  'fast',
  'simple',
  'quick',
])

/**
 * Approximate relative cost ranking (lower = cheaper).
 * Used by CostOptimizedRouter.
 */
const COST_RANK: Record<AdapterProviderId, number> = {
  crush: 1,
  goose: 2,
  qwen: 3,
  gemini: 4,
  'gemini-sdk': 4,
  codex: 5,
  claude: 6,
  openrouter: 6,
  openai: 5,
}

/**
 * Default priority ranking when no tag-based signal is available.
 * Higher = more preferred.
 */
const DEFAULT_PRIORITY: Record<AdapterProviderId, number> = {
  claude: 5,
  codex: 4,
  gemini: 3,
  'gemini-sdk': 3,
  qwen: 2,
  crush: 1,
  goose: 3,
  openrouter: 4,
  openai: 4,
}

// --- Helpers ---

function buildFallbacks(
  primary: AdapterProviderId,
  available: AdapterProviderId[],
): AdapterProviderId[] {
  return available.filter((id) => id !== primary)
}

function hasTagOverlap(tags: readonly string[], set: Set<string>): boolean {
  return tags.some((tag) => set.has(tag.toLowerCase()))
}

// --- Strategies ---

/**
 * Routes tasks based on tag matching.
 *
 * - reasoning/review/architecture tags → claude
 * - fix-tests/implement/execute tags → codex
 * - local/offline tags → crush or qwen
 * - requiresReasoning flag → claude
 * - requiresExecution flag → codex
 * - preferredProvider override → that provider (if available)
 * - default → highest priority healthy adapter
 */
export class TagBasedRouter implements TaskRoutingStrategy {
  readonly name = 'tag-based'

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    // Respect explicit preference if the provider is available
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" is available`,
        fallbackProviders: buildFallbacks(task.preferredProvider, availableProviders),
        confidence: 0.95,
      }
    }

    const tags = task.tags.map((t) => t.toLowerCase())

    // Reasoning tags → claude
    if (hasTagOverlap(tags, REASONING_TAGS) || task.requiresReasoning) {
      const target = this.pickFromAvailable('claude', availableProviders)
      if (target) {
        return {
          provider: target,
          reason: 'Task requires deep reasoning — routed to claude',
          fallbackProviders: buildFallbacks(target, availableProviders),
          confidence: 0.85,
        }
      }
    }

    // Execution tags → codex
    if (hasTagOverlap(tags, EXECUTION_TAGS) || task.requiresExecution) {
      const target = this.pickFromAvailable('codex', availableProviders)
      if (target) {
        return {
          provider: target,
          reason: 'Task is execution-focused — routed to codex',
          fallbackProviders: buildFallbacks(target, availableProviders),
          confidence: 0.8,
        }
      }
    }

    // Local/offline tags → crush or qwen
    if (hasTagOverlap(tags, LOCAL_TAGS)) {
      const target =
        this.pickFromAvailable('crush', availableProviders) ??
        this.pickFromAvailable('qwen', availableProviders)
      if (target) {
        return {
          provider: target,
          reason: 'Task prefers local execution — routed to local adapter',
          fallbackProviders: buildFallbacks(target, availableProviders),
          confidence: 0.75,
        }
      }
    }

    // Low budget constraint → prefer cheaper providers
    if (task.budgetConstraint === 'low') {
      const sorted = [...availableProviders].sort(
        (a, b) => (COST_RANK[a] ?? 99) - (COST_RANK[b] ?? 99),
      )
      const cheapest = sorted[0]
      if (cheapest) {
        return {
          provider: cheapest,
          reason: 'Low budget constraint — routed to cheapest adapter',
          fallbackProviders: sorted.slice(1),
          confidence: 0.7,
        }
      }
    }

    // Default: highest priority healthy adapter
    return this.defaultDecision(availableProviders)
  }

  private pickFromAvailable(
    preferred: AdapterProviderId,
    available: AdapterProviderId[],
  ): AdapterProviderId | undefined {
    return available.includes(preferred) ? preferred : undefined
  }

  private defaultDecision(availableProviders: AdapterProviderId[]): RoutingDecision {
    const sorted = [...availableProviders].sort(
      (a, b) => (DEFAULT_PRIORITY[b] ?? 0) - (DEFAULT_PRIORITY[a] ?? 0),
    )
    const primary = sorted[0]
    if (!primary) {
      return {
        provider: 'auto',
        reason: 'No adapters available',
        fallbackProviders: [],
        confidence: 0,
      }
    }
    return {
      provider: primary,
      reason: `Default routing — highest priority adapter "${primary}"`,
      fallbackProviders: sorted.slice(1),
      confidence: 0.5,
    }
  }
}

/**
 * Routes to the cheapest available adapter.
 * Uses a static cost ranking; override via constructor for custom rankings.
 */
export class CostOptimizedRouter implements TaskRoutingStrategy {
  readonly name = 'cost-optimized'
  private readonly costRank: Record<string, number>

  constructor(costRank?: Partial<Record<AdapterProviderId, number>>) {
    this.costRank = { ...COST_RANK, ...costRank }
  }

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    // Respect explicit preference even in cost-optimized mode
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" overrides cost optimization`,
        fallbackProviders: buildFallbacks(task.preferredProvider, availableProviders),
        confidence: 0.9,
      }
    }

    const sorted = [...availableProviders].sort(
      (a, b) => (this.costRank[a] ?? 99) - (this.costRank[b] ?? 99),
    )

    const cheapest = sorted[0]
    if (!cheapest) {
      return {
        provider: 'auto',
        reason: 'No adapters available for cost-optimized routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    return {
      provider: cheapest,
      reason: `Cost-optimized — selected cheapest adapter "${cheapest}"`,
      fallbackProviders: sorted.slice(1),
      confidence: 0.8,
    }
  }
}

/**
 * Distributes tasks evenly across healthy adapters using round-robin.
 */
export class RoundRobinRouter implements TaskRoutingStrategy {
  readonly name = 'round-robin'
  private counter = 0

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" overrides round-robin`,
        fallbackProviders: buildFallbacks(task.preferredProvider, availableProviders),
        confidence: 0.9,
      }
    }

    if (availableProviders.length === 0) {
      return {
        provider: 'auto',
        reason: 'No adapters available for round-robin routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    const index = this.counter % availableProviders.length
    this.counter++

    const selected = availableProviders[index]!
    return {
      provider: selected,
      reason: `Round-robin — selected "${selected}" (iteration ${this.counter})`,
      fallbackProviders: buildFallbacks(selected, availableProviders),
      confidence: 0.6,
    }
  }

  /** Reset the internal counter (useful for testing). */
  reset(): void {
    this.counter = 0
  }
}

/**
 * Entry for a weighted strategy in the composite router.
 */
export interface WeightedStrategy {
  strategy: TaskRoutingStrategy
  /** Weight in [0, 1]. Higher weight = more influence on final decision. */
  weight: number
}

/**
 * Combines multiple routing strategies with weights.
 *
 * Each strategy votes for a provider. The provider with the highest
 * weighted confidence score wins.
 */
export class CompositeRouter implements TaskRoutingStrategy {
  readonly name = 'composite'
  private readonly strategies: WeightedStrategy[]

  constructor(strategies: WeightedStrategy[]) {
    if (strategies.length === 0) {
      throw new Error('CompositeRouter requires at least one strategy')
    }
    this.strategies = strategies
  }

  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    if (availableProviders.length === 0) {
      return {
        provider: 'auto',
        reason: 'No adapters available for composite routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    // Collect weighted votes from each strategy
    const scores = new Map<AdapterProviderId | 'auto', number>()
    const reasons: string[] = []

    for (const { strategy, weight } of this.strategies) {
      const decision = strategy.route(task, availableProviders)
      const key = decision.provider
      const current = scores.get(key) ?? 0
      scores.set(key, current + decision.confidence * weight)
      reasons.push(`${strategy.name}: ${decision.provider} (${(decision.confidence * 100).toFixed(0)}%)`)
    }

    // Find the provider with highest weighted score
    let bestProvider: AdapterProviderId | 'auto' = 'auto'
    let bestScore = -1

    for (const [provider, score] of scores) {
      if (score > bestScore) {
        bestScore = score
        bestProvider = provider
      }
    }

    // Normalize confidence to [0, 1]
    const totalWeight = this.strategies.reduce((sum, s) => sum + s.weight, 0)
    const normalizedConfidence = totalWeight > 0 ? Math.min(bestScore / totalWeight, 1) : 0

    const fallbacks = bestProvider !== 'auto'
      ? buildFallbacks(bestProvider, availableProviders)
      : [...availableProviders]

    return {
      provider: bestProvider,
      reason: `Composite routing — ${reasons.join('; ')}`,
      fallbackProviders: fallbacks,
      confidence: normalizedConfidence,
    }
  }
}
