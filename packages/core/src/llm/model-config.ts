import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

/** Model capability tier */
export type ModelTier = 'chat' | 'reasoning' | 'codegen' | 'embedding'

/** Built-in provider identifiers with first-class runtime support. */
export type KnownLLMProvider =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'google'
  | 'qwen'
  | 'azure'
  | 'bedrock'
  | 'custom'

/**
 * Provider identifier used across runtime/bootstrap surfaces.
 *
 * Known providers retain first-class defaults and factory support. Arbitrary
 * provider strings are allowed so config-driven/custom gateway integrations do
 * not have to coerce themselves into `'custom'` just to preserve provider
 * identity and explicit structured-output defaults.
 */
export type LLMProviderName = KnownLLMProvider | (string & {})

/** Structured-output execution strategy identifiers. */
export type StructuredOutputStrategy =
  | 'anthropic-tool-use'
  | 'openai-json-schema'
  | 'generic-parse'
  | 'fallback-prompt'

/** Explicit structured-output execution capabilities for a model spec. */
export interface StructuredOutputModelCapabilities {
  /** Preferred first strategy for this provider/model surface. */
  preferredStrategy: StructuredOutputStrategy
  /** Provider-oriented schema normalization target. */
  schemaProvider?: 'generic' | 'openai'
  /** Optional fallback order after the preferred strategy. */
  fallbackStrategies?: StructuredOutputStrategy[]
}

/** Model spec for a given tier */
export interface ModelSpec {
  name: string
  maxTokens: number
  temperature?: number
  streaming?: boolean
  /** Optional structured-output capability metadata for this model. */
  structuredOutput?: StructuredOutputModelCapabilities
}

/** Provider configuration registered with ModelRegistry */
export interface LLMProviderConfig {
  provider: LLMProviderName
  apiKey: string
  baseUrl?: string
  /** Optional provider-level default for structured-output behavior. */
  structuredOutputDefaults?: StructuredOutputModelCapabilities
  models: Partial<Record<ModelTier, ModelSpec>>
  /** Lower number = higher priority */
  priority: number
}

/** Override options when requesting a model */
export interface ModelOverrides {
  model?: string
  temperature?: number
  maxTokens?: number
  streaming?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/** Factory function type for creating model instances */
export type ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
) => BaseChatModel
