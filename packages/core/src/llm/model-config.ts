import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

/** Model capability tier */
export type ModelTier = 'chat' | 'reasoning' | 'codegen' | 'embedding'

/** Model spec for a given tier */
export interface ModelSpec {
  name: string
  maxTokens: number
  temperature?: number
  streaming?: boolean
}

/** Provider configuration registered with ModelRegistry */
export interface LLMProviderConfig {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'bedrock' | 'custom'
  apiKey: string
  baseUrl?: string
  models: Partial<Record<ModelTier, ModelSpec>>
  /** Lower number = higher priority */
  priority: number
}

/** Override options when requesting a model */
export interface ModelOverrides {
  temperature?: number
  maxTokens?: number
  streaming?: boolean
}

/** Factory function type for creating model instances */
export type ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
) => BaseChatModel
