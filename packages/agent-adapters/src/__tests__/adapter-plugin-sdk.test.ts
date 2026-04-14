import { describe, it, expect, vi } from 'vitest'
import { defineAdapterPlugin, isAdapterPlugin } from '../plugin/adapter-plugin-sdk.js'
import { AdapterPluginLoader } from '../plugin/adapter-plugin-loader.js'
import type { AgentCLIAdapter } from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'

function createMockAdapter(): AgentCLIAdapter {
  return {
    providerId: 'test-provider',
    async *execute() { /* noop */ },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() { return { healthy: true, providerId: 'test-provider', sdkInstalled: true, cliAvailable: false } as unknown as ReturnType<AgentCLIAdapter['healthCheck']> },
    configure() {},
    getCapabilities() { return { supportsResume: false, supportsFork: false, supportsToolCalls: false, supportsStreaming: false, supportsCostUsage: false } },
  } as unknown as AgentCLIAdapter
}

describe('defineAdapterPlugin', () => {
  it('creates a plugin with type marker', () => {
    const plugin = defineAdapterPlugin({
      id: 'test',
      name: 'Test Provider',
      version: '1.0.0',
      createAdapter: () => createMockAdapter(),
      capabilities: { supportsResume: false, supportsFork: false, supportsToolCalls: true, supportsStreaming: true, supportsCostUsage: false },
    })
    expect(plugin.type).toBe('adapter-plugin')
    expect(plugin.id).toBe('test')
  })

  it('preserves all definition fields', () => {
    const def = {
      id: 'my-llm',
      name: 'My LLM',
      version: '2.0.0',
      createAdapter: () => createMockAdapter(),
      capabilities: { supportsResume: true, supportsFork: false, supportsToolCalls: true, supportsStreaming: true, supportsCostUsage: true },
    }
    const plugin = defineAdapterPlugin(def)
    expect(plugin.name).toBe('My LLM')
    expect(plugin.version).toBe('2.0.0')
    expect(plugin.capabilities.supportsResume).toBe(true)
  })
})

describe('isAdapterPlugin', () => {
  it('validates correct plugin', () => {
    const plugin = defineAdapterPlugin({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      createAdapter: () => createMockAdapter(),
      capabilities: { supportsResume: false, supportsFork: false, supportsToolCalls: false, supportsStreaming: false, supportsCostUsage: false },
    })
    expect(isAdapterPlugin(plugin)).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(isAdapterPlugin(null)).toBe(false)
    expect(isAdapterPlugin('string')).toBe(false)
    expect(isAdapterPlugin(42)).toBe(false)
  })

  it('rejects objects without type marker', () => {
    expect(isAdapterPlugin({ id: 'test' })).toBe(false)
  })
})

describe('AdapterPluginLoader', () => {
  it('registers plugin adapter in registry', () => {
    const mockRegistry = { register: vi.fn() } as unknown as AdapterRegistry
    const loader = new AdapterPluginLoader(mockRegistry)
    const plugin = defineAdapterPlugin({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      createAdapter: () => createMockAdapter(),
      capabilities: { supportsResume: false, supportsFork: false, supportsToolCalls: false, supportsStreaming: false, supportsCostUsage: false },
    })

    loader.registerPlugin(plugin)
    expect(mockRegistry.register).toHaveBeenCalledOnce()
  })

  it('lists loaded plugins', () => {
    const mockRegistry = { register: vi.fn() } as unknown as AdapterRegistry
    const loader = new AdapterPluginLoader(mockRegistry)
    const plugin = defineAdapterPlugin({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      createAdapter: () => createMockAdapter(),
      capabilities: { supportsResume: false, supportsFork: false, supportsToolCalls: false, supportsStreaming: false, supportsCostUsage: false },
    })

    loader.registerPlugin(plugin)
    expect(loader.listPlugins()).toHaveLength(1)
    expect(loader.getPlugin('test')?.id).toBe('test')
  })

  it('passes config to createAdapter', () => {
    const mockRegistry = { register: vi.fn() } as unknown as AdapterRegistry
    const loader = new AdapterPluginLoader(mockRegistry)
    const createAdapter = vi.fn().mockReturnValue(createMockAdapter())
    const plugin = defineAdapterPlugin({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      createAdapter,
      capabilities: { supportsResume: false, supportsFork: false, supportsToolCalls: false, supportsStreaming: false, supportsCostUsage: false },
    })

    loader.registerPlugin(plugin, { apiKey: 'xxx' })
    expect(createAdapter).toHaveBeenCalledWith({ apiKey: 'xxx' })
  })
})
