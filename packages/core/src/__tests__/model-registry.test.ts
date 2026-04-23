import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { LLMProviderConfig, ModelSpec, ModelOverrides, ModelFactory } from '../llm/model-config.js'
import type { RegistryMiddleware } from '../llm/registry-middleware.js'

// We mock the heavy LLM constructors so we don't need real API keys.
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _type: 'anthropic',
    ...opts,
  })),
}))

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _type: 'openai',
    ...opts,
  })),
}))

// Mock circuit breaker to avoid timing concerns
vi.mock('../llm/circuit-breaker.js', () => {
  class MockCircuitBreaker {
    private state = 'closed'
    canExecute() { return this.state !== 'open' }
    recordFailure() { /* noop */ }
    recordSuccess() { /* noop */ }
    getState() { return this.state }
    // Allow tests to force state
    _setState(s: string) { this.state = s }
  }
  return { CircuitBreaker: MockCircuitBreaker }
})

vi.mock('../llm/embedding-registry.js', () => ({
  EmbeddingRegistry: class {},
  createDefaultEmbeddingRegistry: () => ({}),
}))

vi.mock('../llm/retry.js', () => ({
  isTransientError: (err: Error) => err.message.includes('transient'),
}))

import { ModelRegistry } from '../llm/model-registry.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(
  overrides?: Partial<LLMProviderConfig>,
): LLMProviderConfig {
  return {
    provider: 'anthropic',
    apiKey: 'test-key',
    priority: 1,
    models: {
      chat: { name: 'claude-haiku', maxTokens: 1024 },
      codegen: { name: 'claude-sonnet', maxTokens: 8192 },
    },
    ...overrides,
  }
}

// A simple factory that returns a plain object instead of a real model.
const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
) =>
  ({
    _provider: provider.provider,
    _model: overrides?.model ?? spec.name,
    _maxTokens: overrides?.maxTokens ?? spec.maxTokens,
  }) as unknown as BaseChatModel

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelRegistry', () => {
  let registry: ModelRegistry

  beforeEach(() => {
    registry = new ModelRegistry()
    registry.setFactory(stubFactory)
  })

  // --- addProvider / isConfigured / listProviders ---

  it('starts unconfigured with no providers', () => {
    expect(registry.isConfigured()).toBe(false)
    expect(registry.listProviders()).toEqual([])
  })

  it('registers a provider and reports it', () => {
    registry.addProvider(makeProvider())
    expect(registry.isConfigured()).toBe(true)
    expect(registry.listProviders()).toEqual(['anthropic'])
  })

  it('sorts providers by priority (lower = higher priority)', () => {
    registry.addProvider(makeProvider({ provider: 'openai', priority: 5, apiKey: 'k2' }))
    registry.addProvider(makeProvider({ provider: 'anthropic', priority: 1, apiKey: 'k1' }))
    expect(registry.listProviders()).toEqual(['anthropic', 'openai'])
  })

  // --- getModel ---

  it('resolves a model by tier', () => {
    registry.addProvider(makeProvider())
    const model = registry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['_model']).toBe('claude-haiku')
  })

  it('throws for an unconfigured tier', () => {
    registry.addProvider(makeProvider({ models: { chat: { name: 'x', maxTokens: 100 } } }))
    expect(() => registry.getModel('reasoning')).toThrow(/No provider configured for tier "reasoning"/)
  })

  it('applies overrides when resolving a model', () => {
    registry.addProvider(makeProvider())
    const model = registry.getModel('chat', {
      maxTokens: 2048,
    }) as unknown as Record<string, unknown>
    expect(model['_maxTokens']).toBe(2048)
  })

  it('decorates resolved models with provider-derived structured-output capabilities', () => {
    const realRegistry = new ModelRegistry()
    realRegistry.addProvider(makeProvider({ provider: 'openai', apiKey: 'oai' }))

    const model = realRegistry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['structuredOutputCapabilities']).toEqual({
      preferredStrategy: 'openai-json-schema',
      schemaProvider: 'openai',
      fallbackStrategies: ['generic-parse', 'fallback-prompt'],
    })
  })

  it('treats openrouter as prompt-json fallback unless a provider override opts into native schema mode', () => {
    const realRegistry = new ModelRegistry()
    realRegistry.addProvider(makeProvider({
      provider: 'openrouter',
      apiKey: 'router-key',
      models: {
        chat: {
          name: 'openai/gpt-4o-mini',
          maxTokens: 1024,
        },
      },
    }))

    const model = realRegistry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['structuredOutputCapabilities']).toEqual({
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    })
  })

  it('prefers explicit structured-output capabilities from the model spec', () => {
    const realRegistry = new ModelRegistry()
    realRegistry.addProvider(makeProvider({
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse'],
      },
      models: {
        chat: {
          name: 'claude-haiku',
          maxTokens: 1024,
          structuredOutput: {
            preferredStrategy: 'generic-parse',
            schemaProvider: 'generic',
            fallbackStrategies: ['fallback-prompt'],
          },
        },
      },
    }))

    const model = realRegistry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['structuredOutputCapabilities']).toEqual({
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    })
  })

  it('uses provider-level structured-output defaults for custom surfaces', () => {
    const realRegistry = new ModelRegistry()
    realRegistry.setFactory(stubFactory)
    realRegistry.addProvider(makeProvider({
      provider: 'custom',
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      models: {
        chat: {
          name: 'gateway/gpt-4o-mini',
          maxTokens: 2048,
        },
      },
    }))

    const model = realRegistry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['structuredOutputCapabilities']).toEqual({
      preferredStrategy: 'openai-json-schema',
      schemaProvider: 'openai',
      fallbackStrategies: ['generic-parse', 'fallback-prompt'],
    })
  })

  it('preserves arbitrary custom gateway provider names with explicit structured-output defaults', () => {
    const realRegistry = new ModelRegistry()
    realRegistry.setFactory(stubFactory)
    realRegistry.addProvider(makeProvider({
      provider: 'gateway-openai-proxy',
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      models: {
        chat: {
          name: 'gateway/gpt-4o-mini',
          maxTokens: 2048,
        },
      },
    }))

    const model = realRegistry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['_provider']).toBe('gateway-openai-proxy')
    expect(model['structuredOutputCapabilities']).toEqual({
      preferredStrategy: 'openai-json-schema',
      schemaProvider: 'openai',
      fallbackStrategies: ['generic-parse', 'fallback-prompt'],
    })
    expect(realRegistry.getSpec('chat')).toEqual({
      name: 'gateway/gpt-4o-mini',
      maxTokens: 2048,
      structuredOutput: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      provider: 'gateway-openai-proxy',
    })
  })

  // --- getModelFromProvider ---

  it('gets a model from a specific provider', () => {
    registry.addProvider(makeProvider({ provider: 'anthropic', priority: 1 }))
    registry.addProvider(makeProvider({ provider: 'openai', priority: 2, apiKey: 'oai' }))
    const model = registry.getModelFromProvider('openai', 'chat') as unknown as Record<string, unknown>
    expect(model['_provider']).toBe('openai')
  })

  it('throws when provider is not registered', () => {
    expect(() => registry.getModelFromProvider('openai', 'chat')).toThrow(
      /Provider "openai" is not configured/,
    )
  })

  it('throws when provider lacks the requested tier', () => {
    registry.addProvider(makeProvider({ models: { chat: { name: 'x', maxTokens: 1 } } }))
    expect(() => registry.getModelFromProvider('anthropic', 'codegen')).toThrow(
      /has no model for tier "codegen"/,
    )
  })

  // --- getModelByName ---

  it('resolves a model by exact name', () => {
    registry.addProvider(makeProvider())
    const model = registry.getModelByName('claude-haiku') as unknown as Record<string, unknown>
    expect(model['_model']).toBe('claude-haiku')
  })

  it('resolves a model by partial name match', () => {
    registry.addProvider(makeProvider())
    const model = registry.getModelByName('sonnet') as unknown as Record<string, unknown>
    expect(model['_model']).toBe('claude-sonnet')
  })

  it('throws when no model matches the name', () => {
    registry.addProvider(makeProvider())
    expect(() => registry.getModelByName('gpt-5-turbo')).toThrow(
      /No provider has model "gpt-5-turbo" configured/,
    )
  })

  // --- getSpec ---

  it('returns model spec without instantiating', () => {
    registry.addProvider(makeProvider())
    const spec = registry.getSpec('chat')
    expect(spec).toEqual({
      name: 'claude-haiku',
      maxTokens: 1024,
      structuredOutput: {
        preferredStrategy: 'anthropic-tool-use',
        schemaProvider: 'generic',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      provider: 'anthropic',
    })
  })

  it('normalizes inferred structured-output capabilities in getSpec for google OpenAI-compatible transport', () => {
    registry.addProvider(makeProvider({
      provider: 'google',
      apiKey: 'google-key',
      models: {
        chat: { name: 'gemini-2.5-pro', maxTokens: 4096 },
      },
    }))

    expect(registry.getSpec('chat')).toEqual({
      name: 'gemini-2.5-pro',
      maxTokens: 4096,
      structuredOutput: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      provider: 'google',
    })
  })

  it('normalizes inferred structured-output capabilities in getSpec for qwen OpenAI-compatible transport', () => {
    registry.addProvider(makeProvider({
      provider: 'qwen',
      apiKey: 'qwen-key',
      models: {
        chat: { name: 'qwen-turbo', maxTokens: 4096 },
      },
    }))

    expect(registry.getSpec('chat')).toEqual({
      name: 'qwen-turbo',
      maxTokens: 4096,
      structuredOutput: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      provider: 'qwen',
    })
  })

  it('reports openrouter getSpec structured output as prompt-json fallback by default', () => {
    registry.addProvider(makeProvider({
      provider: 'openrouter',
      apiKey: 'router-key',
      models: {
        chat: { name: 'openai/gpt-4o-mini', maxTokens: 4096 },
      },
    }))

    expect(registry.getSpec('chat')).toEqual({
      name: 'openai/gpt-4o-mini',
      maxTokens: 4096,
      structuredOutput: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
      provider: 'openrouter',
    })
  })

  it('prefers provider-level structured-output defaults in getSpec for custom providers', () => {
    registry.addProvider(makeProvider({
      provider: 'custom',
      structuredOutputDefaults: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      models: {
        chat: { name: 'gateway/gpt-4o-mini', maxTokens: 4096 },
      },
    }))

    expect(registry.getSpec('chat')).toEqual({
      name: 'gateway/gpt-4o-mini',
      maxTokens: 4096,
      structuredOutput: {
        preferredStrategy: 'openai-json-schema',
        schemaProvider: 'openai',
        fallbackStrategies: ['generic-parse', 'fallback-prompt'],
      },
      provider: 'custom',
    })
  })

  it('returns null for missing spec tier', () => {
    registry.addProvider(makeProvider({ models: {} }))
    expect(registry.getSpec('reasoning')).toBeNull()
  })

  // --- getModelWithFallback ---

  it('returns the first available provider for fallback', () => {
    registry.addProvider(makeProvider({ provider: 'anthropic', priority: 1 }))
    registry.addProvider(makeProvider({ provider: 'openai', priority: 2, apiKey: 'oai' }))
    const result = registry.getModelWithFallback('chat')
    expect(result.provider).toBe('anthropic')
  })

  it('throws ForgeError when all providers are exhausted', () => {
    // No providers at all
    expect(() => registry.getModelWithFallback('chat')).toThrow(ForgeError)
  })

  it('skips providers whose factory throws and falls back', () => {
    let callCount = 0
    const failOnceFactory: ModelFactory = (provider, spec, overrides) => {
      callCount++
      if (provider.provider === 'anthropic') {
        throw new Error('network error')
      }
      return stubFactory(provider, spec, overrides)
    }
    registry.setFactory(failOnceFactory)
    registry.addProvider(makeProvider({ provider: 'anthropic', priority: 1 }))
    registry.addProvider(makeProvider({ provider: 'openai', priority: 2, apiKey: 'oai' }))

    const result = registry.getModelWithFallback('chat')
    expect(result.provider).toBe('openai')
    expect(callCount).toBe(2)
  })

  // --- getProviderHealth ---

  it('reports provider health', () => {
    registry.addProvider(makeProvider({ provider: 'anthropic', priority: 1 }))
    const health = registry.getProviderHealth()
    expect(health['anthropic']).toEqual({ state: 'closed', provider: 'anthropic' })
  })

  // --- Middleware ---

  it('registers and lists middlewares', () => {
    const mw: RegistryMiddleware = { name: 'test-mw' }
    registry.use(mw)
    expect(registry.getMiddlewares()).toEqual([mw])
  })

  it('removes middleware by name', () => {
    registry.use({ name: 'keep' })
    registry.use({ name: 'remove' })
    const removed = registry.removeMiddleware('remove')
    expect(removed).toBe(true)
    expect(registry.getMiddlewares().map(m => m.name)).toEqual(['keep'])
  })

  it('returns false when removing non-existent middleware', () => {
    expect(registry.removeMiddleware('nope')).toBe(false)
  })

  // --- setFactory ---

  it('allows overriding the model factory', () => {
    const custom: ModelFactory = (_p, _s, _o) =>
      ({ _custom: true }) as unknown as BaseChatModel
    registry.setFactory(custom)
    registry.addProvider(makeProvider())
    const model = registry.getModel('chat') as unknown as Record<string, unknown>
    expect(model['_custom']).toBe(true)
  })
})
