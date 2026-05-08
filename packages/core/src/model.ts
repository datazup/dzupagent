/**
 * @dzupagent/core/model — Curated model registry, configuration, fallback,
 * and resilient invocation primitives.
 *
 * Narrower than `@dzupagent/core/llm` — exposes only the model selection,
 * configuration, and invocation layer (no prompts, routing, or middleware).
 *
 * @example
 * ```ts
 * import { ModelRegistry, ResilientModelInvoker } from '@dzupagent/core/model'
 * ```
 */

// ---------------------------------------------------------------------------
// Model registry + fallback
// ---------------------------------------------------------------------------
export { ModelRegistry } from './llm/model-registry.js'
export type { ModelFallbackCandidate } from './llm/model-registry.js'

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------
export type {
  KnownLLMProvider,
  LLMProviderConfig,
  LLMProviderName,
  ModelTier,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
  StructuredOutputStrategy,
  StructuredOutputModelCapabilities,
} from './llm/model-config.js'

// ---------------------------------------------------------------------------
// Resilience: circuit breaker, retry
// ---------------------------------------------------------------------------
export { CircuitBreaker, KeyedCircuitBreaker } from './llm/circuit-breaker.js'
export type { CircuitBreakerConfig, CircuitState } from './llm/circuit-breaker.js'
export {
  isTransientError,
  isContextLengthError,
  DEFAULT_RETRY_CONFIG,
} from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------
export { invokeWithTimeout, extractTokenUsage, estimateTokens } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { ResilientModelInvoker } from './llm/resilient-invoker.js'
export type { ResilientInvokerOptions } from './llm/resilient-invoker.js'

// ---------------------------------------------------------------------------
// Registry middleware contract
// ---------------------------------------------------------------------------
export type {
  RegistryMiddleware,
  MiddlewareContext,
  MiddlewareResult,
  MiddlewareTokenUsage,
} from './llm/registry-middleware.js'

// ---------------------------------------------------------------------------
// Structured output capability detection
// ---------------------------------------------------------------------------
export {
  attachStructuredOutputCapabilities,
  getProviderStructuredOutputDefaults,
  getStructuredOutputDefaultsForProviderName,
  isKnownLLMProvider,
  normalizeStructuredOutputCapabilities,
} from './llm/structured-output-capabilities.js'
