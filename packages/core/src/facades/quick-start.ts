/**
 * @dzupagent/core/quick-start — Curated API facade for getting started fast.
 *
 * Exports only the essentials needed to spin up a basic agent:
 * model registry, memory, context management, events, and a
 * convenience factory that wires them together.
 *
 * @example
 * ```ts
 * import { createQuickAgent } from '@dzupagent/core/quick-start';
 *
 * const { registry, eventBus, container } = createQuickAgent({
 *   provider: 'anthropic',
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 * ```
 */

// --- DI container ---
export { ForgeContainer, createContainer } from '../config/container.js'

// --- Events ---
export { createEventBus } from '../events/event-bus.js'
export type { DzupEventBus } from '../events/event-bus.js'
export type { DzupEvent } from '../events/event-types.js'

// --- Errors ---
export { ForgeError } from '../errors/forge-error.js'
export type { ForgeErrorCode } from '../errors/error-codes.js'

// --- LLM ---
export { ModelRegistry } from '../llm/model-registry.js'
export type {
  KnownLLMProvider,
  LLMProviderConfig,
  LLMProviderName,
  ModelTier,
  ModelSpec,
  ModelOverrides,
  StructuredOutputStrategy,
  StructuredOutputModelCapabilities,
} from '../llm/model-config.js'
export { invokeWithTimeout } from '../llm/invoke.js'
export type { TokenUsage, InvokeOptions } from '../llm/invoke.js'

// --- Memory (curated subset) ---
export { MemoryService, createStore } from '@dzupagent/memory'
export type { StoreConfig, NamespaceConfig } from '@dzupagent/memory'

// --- Context (curated subset) ---
export {
  shouldSummarize,
  summarizeAndTrim,
  pruneToolResults,
  scoreCompleteness,
  evictIfNeeded,
} from '@dzupagent/context'
export type {
  MessageManagerConfig,
  CompletenessResult,
  EvictionConfig,
} from '@dzupagent/context'

// --- Config ---
export { DEFAULT_CONFIG, resolveConfig, mergeConfigs } from '../config/index.js'
export type { ForgeConfig, ProviderConfig } from '../config/index.js'

// --- Hooks ---
export type { AgentHooks } from '../hooks/hook-types.js'

// --- Streaming ---
export { SSETransformer } from '../streaming/sse-transformer.js'
export type { StandardSSEEvent } from '../streaming/event-types.js'

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

import { createContainer } from '../config/container.js'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEventBus } from '../events/event-bus.js'
import { ModelRegistry } from '../llm/model-registry.js'
import type {
  KnownLLMProvider,
  LLMProviderConfig,
  StructuredOutputModelCapabilities,
} from '../llm/model-config.js'
import type { ForgeContainer } from '../config/container.js'
import { getProviderStructuredOutputDefaults } from '../llm/structured-output-capabilities.js'

/** Minimal options required to bootstrap an agent. */
export interface QuickAgentOptions {
  /** LLM provider name (e.g. 'anthropic', 'openai', or a custom gateway id). */
  provider: LLMProviderConfig['provider']
  /** API key for the provider. */
  apiKey: string
  /** Optional base URL override (e.g. for proxies). */
  baseUrl?: string
  /** Chat model name. Defaults to provider-specific default. */
  chatModel?: string
  /** Codegen model name. Defaults to provider-specific default. */
  codegenModel?: string
  /** Max tokens for chat model. Default 4096. */
  chatMaxTokens?: number
  /** Max tokens for codegen model. Default 8192. */
  codegenMaxTokens?: number
  /** Optional provider-level structured-output capability override. */
  structuredOutputCapabilities?: StructuredOutputModelCapabilities
}

/** Return type from {@link createQuickAgent}. */
export interface QuickAgentResult {
  /** Pre-wired DI container with eventBus and registry. */
  container: ForgeContainer
  /** Typed event bus for observability. */
  eventBus: DzupEventBus
  /** Model registry pre-configured with the provided credentials. */
  registry: ModelRegistry
}

const PROVIDER_DEFAULTS: Record<KnownLLMProvider, { chat: string; codegen: string }> = {
  anthropic: { chat: 'claude-haiku-4-20250514', codegen: 'claude-sonnet-4-20250514' },
  openai: { chat: 'gpt-4o-mini', codegen: 'gpt-4o' },
  openrouter: { chat: 'anthropic/claude-haiku', codegen: 'anthropic/claude-sonnet' },
  google: { chat: 'gemini-2.5-flash', codegen: 'gemini-2.5-pro' },
  qwen: { chat: 'qwen-turbo', codegen: 'qwen-plus' },
  azure: { chat: 'gpt-4o-mini', codegen: 'gpt-4o' },
  bedrock: { chat: 'anthropic.claude-haiku', codegen: 'anthropic.claude-sonnet' },
  custom: { chat: 'default', codegen: 'default' },
}

function getQuickStartProviderDefaults(
  provider: LLMProviderConfig['provider'],
): { chat: string; codegen: string } {
  return PROVIDER_DEFAULTS[provider as KnownLLMProvider] ?? PROVIDER_DEFAULTS['custom']
}

/**
 * One-call bootstrap for a minimal DzupAgent setup.
 *
 * Creates a DI container pre-wired with an event bus and a model registry
 * configured for the given provider. This is intentionally simple — for
 * advanced setups, use the individual modules directly.
 */
export function createQuickAgent(options: QuickAgentOptions): QuickAgentResult {
  const defaults = getQuickStartProviderDefaults(options.provider)
  const structuredOutputDefaults = options.structuredOutputCapabilities
    ?? getProviderStructuredOutputDefaults(options.provider)

  const container = createContainer()
  const eventBus = createEventBus()
  const registry = new ModelRegistry()

  registry.addProvider({
    provider: options.provider,
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(structuredOutputDefaults ? { structuredOutputDefaults } : {}),
    priority: 1,
    models: {
      chat: {
        name: options.chatModel ?? defaults.chat,
        maxTokens: options.chatMaxTokens ?? 4096,
      },
      codegen: {
        name: options.codegenModel ?? defaults.codegen,
        maxTokens: options.codegenMaxTokens ?? 8192,
      },
    },
  })

  container.register('eventBus', () => eventBus)
  container.register('registry', () => registry)

  return { container, eventBus, registry }
}
