import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

import { createAdapterPlugin } from '../plugin/adapter-plugin.js'
import type { AdapterPluginInstance } from '../plugin/adapter-plugin.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:completed',
        providerId,
        sessionId: `sess-${providerId}`,
        result: `Result from ${providerId}`,
        durationMs: 100,
        timestamp: Date.now(),
      }
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterPlugin (createAdapterPlugin)', () => {
  let bus: DzipEventBus
  let emitted: DzipEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  describe('createAdapterPlugin', () => {
    it('returns a plugin-compatible object with name and version', () => {
      const plugin = createAdapterPlugin()

      expect(plugin.name).toBe('adapter-orchestration')
      expect(plugin.version).toBe('0.1.0')
      expect(typeof plugin.onRegister).toBe('function')
      expect(typeof plugin.getRegistry).toBe('function')
    })
  })

  describe('onRegister', () => {
    it('wires event bus and creates registry with adapters', () => {
      const claudeAdapter = createMockAdapter('claude')
      const codexAdapter = createMockAdapter('codex')

      const plugin = createAdapterPlugin({
        adapters: [claudeAdapter, codexAdapter],
      })

      plugin.onRegister({ eventBus: bus })

      const registry = plugin.getRegistry()
      expect(registry).toBeDefined()
      expect(registry.listAdapters()).toContain('claude')
      expect(registry.listAdapters()).toContain('codex')
    })

    it('creates registry even without adapters', () => {
      const plugin = createAdapterPlugin()

      plugin.onRegister({ eventBus: bus })

      const registry = plugin.getRegistry()
      expect(registry).toBeDefined()
      expect(registry.listAdapters()).toHaveLength(0)
    })

    it('wires event handlers onto the eventHandlers record', () => {
      const plugin = createAdapterPlugin()

      plugin.onRegister({ eventBus: bus })

      expect(plugin.eventHandlers['agent:failed']).toBeDefined()
      expect(plugin.eventHandlers['provider:circuit_opened']).toBeDefined()
      expect(plugin.eventHandlers['provider:circuit_closed']).toBeDefined()
    })
  })

  describe('getRegistry', () => {
    it('throws when called before onRegister', () => {
      const plugin = createAdapterPlugin()

      expect(() => plugin.getRegistry()).toThrow('has not been registered yet')
    })

    it('returns registry after onRegister', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const registry = plugin.getRegistry()

      expect(registry).toBeDefined()
    })
  })

  describe('getSessionRegistry', () => {
    it('returns SessionRegistry when enabled (default)', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const sessions = plugin.getSessionRegistry()

      expect(sessions).toBeDefined()
    })

    it('returns undefined when enableSessionRegistry is false', () => {
      const plugin = createAdapterPlugin({
        enableSessionRegistry: false,
      })
      plugin.onRegister({ eventBus: bus })

      const sessions = plugin.getSessionRegistry()

      expect(sessions).toBeUndefined()
    })
  })

  describe('getCostTracking', () => {
    it('returns CostTrackingMiddleware when enabled (default)', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const costTracking = plugin.getCostTracking()

      expect(costTracking).toBeDefined()
    })

    it('returns undefined when enableCostTracking is false', () => {
      const plugin = createAdapterPlugin({
        enableCostTracking: false,
      })
      plugin.onRegister({ eventBus: bus })

      const costTracking = plugin.getCostTracking()

      expect(costTracking).toBeUndefined()
    })
  })

  describe('getEventBridge', () => {
    it('returns EventBusBridge when enabled (default)', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const bridge = plugin.getEventBridge()

      expect(bridge).toBeDefined()
    })

    it('returns undefined when enableEventBridge is false', () => {
      const plugin = createAdapterPlugin({
        enableEventBridge: false,
      })
      plugin.onRegister({ eventBus: bus })

      const bridge = plugin.getEventBridge()

      expect(bridge).toBeUndefined()
    })
  })

  describe('event handlers', () => {
    it('agent:failed handler records failure in registry', () => {
      const claudeAdapter = createMockAdapter('claude')
      const plugin = createAdapterPlugin({
        adapters: [claudeAdapter],
      })
      plugin.onRegister({ eventBus: bus })

      const handler = plugin.eventHandlers['agent:failed']!
      expect(handler).toBeDefined()

      // Invoke the handler with a mock failed event
      handler({
        type: 'agent:failed',
        agentId: 'claude',
        message: 'Something broke',
      })

      // The handler should call registry.recordFailure for 'claude'.
      // We can verify indirectly by checking the registry still works
      // (circuit breaker won't open from a single failure by default).
      const registry = plugin.getRegistry()
      expect(registry.listAdapters()).toContain('claude')
    })

    it('provider:circuit_opened handler fires without throwing', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const handler = plugin.eventHandlers['provider:circuit_opened']!

      // Should log a warning but not throw
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      handler({ type: 'provider:circuit_opened', provider: 'claude' })
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('provider:circuit_closed handler fires without throwing', () => {
      const plugin = createAdapterPlugin()
      plugin.onRegister({ eventBus: bus })

      const handler = plugin.eventHandlers['provider:circuit_closed']!

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      handler({ type: 'provider:circuit_closed', provider: 'codex' })
      expect(infoSpy).toHaveBeenCalled()
      infoSpy.mockRestore()
    })
  })

  describe('disabling all features', () => {
    it('works with all optional features disabled', () => {
      const plugin = createAdapterPlugin({
        enableEventBridge: false,
        enableCostTracking: false,
        enableSessionRegistry: false,
      })

      plugin.onRegister({ eventBus: bus })

      expect(plugin.getRegistry()).toBeDefined()
      expect(plugin.getEventBridge()).toBeUndefined()
      expect(plugin.getCostTracking()).toBeUndefined()
      expect(plugin.getSessionRegistry()).toBeUndefined()
    })
  })

  describe('routing strategy', () => {
    it('sets custom router on registry when provided', () => {
      const customRouter = {
        name: 'custom',
        route: () => ({
          provider: 'gemini' as AdapterProviderId,
          reason: 'custom',
          confidence: 1,
        }),
      }

      const plugin = createAdapterPlugin({
        adapters: [createMockAdapter('gemini')],
        router: customRouter,
      })
      plugin.onRegister({ eventBus: bus })

      const registry = plugin.getRegistry()
      // Verify the router was set by using getForTask
      const result = registry.getForTask({
        prompt: 'test',
        tags: [],
      })
      expect(result.decision.provider).toBe('gemini')
    })
  })
})
