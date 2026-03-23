import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  LLMProviderConfig,
  ModelTier,
  ModelOverrides,
  ModelSpec,
  ModelFactory,
} from './model-config.js'

/**
 * Default model factory — creates ChatAnthropic or ChatOpenAI instances
 * based on the provider type.
 */
function defaultModelFactory(
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
): BaseChatModel {
  const maxTokens = overrides?.maxTokens ?? spec.maxTokens
  const temperature = overrides?.temperature ?? spec.temperature
  const streaming = overrides?.streaming ?? spec.streaming ?? true

  switch (provider.provider) {
    case 'anthropic':
      return new ChatAnthropic({
        model: spec.name,
        apiKey: provider.apiKey,
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      })

    case 'openai':
      return new ChatOpenAI({
        model: spec.name,
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { configuration: { baseURL: provider.baseUrl } } : {}),
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      })

    case 'openrouter':
      return new ChatOpenAI({
        model: spec.name,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseUrl ?? 'https://openrouter.ai/api/v1' },
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      })

    case 'azure':
    case 'bedrock':
    case 'custom':
      throw new Error(`Provider "${provider.provider}" requires a custom ModelFactory`)
  }
}

/**
 * Pluggable model registry. Manages LLM providers with priority-based
 * selection and tier-based model resolution.
 *
 * Usage:
 * ```ts
 * const registry = new ModelRegistry()
 *   .addProvider({
 *     provider: 'anthropic',
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *     priority: 1,
 *     models: {
 *       chat: { name: 'claude-haiku-4-5-20251001', maxTokens: 1024 },
 *       codegen: { name: 'claude-sonnet-4-6', maxTokens: 8192 },
 *     },
 *   })
 *
 * const model = registry.getModel('codegen')
 * ```
 */
export class ModelRegistry {
  private providers: LLMProviderConfig[] = []
  private factory: ModelFactory = defaultModelFactory

  /** Register a provider with model tier mappings */
  addProvider(config: LLMProviderConfig): this {
    this.providers.push(config)
    this.providers.sort((a, b) => a.priority - b.priority)
    return this
  }

  /** Override the default model factory (for custom providers) */
  setFactory(factory: ModelFactory): this {
    this.factory = factory
    return this
  }

  /**
   * Get the highest-priority model for a given tier.
   * Iterates providers in priority order, returns the first that has the tier configured.
   */
  getModel(tier: ModelTier, overrides?: ModelOverrides): BaseChatModel {
    for (const provider of this.providers) {
      const spec = provider.models[tier]
      if (spec) {
        return this.factory(provider, spec, overrides)
      }
    }
    throw new Error(
      `No provider configured for tier "${tier}". ` +
      `Registered providers: ${this.providers.map(p => p.provider).join(', ') || 'none'}`,
    )
  }

  /**
   * Get a model by explicit provider + model name.
   * Useful when a prompt template specifies a particular model.
   */
  getModelByName(
    modelName: string,
    overrides?: ModelOverrides,
  ): BaseChatModel {
    for (const provider of this.providers) {
      for (const spec of Object.values(provider.models)) {
        if (spec && spec.name === modelName) {
          return this.factory(provider, spec, overrides)
        }
      }
    }
    // Fallback: try to match partial names (e.g., "sonnet" matches "claude-sonnet-4-6")
    for (const provider of this.providers) {
      for (const spec of Object.values(provider.models)) {
        if (spec && spec.name.includes(modelName)) {
          return this.factory(provider, spec, overrides)
        }
      }
    }
    throw new Error(`No provider has model "${modelName}" configured`)
  }

  /** Check if any provider is configured */
  isConfigured(): boolean {
    return this.providers.length > 0
  }

  /** List registered provider names in priority order */
  listProviders(): string[] {
    return this.providers.map(p => p.provider)
  }

  /** Get the model spec for a tier without instantiating */
  getSpec(tier: ModelTier): (ModelSpec & { provider: string }) | null {
    for (const provider of this.providers) {
      const spec = provider.models[tier]
      if (spec) return { ...spec, provider: provider.provider }
    }
    return null
  }
}
