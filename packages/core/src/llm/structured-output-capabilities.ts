import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  LLMProviderConfig,
  KnownLLMProvider,
  StructuredOutputModelCapabilities,
  StructuredOutputStrategy,
} from './model-config.js'

const KNOWN_LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'qwen',
  'azure',
  'bedrock',
  'custom',
] as const

export function isKnownLLMProvider(provider: string): provider is LLMProviderConfig['provider'] {
  return (KNOWN_LLM_PROVIDERS as readonly string[]).includes(provider)
}

export function inferStructuredOutputSchemaProvider(
  strategy: StructuredOutputStrategy,
): NonNullable<StructuredOutputModelCapabilities['schemaProvider']> {
  return strategy === 'openai-json-schema' ? 'openai' : 'generic'
}

export function normalizeStructuredOutputCapabilities(
  capabilities: StructuredOutputModelCapabilities,
): StructuredOutputModelCapabilities {
  return {
    preferredStrategy: capabilities.preferredStrategy,
    schemaProvider:
      capabilities.schemaProvider
      ?? inferStructuredOutputSchemaProvider(capabilities.preferredStrategy),
    ...(capabilities.fallbackStrategies === undefined
      ? {}
      : { fallbackStrategies: capabilities.fallbackStrategies }),
  }
}

export function attachStructuredOutputCapabilities<T extends BaseChatModel>(
  model: T,
  capabilities: StructuredOutputModelCapabilities | undefined,
): T {
  if (!capabilities) {
    return model
  }

  ;(model as T & {
    structuredOutputCapabilities?: StructuredOutputModelCapabilities
  }).structuredOutputCapabilities = normalizeStructuredOutputCapabilities(capabilities)

  return model
}

const PROVIDER_STRUCTURED_OUTPUT_DEFAULTS: Record<
  KnownLLMProvider,
  StructuredOutputModelCapabilities | undefined
> = {
  anthropic: {
    preferredStrategy: 'anthropic-tool-use',
    schemaProvider: 'generic',
    fallbackStrategies: ['generic-parse', 'fallback-prompt'],
  },
  openai: {
    preferredStrategy: 'openai-json-schema',
    schemaProvider: 'openai',
    fallbackStrategies: ['generic-parse', 'fallback-prompt'],
  },
  openrouter: {
    preferredStrategy: 'generic-parse',
    schemaProvider: 'generic',
    fallbackStrategies: ['fallback-prompt'],
  },
  google: {
    preferredStrategy: 'openai-json-schema',
    schemaProvider: 'openai',
    fallbackStrategies: ['generic-parse', 'fallback-prompt'],
  },
  qwen: {
    preferredStrategy: 'openai-json-schema',
    schemaProvider: 'openai',
    fallbackStrategies: ['generic-parse', 'fallback-prompt'],
  },
  azure: {
    preferredStrategy: 'openai-json-schema',
    schemaProvider: 'openai',
    fallbackStrategies: ['generic-parse', 'fallback-prompt'],
  },
  bedrock: undefined,
  custom: undefined,
}

export function getProviderStructuredOutputDefaults(
  provider: LLMProviderConfig['provider'],
): StructuredOutputModelCapabilities | undefined {
  const defaults = PROVIDER_STRUCTURED_OUTPUT_DEFAULTS[provider as KnownLLMProvider]
  return defaults ? normalizeStructuredOutputCapabilities(defaults) : undefined
}

export function getStructuredOutputDefaultsForProviderName(
  provider: string,
): StructuredOutputModelCapabilities | undefined {
  return isKnownLLMProvider(provider) ? getProviderStructuredOutputDefaults(provider) : undefined
}
