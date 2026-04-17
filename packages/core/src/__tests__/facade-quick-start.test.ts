import { describe, it, expect, beforeEach } from 'vitest'
import {
  createQuickAgent,
  createContainer,
  createEventBus,
  ModelRegistry,
  ForgeError,
  invokeWithTimeout,
  SSETransformer,
  DEFAULT_CONFIG,
  resolveConfig,
  mergeConfigs,
} from '../facades/quick-start.js'
import type {
  QuickAgentOptions,
  QuickAgentResult,
  DzupEventBus,
  ForgeContainer,
} from '../facades/quick-start.js'

// ---------------------------------------------------------------------------
// createQuickAgent — one-call bootstrap
// ---------------------------------------------------------------------------

describe('createQuickAgent', () => {
  it('returns container, eventBus, and registry', () => {
    const result = createQuickAgent({ provider: 'anthropic', apiKey: 'test-key' })
    expect(result).toHaveProperty('container')
    expect(result).toHaveProperty('eventBus')
    expect(result).toHaveProperty('registry')
  })

  it('registers eventBus and registry in the container as singletons', () => {
    const { container, eventBus, registry } = createQuickAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
    })
    expect(container.get('eventBus')).toBe(eventBus)
    expect(container.get('registry')).toBe(registry)
    // Second call still returns same instance (lazy singleton)
    expect(container.get('eventBus')).toBe(eventBus)
  })

  it('uses provider-specific default model names when none given', () => {
    const { registry } = createQuickAgent({ provider: 'anthropic', apiKey: 'k' })
    // Registry should be configured — getSpec should return something
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec).not.toBeNull()
    expect(chatSpec!.name).toBe('claude-haiku-4-20250514')

    const codegenSpec = registry.getSpec('codegen')
    expect(codegenSpec).not.toBeNull()
    expect(codegenSpec!.name).toBe('claude-sonnet-4-20250514')
  })

  it('applies openai defaults when provider is openai', () => {
    const { registry } = createQuickAgent({ provider: 'openai', apiKey: 'k' })
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec!.name).toBe('gpt-4o-mini')
    const codegenSpec = registry.getSpec('codegen')
    expect(codegenSpec!.name).toBe('gpt-4o')
  })

  it('respects custom chatModel and codegenModel', () => {
    const { registry } = createQuickAgent({
      provider: 'openai',
      apiKey: 'k',
      chatModel: 'my-custom-chat',
      codegenModel: 'my-custom-codegen',
    })
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec!.name).toBe('my-custom-chat')
    const codegenSpec = registry.getSpec('codegen')
    expect(codegenSpec!.name).toBe('my-custom-codegen')
  })

  it('applies custom maxTokens', () => {
    const { registry } = createQuickAgent({
      provider: 'anthropic',
      apiKey: 'k',
      chatMaxTokens: 2048,
      codegenMaxTokens: 16384,
    })
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec!.maxTokens).toBe(2048)
    const codegenSpec = registry.getSpec('codegen')
    expect(codegenSpec!.maxTokens).toBe(16384)
  })

  it('defaults chatMaxTokens to 4096 and codegenMaxTokens to 8192', () => {
    const { registry } = createQuickAgent({ provider: 'anthropic', apiKey: 'k' })
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec!.maxTokens).toBe(4096)
    const codegenSpec = registry.getSpec('codegen')
    expect(codegenSpec!.maxTokens).toBe(8192)
  })

  it('falls back to custom provider defaults for unknown provider string', () => {
    const { registry } = createQuickAgent({ provider: 'custom', apiKey: 'k' })
    const chatSpec = registry.getSpec('chat')
    expect(chatSpec!.name).toBe('default')
  })

  it('marks the registry as configured', () => {
    const { registry } = createQuickAgent({ provider: 'anthropic', apiKey: 'k' })
    expect(registry.isConfigured()).toBe(true)
  })

  it('lists the provider name', () => {
    const { registry } = createQuickAgent({ provider: 'openrouter', apiKey: 'k' })
    expect(registry.listProviders()).toEqual(['openrouter'])
  })
})

// ---------------------------------------------------------------------------
// ForgeContainer — DI container behavior
// ---------------------------------------------------------------------------

describe('ForgeContainer', () => {
  let container: ForgeContainer

  beforeEach(() => {
    container = createContainer()
  })

  it('throws when getting an unregistered service', () => {
    expect(() => container.get('nonexistent')).toThrow('not registered')
  })

  it('register returns this for chaining', () => {
    const returned = container.register('a', () => 1)
    expect(returned).toBe(container)
  })

  it('lists registered service names', () => {
    container.register('alpha', () => 'a')
    container.register('beta', () => 'b')
    expect(container.list()).toEqual(['alpha', 'beta'])
  })

  it('re-registration clears cached instance', () => {
    container.register('svc', () => ({ v: 1 }))
    const first = container.get('svc')
    container.register('svc', () => ({ v: 2 }))
    const second = container.get('svc')
    expect(first).not.toBe(second)
    expect((second as { v: number }).v).toBe(2)
  })

  it('reset clears instances but keeps factories', () => {
    container.register('svc', () => ({ val: Math.random() }))
    const before = container.get('svc')
    container.reset()
    const after = container.get('svc')
    expect(before).not.toBe(after)
    expect(container.has('svc')).toBe(true)
  })

  it('factory receives the container for dependency resolution', () => {
    container.register('dep', () => 42)
    container.register('svc', (c) => ({ dep: c.get<number>('dep') }))
    const svc = container.get<{ dep: number }>('svc')
    expect(svc.dep).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// DzupEventBus — behavioral tests
// ---------------------------------------------------------------------------

describe('DzupEventBus via quick-start facade', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  it('on() handler receives emitted events', () => {
    const received: unknown[] = []
    bus.on('agent:started', (e) => { received.push(e) })
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    expect(received).toHaveLength(1)
    expect((received[0] as Record<string, unknown>).agentId).toBe('a1')
  })

  it('once() auto-unsubscribes after first call', () => {
    let count = 0
    bus.once('agent:started', () => { count++ })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    expect(count).toBe(1)
  })

  it('unsubscribe function stops future events', () => {
    let count = 0
    const unsub = bus.on('agent:started', () => { count++ })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    unsub()
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    expect(count).toBe(1)
  })

  it('onAny receives all event types', () => {
    const types: string[] = []
    bus.onAny((e) => { types.push(e.type) })
    bus.emit({ type: 'agent:started', agentId: 'a', runId: 'r' })
    bus.emit({ type: 'tool:called', toolName: 't', input: {} })
    expect(types).toEqual(['agent:started', 'tool:called'])
  })
})

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

describe('config helpers via quick-start facade', () => {
  it('DEFAULT_CONFIG is a non-null object', () => {
    expect(DEFAULT_CONFIG).toBeDefined()
    expect(typeof DEFAULT_CONFIG).toBe('object')
  })

  it('mergeConfigs produces a valid config from config layers', () => {
    const merged = mergeConfigs(
      { name: 'base', priority: 0, config: {} },
      { name: 'override', priority: 1, config: { verbose: true } },
    )
    expect(merged).toBeDefined()
    expect(typeof merged).toBe('object')
  })
})
