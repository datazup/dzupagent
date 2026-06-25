import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  LLMProviderConfig,
  ModelCapability,
  ModelTier,
  ModelOverrides,
  ModelSpec,
  ModelFactory,
  StructuredOutputModelCapabilities,
} from "./model-config.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { CircuitBreakerConfig } from "./circuit-breaker.js";
import { ForgeError } from "../errors/forge-error.js";
import { isTransientError } from "./retry.js";
import { defaultLogger } from "../utils/logger.js";
import type { RegistryMiddleware } from "./registry-middleware.js";
import type { EmbeddingRegistry } from "./embedding-registry.js";
import { createDefaultEmbeddingRegistry } from "./embedding-registry.js";
import type {
  HarnessProfileRegistry,
  ResolvedHarnessOverrides,
} from "./harness-profile.js";
import {
  attachStructuredOutputCapabilities,
  getProviderStructuredOutputDefaults,
  normalizeStructuredOutputCapabilities,
} from "./structured-output-capabilities.js";

/**
 * Capability and context-window requirements for capability-aware fallback.
 *
 * When passed to {@link ModelRegistry.getModelWithFallback}, any candidate
 * whose spec does not satisfy ALL requirements is skipped. If no candidate
 * satisfies the requirements a {@link ForgeError} with code
 * `NO_CAPABLE_FALLBACK` is thrown instead of silently degrading.
 */
export interface FallbackRequirements {
  /**
   * Capabilities that every selected model must declare.
   * A model with no `capabilities` array is treated as not having any
   * capability (i.e. it will be skipped when any requirement is listed).
   */
  requiredCapabilities?: ModelCapability[];
  /**
   * Minimum context-window size in tokens. Models whose `contextWindow`
   * is set but smaller than this value are skipped. Models without a
   * `contextWindow` value are NOT skipped — unknown ≠ insufficient.
   */
  minContextWindow?: number;
}

function resolveStructuredOutputCapabilities(
  provider: LLMProviderConfig,
  spec: ModelSpec
): StructuredOutputModelCapabilities | undefined {
  const capabilities =
    spec.structuredOutput ??
    provider.structuredOutputDefaults ??
    getProviderStructuredOutputDefaults(provider.provider);
  return capabilities
    ? normalizeStructuredOutputCapabilities(capabilities)
    : undefined;
}

/**
 * Returns true for OpenAI reasoning models that only support the default
 * temperature (1) and reject any explicit temperature override.
 * Covers: o1, o1-mini, o1-preview, o3, o3-mini, o4-mini, future o-series,
 * and gpt-5 family models (e.g. gpt-5-mini) which are reasoning-based.
 */
function isTemperatureUnsupported(modelName: string): boolean {
  // o-series reasoning models (o1, o3, o4-mini, openai/o3-mini, etc.)
  if (/^o\d/i.test(modelName) || /[-/]o\d/i.test(modelName)) return true;
  // gpt-5 family — reasoning-based, rejects temperature != 1
  if (/gpt-5/i.test(modelName)) return true;
  return false;
}

export interface ModelFallbackCandidate {
  provider: string;
  modelName: string;
  model: BaseChatModel;
}

/**
 * Default model factory — creates ChatAnthropic or ChatOpenAI instances
 * based on the provider type.
 */
function defaultModelFactory(
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides
): BaseChatModel {
  const modelName = overrides?.model ?? spec.name;
  const maxTokens = overrides?.maxTokens ?? spec.maxTokens;
  const temperature = overrides?.temperature ?? spec.temperature;
  const streaming = overrides?.streaming ?? spec.streaming ?? true;
  const reasoningEffort = overrides?.reasoningEffort;

  switch (provider.provider) {
    case "anthropic":
      return new ChatAnthropic({
        model: modelName,
        apiKey: provider.apiKey,
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      });

    case "openai": {
      const supportsTemperature = !isTemperatureUnsupported(modelName);
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        ...(provider.baseUrl
          ? { configuration: { baseURL: provider.baseUrl } }
          : {}),
        maxTokens,
        streaming,
        ...(supportsTemperature && temperature !== undefined
          ? { temperature }
          : {}),
      };
      if (reasoningEffort) {
        (config as Record<string, unknown>)["reasoning"] = {
          effort: reasoningEffort,
        };
      }
      return new ChatOpenAI(config);
    }

    case "openrouter": {
      const supportsTemperature = !isTemperatureUnsupported(modelName);
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: {
          baseURL: provider.baseUrl ?? "https://openrouter.ai/api/v1",
        },
        maxTokens,
        streaming,
        ...(supportsTemperature && temperature !== undefined
          ? { temperature }
          : {}),
      };
      if (reasoningEffort) {
        (config as Record<string, unknown>)["reasoning"] = {
          effort: reasoningEffort,
        };
      }
      return new ChatOpenAI(config);
    }

    case "google": {
      // Google Gemini models via @langchain/google-genai (ChatGoogleGenerativeAI)
      // Uses OpenAI-compatible ChatOpenAI with Google's baseUrl as fallback
      // For full native support, set a custom ModelFactory with ChatGoogleGenerativeAI
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: {
          baseURL:
            provider.baseUrl ??
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        },
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      };
      return new ChatOpenAI(config);
    }

    case "qwen": {
      // Qwen models via Alibaba Cloud's OpenAI-compatible API
      const config: ConstructorParameters<typeof ChatOpenAI>[0] = {
        model: modelName,
        apiKey: provider.apiKey,
        configuration: {
          baseURL:
            provider.baseUrl ??
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
        maxTokens,
        streaming,
        ...(temperature !== undefined ? { temperature } : {}),
      };
      return new ChatOpenAI(config);
    }

    case "azure":
    case "bedrock":
    case "custom":
      throw new Error(
        `Provider "${provider.provider}" requires a custom ModelFactory`
      );

    default:
      throw new Error(
        `Provider "${provider.provider}" requires a custom ModelFactory`
      );
  }

  throw new Error(
    `Provider "${provider.provider}" requires a custom ModelFactory`
  );
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
  private providers: LLMProviderConfig[] = [];
  private factory: ModelFactory = defaultModelFactory;
  private breakers = new Map<string, CircuitBreaker>();
  private breakerConfig?: Partial<CircuitBreakerConfig>;
  private middlewares: RegistryMiddleware[] = [];
  private harnessProfileRegistry: HarnessProfileRegistry | undefined;

  /** Pre-loaded embedding model registry */
  readonly embeddings: EmbeddingRegistry = createDefaultEmbeddingRegistry();

  private decorateStructuredOutputCapabilities(
    model: BaseChatModel,
    provider: LLMProviderConfig,
    spec: ModelSpec
  ): BaseChatModel {
    const capabilities = resolveStructuredOutputCapabilities(provider, spec);
    return attachStructuredOutputCapabilities(model, capabilities);
  }

  /** Register a provider with model tier mappings */
  addProvider(config: LLMProviderConfig): this {
    this.providers.push(config);
    this.providers.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /** Override the default model factory (for custom providers) */
  setFactory(factory: ModelFactory): this {
    this.factory = factory;
    return this;
  }

  /** Configure circuit breaker defaults for all providers */
  setCircuitBreakerConfig(config: Partial<CircuitBreakerConfig>): this {
    this.breakerConfig = config;
    return this;
  }

  /** Attach a HarnessProfileRegistry for per-model policy resolution. */
  setHarnessProfileRegistry(registry: HarnessProfileRegistry): this {
    this.harnessProfileRegistry = registry;
    return this;
  }

  /**
   * Resolve harness overrides for the given provider/model/tier combination.
   * Returns undefined if no HarnessProfileRegistry is configured or no
   * matching profile exists.
   */
  resolveHarnessOverrides(params: {
    provider: string;
    modelName: string;
    tier?: ModelTier;
  }): ResolvedHarnessOverrides | undefined {
    return this.harnessProfileRegistry?.resolve(params);
  }

  /** Get or create circuit breaker for a provider */
  private getBreaker(providerKey: string): CircuitBreaker {
    let breaker = this.breakers.get(providerKey);
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerConfig);
      this.breakers.set(providerKey, breaker);
    }
    return breaker;
  }

  /**
   * Get the highest-priority model for a given tier.
   * Iterates providers in priority order, returns the first that has the tier configured.
   */
  getModel(tier: ModelTier, overrides?: ModelOverrides): BaseChatModel {
    for (const provider of this.providers) {
      const spec = provider.models[tier];
      if (spec) {
        return this.decorateStructuredOutputCapabilities(
          this.factory(provider, spec, overrides),
          provider,
          spec
        );
      }
    }
    throw new Error(
      `No provider configured for tier "${tier}". ` +
        `Registered providers: ${
          this.providers.map((p) => p.provider).join(", ") || "none"
        }`
    );
  }

  /**
   * Get a model for a specific provider/tier combination.
   * Throws if the provider is not configured or does not expose that tier.
   */
  getModelFromProvider(
    providerName: LLMProviderConfig["provider"],
    tier: ModelTier,
    overrides?: ModelOverrides
  ): BaseChatModel {
    const provider = this.providers.find((p) => p.provider === providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" is not configured`);
    }
    const spec = provider.models[tier];
    if (!spec) {
      throw new Error(
        `Provider "${providerName}" has no model for tier "${tier}"`
      );
    }
    return this.decorateStructuredOutputCapabilities(
      this.factory(provider, spec, overrides),
      provider,
      spec
    );
  }

  /**
   * Get a model by explicit provider + model name.
   * Useful when a prompt template specifies a particular model.
   */
  getModelByName(modelName: string, overrides?: ModelOverrides): BaseChatModel {
    for (const provider of this.providers) {
      for (const spec of Object.values(provider.models)) {
        if (spec && spec.name === modelName) {
          return this.decorateStructuredOutputCapabilities(
            this.factory(provider, spec, overrides),
            provider,
            spec
          );
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
            spec
          );
        }
      }
    }
    throw new Error(`No provider has model "${modelName}" configured`);
  }

  /** Check if any provider is configured */
  isConfigured(): boolean {
    return this.providers.length > 0;
  }

  /** List registered provider names in priority order */
  listProviders(): string[] {
    return this.providers.map((p) => p.provider);
  }

  /** Get the model spec for a tier without instantiating */
  getSpec(tier: ModelTier): (ModelSpec & { provider: string }) | null {
    for (const provider of this.providers) {
      const spec = provider.models[tier];
      if (spec) {
        const capabilities = resolveStructuredOutputCapabilities(
          provider,
          spec
        );
        return {
          ...spec,
          ...(capabilities ? { structuredOutput: capabilities } : {}),
          provider: provider.provider,
        };
      }
    }
    return null;
  }

  /**
   * Get a model with selection-time fallback across providers.
   *
   * Iterates providers in priority order, skipping those whose circuit
   * breaker is open. Returns the first successfully created model. This
   * method does not retry a failed `model.invoke()` / `model.stream()` call;
   * it only selects an available provider before invocation starts.
   *
   * When `requirements` is supplied, each candidate's spec is checked before
   * it is instantiated:
   * - If the spec's `contextWindow` is known AND smaller than
   *   `requirements.minContextWindow`, the candidate is skipped.
   * - If `requirements.requiredCapabilities` is non-empty and the spec has a
   *   `capabilities` array that is missing any required entry, the candidate
   *   is skipped. Specs without a `capabilities` array are also skipped when
   *   any required capability is listed (unknown ≠ capable).
   *
   * If at least one candidate is skipped due to capability/context mismatch
   * and a valid fallback IS selected, a warning is logged. If NO candidate
   * satisfies the requirements a {@link ForgeError} with code
   * `NO_CAPABLE_FALLBACK` is thrown. If no candidate exists at all (ignoring
   * requirements) the usual `ALL_PROVIDERS_EXHAUSTED` error is thrown.
   *
   * Use `recordProviderSuccess()` / `recordProviderFailure()` after
   * invocation to update circuit breaker state.
   *
   * @throws ForgeError with code ALL_PROVIDERS_EXHAUSTED if no provider is available
   * @throws ForgeError with code NO_CAPABLE_FALLBACK if providers exist but none satisfy requirements
   */
  getModelWithFallback(
    tier: ModelTier,
    overrides?: ModelOverrides,
    requirements?: FallbackRequirements
  ): { model: BaseChatModel; provider: string } {
    const errors: string[] = [];
    let anyProviderFound = false;
    let capabilitySkipCount = 0;

    for (const provider of this.providers) {
      const spec = provider.models[tier];
      if (!spec) continue;

      anyProviderFound = true;

      const breaker = this.getBreaker(provider.provider);
      if (!breaker.canExecute()) {
        errors.push(`${provider.provider}: circuit open`);
        continue;
      }

      // Capability + context-window check
      if (requirements) {
        const { requiredCapabilities, minContextWindow } = requirements;

        // Context-window check: skip if known to be too small
        if (
          minContextWindow !== undefined &&
          spec.contextWindow !== undefined &&
          spec.contextWindow < minContextWindow
        ) {
          errors.push(
            `${provider.provider}: contextWindow ${spec.contextWindow} < required ${minContextWindow}`
          );
          capabilitySkipCount++;
          continue;
        }

        // Capability check: skip if any required capability is missing
        if (requiredCapabilities && requiredCapabilities.length > 0) {
          const modelCaps = spec.capabilities ?? [];
          const missing = requiredCapabilities.filter(
            (cap) => !modelCaps.includes(cap)
          );
          if (missing.length > 0) {
            errors.push(
              `${provider.provider}: missing capabilities [${missing.join(
                ", "
              )}]`
            );
            capabilitySkipCount++;
            continue;
          }
        }
      }

      try {
        const model = this.decorateStructuredOutputCapabilities(
          this.factory(provider, spec, overrides),
          provider,
          spec
        );

        // Emit warning when we are using a non-primary provider as fallback
        if (provider !== this.providers[0]) {
          defaultLogger.warn(
            `[ModelRegistry] falling back to provider "${provider.provider}" for tier "${tier}"`,
            { tier, provider: provider.provider, skippedErrors: errors }
          );
        }

        return { model, provider: provider.provider };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.provider}: ${msg}`);
        breaker.recordFailure();
      }
    }

    // If we had providers but all were skipped due to capability mismatch,
    // throw a specific NO_CAPABLE_FALLBACK error instead of the generic one.
    if (
      anyProviderFound &&
      capabilitySkipCount > 0 &&
      errors.every(
        (e) => e.includes("contextWindow") || e.includes("missing capabilities")
      )
    ) {
      throw new ForgeError({
        code: "NO_CAPABLE_FALLBACK",
        message: `No provider for tier "${tier}" satisfies the required capabilities/context. Checked: ${errors.join(
          "; "
        )}`,
        recoverable: false,
        suggestion:
          "Add a provider with the required capabilities or reduce the minContextWindow requirement",
        context: { tier, requirements, errors },
      });
    }

    throw new ForgeError({
      code: "ALL_PROVIDERS_EXHAUSTED",
      message: `No provider available for tier "${tier}". Tried: ${errors.join(
        "; "
      )}`,
      recoverable: false,
      suggestion:
        "Check provider API keys, service status, and circuit breaker configuration",
      context: { tier, errors },
    });
  }

  /**
   * Return all currently selectable providers for a tier in priority order.
   *
   * Like {@link getModelWithFallback}, this is a selection-time operation:
   * open circuits and factory errors are filtered before invocation. Callers
   * that implement explicit run-level retry/failover can use this candidate
   * chain to attempt a different provider after a transient invocation error.
   */
  getModelFallbackCandidates(
    tier: ModelTier,
    overrides?: ModelOverrides
  ): ModelFallbackCandidate[] {
    const errors: string[] = [];
    const candidates: ModelFallbackCandidate[] = [];

    for (const provider of this.providers) {
      const spec = provider.models[tier];
      if (!spec) continue;

      const breaker = this.getBreaker(provider.provider);
      if (!breaker.canExecute()) {
        errors.push(`${provider.provider}: circuit open`);
        continue;
      }

      try {
        const model = this.decorateStructuredOutputCapabilities(
          this.factory(provider, spec, overrides),
          provider,
          spec
        );
        candidates.push({
          model,
          provider: provider.provider,
          modelName: overrides?.model ?? spec.name,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.provider}: ${msg}`);
        breaker.recordFailure();
      }
    }

    if (candidates.length > 0) return candidates;

    throw new ForgeError({
      code: "ALL_PROVIDERS_EXHAUSTED",
      message: `No provider available for tier "${tier}". Tried: ${errors.join(
        "; "
      )}`,
      recoverable: false,
      suggestion:
        "Check provider API keys, service status, and circuit breaker configuration",
      context: { tier, errors },
    });
  }

  /**
   * Record a successful LLM invocation for the provider's circuit breaker.
   * Call this after a successful model.invoke() / model.stream().
   */
  recordProviderSuccess(provider: string): void {
    this.getBreaker(provider).recordSuccess();
  }

  /**
   * Record a failed LLM invocation. If the error is transient, the circuit
   * breaker tracks it; non-transient errors are ignored by the breaker.
   */
  recordProviderFailure(provider: string, error: Error): void {
    if (isTransientError(error)) {
      this.getBreaker(provider).recordFailure();
    }
  }

  /** Get circuit breaker state for diagnostics */
  getProviderHealth(): Record<string, { state: string; provider: string }> {
    const health: Record<string, { state: string; provider: string }> = {};
    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.provider);
      health[provider.provider] = {
        state: breaker?.getState() ?? "closed",
        provider: provider.provider,
      };
    }
    return health;
  }

  // --- Middleware support ---

  /** Register a middleware (executed in registration order) */
  use(middleware: RegistryMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /** Get all registered middlewares (read-only) */
  getMiddlewares(): readonly RegistryMiddleware[] {
    return this.middlewares;
  }

  /** Remove a middleware by name */
  removeMiddleware(name: string): boolean {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx === -1) return false;
    this.middlewares.splice(idx, 1);
    return true;
  }
}
