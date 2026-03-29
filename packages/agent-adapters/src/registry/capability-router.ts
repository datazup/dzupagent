/**
 * Capability-based routing strategy.
 *
 * Routes tasks to providers by scoring them against a capability matrix
 * that captures each provider's strengths: context window, reasoning,
 * code execution, speed, cost, and special capabilities.
 */

import type {
  AdapterProviderId,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tags describing special provider capabilities */
export type ProviderCapabilityTag =
  | 'long-context'
  | 'multimodal'
  | 'multilingual'
  | 'code-execution'
  | 'local'
  | 'reasoning'
  | 'fast'
  | 'cost-effective'

/** Capability profile for a single provider */
export interface ProviderCapability {
  providerId: AdapterProviderId
  /** Maximum context window in tokens */
  maxContextTokens: number
  /** Relative reasoning strength (0-1) */
  reasoningStrength: number
  /** Relative code execution strength (0-1) */
  executionStrength: number
  /** Relative speed (0-1, higher = faster) */
  speed: number
  /** Relative cost efficiency (0-1, higher = cheaper) */
  costEfficiency: number
  /** Special capabilities */
  capabilities: Set<ProviderCapabilityTag>
  /** Whether this provider requires internet */
  requiresNetwork: boolean
}

/** Configuration overrides for the CapabilityRouter */
export interface CapabilityRouterConfig {
  /** Override default provider capabilities */
  capabilities?: Partial<Record<AdapterProviderId, Partial<ProviderCapability>>>
  /** Custom tag-to-capability mapping overrides */
  tagMappings?: Record<string, ProviderCapabilityTag[]>
}

// ---------------------------------------------------------------------------
// Default capability matrix
// ---------------------------------------------------------------------------

function defaultCapabilities(): Map<AdapterProviderId, ProviderCapability> {
  const caps = new Map<AdapterProviderId, ProviderCapability>()

  caps.set('claude', {
    providerId: 'claude',
    maxContextTokens: 200_000,
    reasoningStrength: 0.95,
    executionStrength: 0.7,
    speed: 0.6,
    costEfficiency: 0.3,
    capabilities: new Set<ProviderCapabilityTag>(['reasoning']),
    requiresNetwork: true,
  })

  caps.set('codex', {
    providerId: 'codex',
    maxContextTokens: 128_000,
    reasoningStrength: 0.7,
    executionStrength: 0.95,
    speed: 0.7,
    costEfficiency: 0.4,
    capabilities: new Set<ProviderCapabilityTag>(['code-execution']),
    requiresNetwork: true,
  })

  caps.set('gemini', {
    providerId: 'gemini',
    maxContextTokens: 1_000_000,
    reasoningStrength: 0.8,
    executionStrength: 0.6,
    speed: 0.7,
    costEfficiency: 0.6,
    capabilities: new Set<ProviderCapabilityTag>(['long-context', 'multimodal']),
    requiresNetwork: true,
  })

  caps.set('qwen', {
    providerId: 'qwen',
    maxContextTokens: 128_000,
    reasoningStrength: 0.65,
    executionStrength: 0.6,
    speed: 0.8,
    costEfficiency: 0.85,
    capabilities: new Set<ProviderCapabilityTag>(['multilingual', 'cost-effective']),
    requiresNetwork: true,
  })

  caps.set('crush', {
    providerId: 'crush',
    maxContextTokens: 32_000,
    reasoningStrength: 0.4,
    executionStrength: 0.5,
    speed: 0.95,
    costEfficiency: 1.0,
    capabilities: new Set<ProviderCapabilityTag>(['local', 'fast', 'cost-effective']),
    requiresNetwork: false,
  })

  return caps
}

// ---------------------------------------------------------------------------
// Default tag → capability-tag mappings
// ---------------------------------------------------------------------------

/** Maps user-facing task tags to the capability tags they imply */
const DEFAULT_TAG_MAPPINGS: ReadonlyMap<string, readonly ProviderCapabilityTag[]> = new Map<
  string,
  ProviderCapabilityTag[]
>([
  // Long context
  ['large-codebase', ['long-context']],
  ['migration', ['long-context']],
  ['analyze-all', ['long-context']],

  // Multilingual
  ['translate', ['multilingual']],
  ['i18n', ['multilingual']],
  ['multilingual', ['multilingual']],

  // Code execution
  ['implement', ['code-execution']],
  ['fix-tests', ['code-execution']],
  ['debug', ['code-execution']],
  ['build', ['code-execution']],

  // Reasoning
  ['review', ['reasoning']],
  ['architecture', ['reasoning']],
  ['refactor', ['reasoning']],
  ['explain', ['reasoning']],

  // Local / offline
  ['local', ['local']],
  ['private', ['local']],
  ['offline', ['local']],

  // Fast
  ['quick', ['fast']],
  ['simple', ['fast']],
  ['fast', ['fast']],

  // Cost
  ['budget', ['cost-effective']],
  ['cheap', ['cost-effective']],
])

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

/**
 * Weight applied when a provider has a required capability tag.
 * "Required" means the task cannot be fulfilled without it (e.g. `local`).
 */
const REQUIRED_TAG_WEIGHT = 30

/**
 * Weight applied when a provider has a preferred capability tag.
 * "Preferred" means the task benefits from it but can work without it.
 */
const PREFERRED_TAG_WEIGHT = 15

/** Bonus per additional matching capability (rewards generalists) */
const MULTI_MATCH_BONUS = 5

/** Weight for the reasoning strength score (when task requires reasoning) */
const REASONING_WEIGHT = 20

/** Weight for execution strength score (when task requires execution) */
const EXECUTION_WEIGHT = 20

/** Weight for cost efficiency (when budget is constrained) */
const BUDGET_WEIGHT = 25

// ---------------------------------------------------------------------------
// Capability tag classification: required vs preferred
// ---------------------------------------------------------------------------

/** Tags that represent hard requirements — provider MUST have them */
const REQUIRED_TAGS: ReadonlySet<ProviderCapabilityTag> = new Set<ProviderCapabilityTag>([
  'local',
  'long-context',
])

// ---------------------------------------------------------------------------
// CapabilityRouter
// ---------------------------------------------------------------------------

/**
 * Routes tasks to the best-fit provider based on a detailed capability matrix.
 *
 * Scoring considers:
 * 1. Matching capability tags (required and preferred)
 * 2. Reasoning / execution strength flags
 * 3. Budget constraints mapped to cost efficiency
 * 4. Multi-match bonus for providers that cover many needs
 */
export class CapabilityRouter implements TaskRoutingStrategy {
  readonly name = 'capability-based'

  private readonly capabilities: Map<AdapterProviderId, ProviderCapability>
  private readonly tagMappings: Map<string, ProviderCapabilityTag[]>

  constructor(config?: CapabilityRouterConfig) {
    // Build capability map from defaults + overrides
    this.capabilities = defaultCapabilities()

    if (config?.capabilities) {
      for (const [id, overrides] of Object.entries(config.capabilities)) {
        const providerId = id as AdapterProviderId
        const existing = this.capabilities.get(providerId)
        if (existing && overrides) {
          this.capabilities.set(providerId, mergeCapability(existing, overrides))
        }
      }
    }

    // Build tag mapping from defaults + overrides
    this.tagMappings = new Map<string, ProviderCapabilityTag[]>()
    for (const [tag, caps] of DEFAULT_TAG_MAPPINGS) {
      this.tagMappings.set(tag, [...caps])
    }
    if (config?.tagMappings) {
      for (const [tag, caps] of Object.entries(config.tagMappings)) {
        this.tagMappings.set(tag.toLowerCase(), caps)
      }
    }
  }

  /** Route a task to the best available provider based on capability scoring */
  route(task: TaskDescriptor, availableProviders: AdapterProviderId[]): RoutingDecision {
    // Respect explicit preference if available
    if (task.preferredProvider && availableProviders.includes(task.preferredProvider)) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" is available`,
        fallbackProviders: availableProviders.filter((p) => p !== task.preferredProvider),
        confidence: 0.95,
      }
    }

    if (availableProviders.length === 0) {
      return {
        provider: 'auto',
        reason: 'No adapters available for capability-based routing',
        fallbackProviders: [],
        confidence: 0,
      }
    }

    // Determine required capability tags from task tags
    const requiredTags = new Set<ProviderCapabilityTag>()
    const preferredTags = new Set<ProviderCapabilityTag>()

    for (const tag of task.tags) {
      const mapped = this.tagMappings.get(tag.toLowerCase())
      if (mapped) {
        for (const capTag of mapped) {
          if (REQUIRED_TAGS.has(capTag)) {
            requiredTags.add(capTag)
          } else {
            preferredTags.add(capTag)
          }
        }
      }
    }

    // Add implicit tags from task flags
    if (task.requiresReasoning) {
      preferredTags.add('reasoning')
    }
    if (task.requiresExecution) {
      preferredTags.add('code-execution')
    }

    // Score each available provider
    const scored: Array<{ provider: AdapterProviderId; score: number; reasons: string[] }> = []

    for (const providerId of availableProviders) {
      const cap = this.capabilities.get(providerId)
      if (!cap) {
        scored.push({ provider: providerId, score: 0, reasons: ['unknown provider'] })
        continue
      }

      let score = 0
      const reasons: string[] = []

      // Check required tags — provider must have ALL of them
      let meetsRequirements = true
      for (const reqTag of requiredTags) {
        if (cap.capabilities.has(reqTag)) {
          score += REQUIRED_TAG_WEIGHT
          reasons.push(`has required "${reqTag}"`)
        } else {
          meetsRequirements = false
        }
      }

      // If provider fails a hard requirement, heavily penalise
      if (!meetsRequirements) {
        score -= 100
        reasons.push('missing required capability')
      }

      // Check preferred tags
      let matchCount = 0
      for (const prefTag of preferredTags) {
        if (cap.capabilities.has(prefTag)) {
          score += PREFERRED_TAG_WEIGHT
          matchCount++
          reasons.push(`has preferred "${prefTag}"`)
        }
      }

      // Multi-match bonus
      if (matchCount > 1) {
        score += (matchCount - 1) * MULTI_MATCH_BONUS
      }

      // Reasoning strength contribution
      if (task.requiresReasoning || preferredTags.has('reasoning')) {
        score += cap.reasoningStrength * REASONING_WEIGHT
        reasons.push(`reasoning=${cap.reasoningStrength.toFixed(2)}`)
      }

      // Execution strength contribution
      if (task.requiresExecution || preferredTags.has('code-execution')) {
        score += cap.executionStrength * EXECUTION_WEIGHT
        reasons.push(`execution=${cap.executionStrength.toFixed(2)}`)
      }

      // Budget constraint contribution
      if (task.budgetConstraint === 'low') {
        score += cap.costEfficiency * BUDGET_WEIGHT
        reasons.push(`cost-efficiency=${cap.costEfficiency.toFixed(2)}`)
      } else if (task.budgetConstraint === 'medium') {
        score += cap.costEfficiency * (BUDGET_WEIGHT * 0.5)
      }

      scored.push({ provider: providerId, score, reasons })
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]!
    const fallbacks = scored.slice(1).map((s) => s.provider)

    // Compute confidence: based on score gap between best and second-best
    const confidence = computeConfidence(scored)

    return {
      provider: best.provider,
      reason: `Capability routing — ${best.reasons.join(', ')}`,
      fallbackProviders: fallbacks,
      confidence,
    }
  }

  /** Get the capability profile for a provider */
  getCapabilities(providerId: AdapterProviderId): ProviderCapability {
    const cap = this.capabilities.get(providerId)
    if (!cap) {
      throw new Error(`No capability profile for provider "${providerId}"`)
    }
    // Return a copy to prevent external mutation
    return {
      ...cap,
      capabilities: new Set(cap.capabilities),
    }
  }

  /** Update capabilities for a provider at runtime */
  updateCapabilities(providerId: AdapterProviderId, updates: Partial<ProviderCapability>): void {
    const existing = this.capabilities.get(providerId)
    if (!existing) {
      throw new Error(`No capability profile for provider "${providerId}"`)
    }
    this.capabilities.set(providerId, mergeCapability(existing, updates))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge partial capability updates into an existing profile */
function mergeCapability(
  base: ProviderCapability,
  overrides: Partial<ProviderCapability>,
): ProviderCapability {
  return {
    providerId: overrides.providerId ?? base.providerId,
    maxContextTokens: overrides.maxContextTokens ?? base.maxContextTokens,
    reasoningStrength: overrides.reasoningStrength ?? base.reasoningStrength,
    executionStrength: overrides.executionStrength ?? base.executionStrength,
    speed: overrides.speed ?? base.speed,
    costEfficiency: overrides.costEfficiency ?? base.costEfficiency,
    capabilities: overrides.capabilities
      ? new Set(overrides.capabilities)
      : new Set(base.capabilities),
    requiresNetwork: overrides.requiresNetwork ?? base.requiresNetwork,
  }
}

/**
 * Compute a confidence value in [0, 1] based on how decisive the ranking is.
 *
 * - If only one provider, confidence is moderate (0.7).
 * - Otherwise, based on the gap between 1st and 2nd place relative to 1st.
 */
function computeConfidence(
  scored: ReadonlyArray<{ provider: AdapterProviderId; score: number }>,
): number {
  if (scored.length === 0) return 0
  if (scored.length === 1) return 0.7

  const bestScore = scored[0]!.score
  const secondScore = scored[1]!.score

  // Avoid division by zero when bestScore is 0
  if (bestScore <= 0) return 0.3

  // Gap ratio: how much better the best is than second
  const gap = (bestScore - secondScore) / bestScore

  // Map gap to confidence: no gap → 0.4, large gap → 0.95
  return Math.min(0.4 + gap * 0.55, 0.95)
}
