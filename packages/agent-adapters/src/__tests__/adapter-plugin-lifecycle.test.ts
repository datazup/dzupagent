import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdapterPluginLoader } from '../plugin/adapter-plugin-loader.js'
import { defineAdapterPlugin } from '../plugin/adapter-plugin-sdk.js'
import type { AdapterPlugin } from '../plugin/adapter-plugin-sdk.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
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

function createTestPlugin(
  id: string,
  providerId: AdapterProviderId,
  opts?: { onUnload?: () => Promise<void> | void },
): AdapterPlugin {
  return defineAdapterPlugin({
    id,
    name: `Test Plugin (${id})`,
    version: '1.0.0',
    createAdapter: () => createMockAdapter(providerId),
    capabilities: {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: false,
      supportsCostUsage: false,
    },
    onUnload: opts?.onUnload,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterPluginLoader lifecycle', () => {
  let registry: ProviderAdapterRegistry
  let loader: AdapterPluginLoader

  beforeEach(() => {
    registry = new ProviderAdapterRegistry()
    loader = new AdapterPluginLoader(registry)
  })

  // -------------------------------------------------------------------------
  // registerPlugin / listPlugins / getPlugin
  // -------------------------------------------------------------------------
  describe('registerPlugin', () => {
    it('registers a plugin and its adapter in the registry', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      expect(loader.listPlugins()).toHaveLength(1)
      expect(loader.getPlugin('test-plugin')).toBe(plugin)
      expect(registry.listAdapters()).toContain('claude')
    })
  })

  // -------------------------------------------------------------------------
  // unregisterPlugin
  // -------------------------------------------------------------------------
  describe('unregisterPlugin', () => {
    it('removes the plugin from the loaded list and unregisters the adapter', async () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      const result = await loader.unregisterPlugin('test-plugin')

      expect(result).toBe(true)
      expect(loader.listPlugins()).toHaveLength(0)
      expect(loader.getPlugin('test-plugin')).toBeUndefined()
      expect(registry.listAdapters()).not.toContain('claude')
    })

    it('calls onUnload when defined', async () => {
      const onUnload = vi.fn()
      const plugin = createTestPlugin('test-plugin', 'claude', { onUnload })
      loader.registerPlugin(plugin)

      await loader.unregisterPlugin('test-plugin')

      expect(onUnload).toHaveBeenCalledOnce()
    })

    it('awaits async onUnload', async () => {
      const callOrder: string[] = []
      const onUnload = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 5))
        callOrder.push('unloaded')
      })
      const plugin = createTestPlugin('test-plugin', 'claude', { onUnload })
      loader.registerPlugin(plugin)

      await loader.unregisterPlugin('test-plugin')
      callOrder.push('after-unregister')

      expect(callOrder).toEqual(['unloaded', 'after-unregister'])
    })

    it('returns false for non-existent plugin', async () => {
      const result = await loader.unregisterPlugin('nonexistent')
      expect(result).toBe(false)
    })

    it('does not call onUnload when plugin has none', async () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      // Should not throw
      const result = await loader.unregisterPlugin('test-plugin')
      expect(result).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // disablePlugin / enablePlugin / isPluginEnabled
  // -------------------------------------------------------------------------
  describe('disablePlugin', () => {
    it('disables the adapter in the registry', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      const result = loader.disablePlugin('test-plugin')

      expect(result).toBe(true)
      expect(loader.isPluginEnabled('test-plugin')).toBe(false)
    })

    it('returns false for non-existent plugin', () => {
      expect(loader.disablePlugin('nonexistent')).toBe(false)
    })
  })

  describe('enablePlugin', () => {
    it('re-enables a disabled adapter', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      loader.disablePlugin('test-plugin')
      expect(loader.isPluginEnabled('test-plugin')).toBe(false)

      const result = loader.enablePlugin('test-plugin')
      expect(result).toBe(true)
      expect(loader.isPluginEnabled('test-plugin')).toBe(true)
    })

    it('returns false for non-existent plugin', () => {
      expect(loader.enablePlugin('nonexistent')).toBe(false)
    })
  })

  describe('isPluginEnabled', () => {
    it('returns true for a newly registered plugin', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      expect(loader.isPluginEnabled('test-plugin')).toBe(true)
    })

    it('returns false for non-existent plugin', () => {
      expect(loader.isPluginEnabled('nonexistent')).toBe(false)
    })

    it('reflects disable/enable toggles', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      expect(loader.isPluginEnabled('test-plugin')).toBe(true)
      loader.disablePlugin('test-plugin')
      expect(loader.isPluginEnabled('test-plugin')).toBe(false)
      loader.enablePlugin('test-plugin')
      expect(loader.isPluginEnabled('test-plugin')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Disabled plugin is not routable
  // -------------------------------------------------------------------------
  describe('disabled plugin routing', () => {
    it('disabled plugin adapter is not included in enabled adapters', () => {
      const plugin = createTestPlugin('test-plugin', 'claude')
      loader.registerPlugin(plugin)

      loader.disablePlugin('test-plugin')

      // The adapter is still listed but not enabled
      expect(registry.listAdapters()).toContain('claude')
      expect(registry.isEnabled('claude')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Multiple plugins
  // -------------------------------------------------------------------------
  describe('multiple plugins', () => {
    it('manages multiple plugins independently', async () => {
      const onUnload1 = vi.fn()
      const plugin1 = createTestPlugin('p1', 'claude', { onUnload: onUnload1 })
      const plugin2 = createTestPlugin('p2', 'codex')

      loader.registerPlugin(plugin1)
      loader.registerPlugin(plugin2)

      expect(loader.listPlugins()).toHaveLength(2)

      // Disable one, the other is unaffected
      loader.disablePlugin('p1')
      expect(loader.isPluginEnabled('p1')).toBe(false)
      expect(loader.isPluginEnabled('p2')).toBe(true)

      // Unregister one, the other remains
      await loader.unregisterPlugin('p1')
      expect(onUnload1).toHaveBeenCalledOnce()
      expect(loader.listPlugins()).toHaveLength(1)
      expect(loader.getPlugin('p2')).toBeDefined()
      expect(registry.listAdapters()).toContain('codex')
      expect(registry.listAdapters()).not.toContain('claude')
    })
  })
})
