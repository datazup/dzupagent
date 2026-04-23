import { describe, it, expect } from 'vitest'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
  RoutingDecision,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[] = [],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) {
        yield event
      }
    },
    async *resumeSession(
      _sessionId: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

describe('ProviderAdapterRegistry lifecycle', () => {
  const task: TaskDescriptor = { prompt: 'test task', tags: [] }
  const input: AgentInput = { prompt: 'test input' }

  const router = {
    name: 'test-router',
    route(_task: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
      return {
        provider: available[0] ?? 'claude',
        reason: 'test',
        confidence: 1,
        fallbackProviders: available.slice(1),
      }
    },
  }

  it('unregister removes adapter', () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(createMockAdapter('claude'))

    expect(registry.get('claude')).toBeDefined()
    const removed = registry.unregister('claude')
    expect(removed).toBe(true)
    expect(registry.get('claude')).toBeUndefined()
    expect(registry.listAdapters()).not.toContain('claude')
  })

  it('unregister returns false for unknown provider', () => {
    const registry = new ProviderAdapterRegistry()
    expect(registry.unregister('claude')).toBe(false)
  })

  it('disable excludes adapter from routing', () => {
    const registry = new ProviderAdapterRegistry().setRouter(router)
    registry.register(
      createMockAdapter('claude', [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]),
    )
    registry.register(
      createMockAdapter('codex', [
        {
          type: 'adapter:completed',
          providerId: 'codex',
          sessionId: 's2',
          result: 'ok',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]),
    )

    registry.disable('claude')

    // getForTask should only find codex
    const { adapter } = registry.getForTask(task)
    expect(adapter.providerId).toBe('codex')
  })

  it('enable re-includes disabled adapter', async () => {
    const registry = new ProviderAdapterRegistry().setRouter(router)
    registry.register(
      createMockAdapter('claude', [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]),
    )

    registry.disable('claude')
    expect(registry.isEnabled('claude')).toBe(false)

    registry.enable('claude')
    expect(registry.isEnabled('claude')).toBe(true)

    const { adapter } = registry.getForTask(task)
    expect(adapter.providerId).toBe('claude')
  })

  it('isEnabled returns correct state', () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(createMockAdapter('claude'))

    expect(registry.isEnabled('claude')).toBe(true)
    registry.disable('claude')
    expect(registry.isEnabled('claude')).toBe(false)
    registry.enable('claude')
    expect(registry.isEnabled('claude')).toBe(true)

    // Not registered at all
    expect(registry.isEnabled('codex')).toBe(false)
  })

  it('disabled adapter excluded from getForTask', () => {
    const registry = new ProviderAdapterRegistry().setRouter(router)
    registry.register(createMockAdapter('claude'))

    registry.disable('claude')

    expect(() => registry.getForTask(task)).toThrow('No healthy adapters available')
  })

  it('disabled adapter excluded from health status', async () => {
    const registry = new ProviderAdapterRegistry()
    registry.register(createMockAdapter('claude'))

    registry.disable('claude')

    const health = await registry.getHealthStatus()
    // Disabled adapters still appear but marked unhealthy with 'disabled' error
    expect(health['claude']).toBeDefined()
    expect(health['claude']!.healthy).toBe(false)
    expect(health['claude']!.lastError).toBe('disabled')
  })

  it('unregistered adapter cannot be enabled', () => {
    const registry = new ProviderAdapterRegistry()
    // enable on non-existent adapter returns false (nothing to delete from set)
    expect(registry.enable('claude')).toBe(false)
  })

  it('disabled adapter excluded from executeWithFallback', async () => {
    const registry = new ProviderAdapterRegistry().setRouter(router)
    registry.register(
      createMockAdapter('claude', [
        {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]),
    )
    registry.register(
      createMockAdapter('codex', [
        {
          type: 'adapter:completed',
          providerId: 'codex',
          sessionId: 's2',
          result: 'fallback',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ]),
    )

    registry.disable('claude')

    const events = await collectEvents(registry.executeWithFallback(input, task))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    expect(completed!.providerId).toBe('codex')

    // Claude should not appear in any events
    const claudeEvents = events.filter(
      (e) => 'providerId' in e && e.providerId === 'claude',
    )
    expect(claudeEvents).toHaveLength(0)
  })
})
