/**
 * @dzupagent/core/llm — LLM model registry, prompts, streaming, routing,
 * middleware, and run-context transfer.
 *
 * @example
 * ```ts
 * import {
 *   ModelRegistry,
 *   PromptResolver,
 *   IntentRouter,
 *   SSETransformer,
 * } from '@dzupagent/core/llm'
 * ```
 */

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
export { ModelRegistry } from './llm/model-registry.js'
export type { ModelFallbackCandidate } from './llm/model-registry.js'
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
// Resilience: circuit breaker, rate limiting, retry
// ---------------------------------------------------------------------------
export { CircuitBreaker, KeyedCircuitBreaker } from './llm/circuit-breaker.js'
export type { CircuitBreakerConfig, CircuitState } from './llm/circuit-breaker.js'
export { TokenBucket } from './rate-limit/token-bucket.js'
export type { TokenBucketConfig } from './rate-limit/token-bucket.js'
export { isTransientError, isContextLengthError, DEFAULT_RETRY_CONFIG } from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------
export { invokeWithTimeout, extractTokenUsage, estimateTokens } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { ResilientModelInvoker } from './llm/resilient-invoker.js'
export type { ResilientInvokerOptions } from './llm/resilient-invoker.js'

// ---------------------------------------------------------------------------
// Tokenizers
// ---------------------------------------------------------------------------
export {
  HeuristicTokenizer,
  AnthropicTokenizer,
  TiktokenTokenizer,
} from './llm/tokenizer.js'
export type { Tokenizer, TokenizableMessage } from './llm/tokenizer.js'
export { TokenizerRegistry, defaultTokenizerRegistry } from './llm/tokenizer-registry.js'

// ---------------------------------------------------------------------------
// Registry middleware
// ---------------------------------------------------------------------------
export type {
  RegistryMiddleware,
  MiddlewareContext,
  MiddlewareResult,
  MiddlewareTokenUsage,
} from './llm/registry-middleware.js'

// ---------------------------------------------------------------------------
// Embedding registry
// ---------------------------------------------------------------------------
export {
  EmbeddingRegistry,
  createDefaultEmbeddingRegistry,
  COMMON_EMBEDDING_MODELS,
} from './llm/embedding-registry.js'
export type { EmbeddingModelEntry } from './llm/embedding-registry.js'

// ---------------------------------------------------------------------------
// Structured output capabilities
// ---------------------------------------------------------------------------
export {
  attachStructuredOutputCapabilities,
  getProviderStructuredOutputDefaults,
  getStructuredOutputDefaultsForProviderName,
  isKnownLLMProvider,
  normalizeStructuredOutputCapabilities,
} from './llm/structured-output-capabilities.js'

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export {
  FRAGMENT_CORE_PRINCIPLES,
  FRAGMENT_SECURITY_CHECKLIST,
  FRAGMENT_SIMPLICITY,
  FRAGMENT_READ_DISCIPLINE,
  FRAGMENT_SCOPE_BOUNDARY,
  FRAGMENT_VERIFICATION_MINDSET,
  FRAGMENT_BLOCKED_HANDLING,
  FRAGMENT_OUTPUT_EFFICIENCY,
  FRAGMENT_WORKER_REPORT,
  PROMPT_FRAGMENTS,
  composeFragments,
} from './prompt/prompt-fragments.js'
export { composeAdvancedFragments, validateFragments } from './prompt/fragment-composer.js'
export type { ComposableFragment, ComposeResult } from './prompt/fragment-composer.js'
export {
  resolveTemplate,
  extractVariables,
  validateTemplate,
  flattenContext,
} from './prompt/template-engine.js'
export { PromptResolver } from './prompt/template-resolver.js'
export type { PromptStore, ResolutionLevel } from './prompt/template-resolver.js'
export { PromptCache } from './prompt/template-cache.js'
export type {
  TemplateVariable,
  TemplateContext,
  ResolvedPrompt,
  StoredTemplate,
  PromptResolveQuery,
  BulkPromptQuery,
} from './prompt/template-types.js'

// ---------------------------------------------------------------------------
// Run context transfer
// ---------------------------------------------------------------------------
export { RunContextTransfer, INTENT_CONTEXT_CHAINS } from './context/run-context-transfer.js'
export type {
  RunContextTransferConfig,
  PersistedIntentContext,
} from './context/run-context-transfer.js'

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export type { AgentMiddleware } from './middleware/types.js'
export { calculateCostCents, getModelCosts } from './middleware/cost-tracking.js'
export type { CostTracker } from './middleware/cost-tracking.js'
export { createLangfuseHandler } from './middleware/langfuse.js'
export type { LangfuseConfig, LangfuseHandlerOptions } from './middleware/langfuse.js'
export { CostAttributionCollector } from './middleware/cost-attribution.js'
export type {
  CostAttribution,
  CostReport,
  CostBucket,
  CostAttributionConfig,
} from './middleware/cost-attribution.js'

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
export { SSETransformer } from './streaming/sse-transformer.js'
export type {
  StandardSSEEvent,
  StandardEventType,
  FileStreamStartPayload,
  FileStreamChunkPayload,
  FileStreamEndPayload,
} from './streaming/event-types.js'

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export { IntentRouter } from './router/intent-router.js'
export type { IntentRouterConfig, ClassificationResult } from './router/intent-router.js'
export { KeywordMatcher } from './router/keyword-matcher.js'
export { LLMClassifier } from './router/llm-classifier.js'
export { CostAwareRouter, isSimpleTurn, scoreComplexity } from './router/cost-aware-router.js'
export type {
  CostAwareResult,
  CostAwareRouterConfig,
  ComplexityLevel,
} from './router/cost-aware-router.js'
export { ModelTierEscalationPolicy } from './router/escalation-policy.js'
export type { EscalationPolicyConfig, EscalationResult } from './router/escalation-policy.js'
