/**
 * @dzupagent/agent-adapters/providers
 *
 * Provider-focused entrypoint: stable provider IDs, adapter contracts,
 * provider registry primitives, and provider adapter factories.
 *
 * This subpath is intended for consumers that only need the bare
 * provider-adapter surface (Claude/Codex/Gemini/Qwen/Crush/Goose/OpenAI/OpenRouter)
 * without orchestration, HTTP, recovery, learning, or workflow planes.
 */

// --- Core types & contracts ---
export type {
  AdapterProviderId,
  AdapterCapabilityProfile,
  AgentInput,
  AgentEvent,
  AgentStreamEvent,
  AgentStartedEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStreamDeltaEvent,
  AgentProgressEvent,
  GovernanceEvent,
  GovernanceEventKind,
  TokenUsage,
  HealthStatus,
  SessionInfo,
  EnvFilterConfig,
  AdapterConfig,
  AgentCLIAdapter,
  TaskDescriptor,
  RoutingDecision,
  TaskRoutingStrategy,
} from './types.js'

// --- Adapters ---
export { ClaudeAgentAdapter } from './claude/claude-adapter.js'
export { CodexAdapter } from './codex/codex-adapter.js'
export { GeminiCLIAdapter } from './gemini/gemini-adapter.js'
export { GeminiSDKAdapter } from './gemini/gemini-sdk-adapter.js'
export type { GeminiSDKAdapterConfig } from './gemini/gemini-sdk-adapter.js'
export { QwenAdapter } from './qwen/qwen-adapter.js'
export { CrushAdapter } from './crush/crush-adapter.js'
export { GooseAdapter } from './goose/goose-adapter.js'
export { OpenRouterAdapter } from './openrouter/openrouter-adapter.js'
export type { OpenRouterConfig } from './openrouter/openrouter-adapter.js'
export { OpenAIAdapter } from './openai/openai-adapter.js'
export type { OpenAIConfig, OpenAIRunResult } from './openai/openai-adapter.js'

// --- Provider Registry primitives ---
export { ProviderAdapterRegistry } from './registry/adapter-registry.js'
export type {
  ProviderAdapterRegistryConfig,
  ProviderAdapterRegistryHealthStatus,
  ProviderAdapterHealthDetail,
} from './registry/adapter-registry.js'
export {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from './registry/task-router.js'
export type { WeightedStrategy } from './registry/task-router.js'
export { CapabilityRouter } from './registry/capability-router.js'
export type {
  ProviderCapability,
  ProviderCapabilityTag,
  CapabilityRouterConfig,
} from './registry/capability-router.js'

// --- Provider Catalog ---
export {
  PROVIDER_CATALOG,
  getMonitorableProviders,
  getProductProviders,
  getProviderCapabilities,
} from './provider-catalog.js'
export type { ProviderCapabilities, MonitorTier } from './provider-catalog.js'

// --- Unified Event Normalization ---
export { normalizeEvent } from './normalize.js'
export type { Provider as NormalizeProvider } from './normalize.js'

// --- Provider Helpers ---
export { resolveFallbackProviderId, requireFallbackProviderId } from './utils/provider-helpers.js'
export { isBinaryAvailable, spawnAndStreamJsonl } from './utils/process-helpers.js'
export { filterSensitiveEnvVars } from './base/base-cli-adapter.js'

// --- Errors ---
export { DzupError } from './utils/errors.js'
export type { DzupErrorOptions } from './utils/errors.js'
