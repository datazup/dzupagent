/**
 * Specialist Registry — maps feature categories to specialist configurations
 * that tune the generation pipeline per feature type.
 *
 * Different feature types (auth, payments, CRUD, dashboard) have different
 * quality requirements, error patterns, and optimal generation strategies.
 * This registry provides the configuration layer that drives those differences.
 *
 * Uses `BaseStore` from `@langchain/langgraph` for optional dynamic overrides.
 * Pure configuration — no LLM calls.
 *
 * @module self-correction/specialist-registry
 */

import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Model tier for generation nodes. */
export type ModelTier = 'fast' | 'balanced' | 'powerful'

/** Verification strategy for quality checks. */
export type SpecialistVerificationStrategy = 'single' | 'vote' | 'debate' | 'consensus'

/** Risk class that modifies base specialist configuration. */
export type RiskClass = 'critical' | 'sensitive' | 'standard' | 'cosmetic'

/** Configuration for a feature category specialist. */
export interface SpecialistConfig {
  /** Feature category this config applies to. */
  category: string
  /** Preferred model tier for generation nodes. */
  modelTier: ModelTier
  /** Reflection loop depth (0 = none, 1-5 iterations). */
  reflectionDepth: number
  /** Verification strategy. */
  verificationStrategy: SpecialistVerificationStrategy
  /** Max fix attempts before giving up. */
  maxFixAttempts: number
  /** Quality threshold for this feature type (0-1). */
  qualityThreshold: number
  /** Additional prompt instructions specific to this category. */
  customInstructions?: string
  /** Node-level overrides (e.g., gen_backend needs more reflection for auth). */
  nodeOverrides?: Record<string, Partial<{
    modelTier: ModelTier
    reflectionDepth: number
    qualityThreshold: number
  }>>
}

/** Resolved node-level configuration. */
export interface NodeConfig {
  modelTier: ModelTier
  reflectionDepth: number
  qualityThreshold: number
}

/** Configuration for the {@link SpecialistRegistry}. */
export interface SpecialistRegistryConfig {
  /** Store for dynamic config overrides (optional). */
  store?: BaseStore
  /** Namespace prefix (default: `['specialist-registry']`). */
  namespace?: string[]
  /** Custom default configs to merge with built-ins. */
  customDefaults?: Record<string, Partial<SpecialistConfig>>
}

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULTS: Record<string, SpecialistConfig> = {
  auth: {
    category: 'auth',
    modelTier: 'powerful',
    reflectionDepth: 3,
    verificationStrategy: 'consensus',
    maxFixAttempts: 5,
    qualityThreshold: 0.9,
  },
  payments: {
    category: 'payments',
    modelTier: 'powerful',
    reflectionDepth: 3,
    verificationStrategy: 'consensus',
    maxFixAttempts: 5,
    qualityThreshold: 0.9,
  },
  crud: {
    category: 'crud',
    modelTier: 'balanced',
    reflectionDepth: 1,
    verificationStrategy: 'single',
    maxFixAttempts: 3,
    qualityThreshold: 0.7,
  },
  dashboard: {
    category: 'dashboard',
    modelTier: 'balanced',
    reflectionDepth: 2,
    verificationStrategy: 'single',
    maxFixAttempts: 3,
    qualityThreshold: 0.75,
  },
  realtime: {
    category: 'realtime',
    modelTier: 'powerful',
    reflectionDepth: 2,
    verificationStrategy: 'vote',
    maxFixAttempts: 4,
    qualityThreshold: 0.85,
  },
  analytics: {
    category: 'analytics',
    modelTier: 'balanced',
    reflectionDepth: 1,
    verificationStrategy: 'single',
    maxFixAttempts: 3,
    qualityThreshold: 0.7,
  },
  default: {
    category: 'default',
    modelTier: 'balanced',
    reflectionDepth: 1,
    verificationStrategy: 'single',
    maxFixAttempts: 3,
    qualityThreshold: 0.7,
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone a SpecialistConfig. */
function cloneConfig(config: SpecialistConfig): SpecialistConfig {
  return {
    ...config,
    nodeOverrides: config.nodeOverrides
      ? Object.fromEntries(
          Object.entries(config.nodeOverrides).map(([k, v]) => [k, { ...v }]),
        )
      : undefined,
  }
}

/** Merge a partial override into a full config (mutates target). */
function mergePartial(
  target: SpecialistConfig,
  partial: Partial<SpecialistConfig>,
): SpecialistConfig {
  if (partial.modelTier !== undefined) target.modelTier = partial.modelTier
  if (partial.reflectionDepth !== undefined) target.reflectionDepth = partial.reflectionDepth
  if (partial.verificationStrategy !== undefined) target.verificationStrategy = partial.verificationStrategy
  if (partial.maxFixAttempts !== undefined) target.maxFixAttempts = partial.maxFixAttempts
  if (partial.qualityThreshold !== undefined) target.qualityThreshold = partial.qualityThreshold
  if (partial.customInstructions !== undefined) target.customInstructions = partial.customInstructions

  if (partial.nodeOverrides) {
    target.nodeOverrides = target.nodeOverrides ?? {}
    for (const [nodeId, nodeOverride] of Object.entries(partial.nodeOverrides)) {
      target.nodeOverrides[nodeId] = {
        ...target.nodeOverrides[nodeId],
        ...nodeOverride,
      }
    }
  }

  return target
}

/** Apply risk class adjustments to a config (mutates). */
function applyRiskAdjustment(config: SpecialistConfig, riskClass: RiskClass): SpecialistConfig {
  switch (riskClass) {
    case 'critical':
      config.reflectionDepth = Math.min(config.reflectionDepth + 2, 5)
      config.modelTier = 'powerful'
      config.verificationStrategy = 'consensus'
      break
    case 'sensitive':
      config.reflectionDepth = Math.min(config.reflectionDepth + 1, 5)
      config.qualityThreshold = Math.min(config.qualityThreshold + 0.1, 1.0)
      break
    case 'standard':
      // No adjustment
      break
    case 'cosmetic':
      config.reflectionDepth = 0
      config.verificationStrategy = 'single'
      break
  }
  return config
}

// ---------------------------------------------------------------------------
// SpecialistRegistry
// ---------------------------------------------------------------------------

/**
 * Maps feature categories to specialist configurations that tune the
 * generation pipeline per feature type. Supports built-in defaults,
 * custom defaults, dynamic overrides from a BaseStore, and risk class
 * adjustments.
 */
export class SpecialistRegistry {
  private readonly store: BaseStore | undefined
  private readonly namespace: string[]
  private readonly customDefaults: Record<string, Partial<SpecialistConfig>>

  constructor(config?: SpecialistRegistryConfig) {
    this.store = config?.store
    this.namespace = config?.namespace ?? ['specialist-registry']
    this.customDefaults = config?.customDefaults ?? {}
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get the specialist config for a feature category + optional risk class.
   * Merges: built-in defaults -> custom defaults -> dynamic overrides from store.
   * Falls back to 'default' category if the requested category is unknown.
   */
  async getConfig(category: string, riskClass?: string): Promise<SpecialistConfig> {
    // Start with built-in (fall back to 'default')
    const builtIn = BUILTIN_DEFAULTS[category] ?? BUILTIN_DEFAULTS['default']
    const config = cloneConfig(builtIn)
    config.category = category

    // Layer custom defaults
    const customDefault = this.customDefaults[category]
    if (customDefault) {
      mergePartial(config, customDefault)
    }

    // Layer dynamic overrides from store
    if (this.store) {
      const override = await this.loadOverride(category)
      if (override) {
        mergePartial(config, override)
      }
    }

    // Apply risk class adjustments
    if (riskClass) {
      applyRiskAdjustment(config, riskClass as RiskClass)
    }

    return config
  }

  /**
   * Get config for a specific node within a feature category.
   * Merges category config with node-level overrides.
   */
  async getNodeConfig(
    category: string,
    nodeId: string,
    riskClass?: string,
  ): Promise<NodeConfig> {
    const config = await this.getConfig(category, riskClass)

    const base: NodeConfig = {
      modelTier: config.modelTier,
      reflectionDepth: config.reflectionDepth,
      qualityThreshold: config.qualityThreshold,
    }

    const nodeOverride = config.nodeOverrides?.[nodeId]
    if (nodeOverride) {
      if (nodeOverride.modelTier !== undefined) base.modelTier = nodeOverride.modelTier
      if (nodeOverride.reflectionDepth !== undefined) base.reflectionDepth = nodeOverride.reflectionDepth
      if (nodeOverride.qualityThreshold !== undefined) base.qualityThreshold = nodeOverride.qualityThreshold
    }

    return base
  }

  /**
   * Store a dynamic override (learned from historical performance).
   * Requires a BaseStore to be configured.
   */
  async setOverride(category: string, override: Partial<SpecialistConfig>): Promise<void> {
    if (!this.store) {
      throw new Error('SpecialistRegistry: cannot set override without a configured store')
    }

    const ns = [...this.namespace, 'overrides']
    await this.store.put(ns, category, override as unknown as Record<string, unknown>)
  }

  /**
   * Get all registered categories (built-in + custom defaults).
   */
  getCategories(): string[] {
    const categories = new Set<string>(Object.keys(BUILTIN_DEFAULTS))
    for (const key of Object.keys(this.customDefaults)) {
      categories.add(key)
    }
    return [...categories].sort()
  }

  /**
   * Get the built-in default config for a category.
   * Returns the 'default' config if the category is not registered.
   */
  getDefaultConfig(category: string): SpecialistConfig {
    const builtIn = BUILTIN_DEFAULTS[category] ?? BUILTIN_DEFAULTS['default']
    const config = cloneConfig(builtIn)
    config.category = category
    return config
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load a dynamic override from the store for a given category.
   */
  private async loadOverride(category: string): Promise<Partial<SpecialistConfig> | undefined> {
    if (!this.store) return undefined

    try {
      const ns = [...this.namespace, 'overrides']
      const item = await this.store.get(ns, category)
      if (!item?.value) return undefined
      return item.value as unknown as Partial<SpecialistConfig>
    } catch {
      return undefined
    }
  }
}
