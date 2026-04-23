import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  LLMProviderConfig,
  ModelTier,
  ModelOverrides,
  ModelSpec,
  ModelFactory,
  StructuredOutputModelCapabilities,
} from './model-config.js'
import { CircuitBreaker } from './circuit-breaker.js'
import type { CircuitBreakerConfig } from './circuit-breaker.js'
import { ForgeError } from '../errors/forge-error.js'
import { isTransientError } from './retry.js'
import type { RegistryMiddleware } from './registry-middleware.js'
import type { EmbeddingRegistry } from './embedding-registry.js'
import { createDefaultEmbeddingRegistry } from './embedding-registry.js'
import {
  attachStructuredOutputCapabilities,
  getProviderStructuredOutputDefaults,
  normalizeStructuredOutputCapabilities,
} from './structured-output-capabilities.js'

function resolveStructuredOutputCapabilities(
  provider: LLMProviderConfig,
  spec: ModelSpec,
): StructuredOutputModelCapabilities | undefined {
  const capabilities = spec.structuredOutput
    ?? provider.structuredOutputDefaults
    ?? getProviderStructuredOutputDefaults(provider.provider)
  return capabilities ? normalizeStructuredOutputCapabilities(capabilities) : undefined
}

/**
 * Returns true for OpenAI reasoning models that only support the default
 * temperature (1) and reject any explicit temperature override.
 * Covers: o1, o1-mini, o1-preview, o3, o3-mini, o4-mini, future o-series,
 * and gpt-5 family models (e.g. gpt-5-mini) which are reasoning-based.
 */
function isTemperatureUnsupported(modelName: string): boolean {
  // o-series reasoning models (o1, o3, o4-mini, openai/o3-mini, etc.)
  if (/^o\d/i.test(modelName) || /[-/]o\d/i.test(modelName)) return true
  // gpt-5 family — reasoning-based, rejects temperature != 1
  if (/gpt-5/i.test(modelName)) return true
  return false
}

/**
 * Default model factory — creates ChatAnthropic or ChatOpenAI instances
 * based on the provider type.
 */
function defaultModelFactory(
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
): BaseChatModel {
  const modelName = overrides?.model ?? spec.name
  const maxTokens = overrides?.maxTokens ?? spec.maxTokens
  const temperature = overrides?.temperature ?? spec.temperature
  const streaming = overrides?.streaming ?? spec.streaming ?? true
  const reasoningEffort = overrides?.reasoningEffort

  switch (provider.provider) {
    case 'anthropic':
      return new ChatAnthropic({
        model: modelName,
        apiKey: provider.apiKey,
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      })

    case 'openai': {
      const supportsTemperature = !isTemperatureUnsupported(modelName)
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { configuration: { baseURL: provider.baseUrl } } : {}),
        maxTokens,
        streaming,
        ...(supportsTemperature && temperature !== undefined ? { temperature } : {}),
      }
      if (reasoningEffort) {
        ;(config as Record<string, unknown>)['reasoning'] = { effort: reasoningEffort }
      }
      return new ChatOpenAI(config)
    }

    case 'openrouter': {
      const supportsTemperature = !isTemperatureUnsupported(modelName)
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseUrl ?? 'https://openrouter.ai/api/v1' },
        maxTokens,
        streaming,
        ...(supportsTemperature && temperature !== undefined ? { temperature } : {}),
      }
      if (reasoningEffort) {
        ;(config as Record<string, unknown>)['reasoning'] = { effort: reasoningEffort }
      }
      return new ChatOpenAI(config)
    }

    case 'google': {
      // Google Gemini models via @langchain/google-genai (ChatGoogleGenerativeAI)
      // Uses OpenAI-compatible ChatOpenAI with Google's baseUrl as fallback
      // For full native support, set a custom ModelFactory with ChatGoogleGenerativeAI
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai/' },
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      }
      return new ChatOpenAI(config)
    }

    case 'qwen': {
      // Qwen models via Alibaba Cloud's OpenAI-compatible API
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: { baseURL: provider.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      }
      return new ChatOpenAI(config)
    }

    case 'azure':
    case 'bedrock':
    case 'custom':
      throw new Error(`Provider "${provider.provider}" requires a custom ModelFactory`)

    default:
      throw new Error(`Provider "${provider.provider}" requires a custom ModelFactory`)
  }

  throw new Error(`Provider "${provider.provider}" requires a custom ModelFactory`)
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
  private breakers = new Map<string, CircuitBreaker>()
  private breakerConfig?: Partial<CircuitBreakerConfig>
  private middlewares: RegistryMiddleware[] = []

  /** Pre-loaded embedding model registry */
  readonly embeddings: EmbeddingRegistry = createDefaultEmbeddingRegistry()

  private decorateStructuredOutputCapabilities(
    model: BaseChatModel,
    provider: LLMProviderConfig,
    spec: ModelSpec,
  ): BaseChatModel {
    const capabilities = resolveStructuredOutputCapabilities(provider, spec)
    return attachStructuredOutputCapabilities(model, capabilities)
  }

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

  /** Configure circuit breaker defaults for all providers */
  setCircuitBreakerConfig(config: Partial<CircuitBreakerConfig>): this {
    this.breakerConfig = config
    return this
  }

  /** Get or create circuit breaker for a provider */
  private getBreaker(providerKey: string): CircuitBreaker {
    let breaker = this.breakers.get(providerKey)
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerConfig)
      this.breakers.set(providerKey, breaker)
    }
    return breaker
  }

  /**
   * Get the highest-priority model for a given tier.
   * Iterates providers in priority order, returns the first that has the tier configured.
   */
  getModel(tier: ModelTier, overrides?: ModelOverrides): BaseChatModel {
    for (const provider of this.providers) {
      const spec = provider.models[tier]
      if (spec) {
        return this.decorateStructuredOutputCapabilities(
          this.factory(provider, spec, overrides),
          provider,
          spec,
        )
      }
    }
    throw new Error(
      `No provider configured for tier "${tier}". ` +
      `Registered providers: ${this.providers.map(p => p.provider).join(', ') || 'none'}`,
    )
  }

  /**
   * Get a model for a specific provider/tier combination.
   * Throws if the provider is not configured or does not expose that tier.
   */
  getModelFromProvider(
    providerName: LLMProviderConfig['provider'],
    tier: ModelTier,
    overrides?: ModelOverrides,
  ): BaseChatModel {
    const provider = this.providers.find(p => p.provider === providerName)
    if (!provider) {
      throw new Error(`Provider "${providerName}" is not configured`)
    }
    const spec = provider.models[tier]
    if (!spec) {
      throw new Error(`Provider "${providerName}" has no model for tier "${tier}"`)
    }
    return this.decorateStructuredOutputCapabilities(
      this.factory(provider, spec, overrides),
      provider,
      spec,
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
          return this.decorateStructuredOutputCapabilities(
            this.factory(provider, spec, overrides),
            provider,
            spec,
          )
        }
      }
    }
    // Fallback: try to match partial names (e.g., "sonnet" matches "claude-sonnet-4-6")
    for (const provider of this.providers) {
      for (const spec of Object.values(provider.models)) {
        if (spec && spec.name.includes(modelName)) {
          return this.decorateStructuredOutputCapabilities(
            this.factory(provider, spec, overrides),
            provider,
            spec,
          )
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
      if (spec) {
        const capabilities = resolveStructuredOutputCapabilities(provider, spec)
        return {
          ...spec,
          ...(capabilities ? { structuredOutput: capabilities } : {}),
          provider: provider.provider,
        }
      }
    }
    return null
  }

  /**
   * Get a model with automatic fallback across providers.
   *
   * Iterates providers in priority order, skipping those whose circuit
   * breaker is open. Returns the first successfully created model.
   *
   * Use `recordProviderSuccess()` / `recordProviderFailure()` after
   * invocation to update circuit breaker state.
   *
   * @throws ForgeError with code ALL_PROVIDERS_EXHAUSTED if no provider is available
   */
  getModelWithFallback(
    tier: ModelTier,
    overrides?: ModelOverrides,
  ): { model: BaseChatModel; provider: string } {
    const errors: string[] = []

    for (const provider of this.providers) {
      const spec = provider.models[tier]
      if (!spec) continue

      const breaker = this.getBreaker(provider.provider)
      if (!breaker.canExecute()) {
        errors.push(`${provider.provider}: circuit open`)
        continue
      }

      try {
        const model = this.decorateStructuredOutputCapabilities(
          this.factory(provider, spec, overrides),
          provider,
          spec,
        )
        return { model, provider: provider.provider }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${provider.provider}: ${msg}`)
        breaker.recordFailure()
      }
    }

    throw new ForgeError({
      code: 'ALL_PROVIDERS_EXHAUSTED',
      message: `No provider available for tier "${tier}". Tried: ${errors.join('; ')}`,
      recoverable: false,
      suggestion: 'Check provider API keys, service status, and circuit breaker configuration',
      context: { tier, errors },
    })
  }

  /**
   * Record a successful LLM invocation for the provider's circuit breaker.
   * Call this after a successful model.invoke() / model.stream().
   */
  recordProviderSuccess(provider: string): void {
    this.getBreaker(provider).recordSuccess()
  }

  /**
   * Record a failed LLM invocation. If the error is transient, the circuit
   * breaker tracks it; non-transient errors are ignored by the breaker.
   */
  recordProviderFailure(provider: string, error: Error): void {
    if (isTransientError(error)) {
      this.getBreaker(provider).recordFailure()
    }
  }

  /** Get circuit breaker state for diagnostics */
  getProviderHealth(): Record<string, { state: string; provider: string }> {
    const health: Record<string, { state: string; provider: string }> = {}
    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.provider)
      health[provider.provider] = {
        state: breaker?.getState() ?? 'closed',
        provider: provider.provider,
      }
    }
    return health
  }

  // --- Middleware support ---

  /** Register a middleware (executed in registration order) */
  use(middleware: RegistryMiddleware): this {
    this.middlewares.push(middleware)
    return this
  }

  /** Get all registered middlewares (read-only) */
  getMiddlewares(): readonly RegistryMiddleware[] {
    return this.middlewares
  }

  /** Remove a middleware by name */
  removeMiddleware(name: string): boolean {
    const idx = this.middlewares.findIndex(m => m.name === name)
    if (idx === -1) return false
    this.middlewares.splice(idx, 1)
    return true
  }
}
