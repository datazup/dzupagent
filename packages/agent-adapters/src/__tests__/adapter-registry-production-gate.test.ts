import { describe, it, expect } from 'vitest'

import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { stubCapabilities } from './adapter-capability-stub.js'
import { PiAdapter, OpenCodeAdapter, ClineAdapter } from '../providers.js'
import { HTTP_ROUTABLE_PROVIDER_IDS, getProductProviders, getRunnableProviders } from '../provider-catalog.js'

function createMockAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    getCapabilities: () => stubCapabilities(),
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
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

describe('ProviderAdapterRegistry production gate', () => {
  it.each(['pi', 'opencode', 'cline'] as const)('registers %s generically while excluding it from product, HTTP and runnable routes', (id) => {
    const adapters = {
      pi: new PiAdapter(),
      opencode: new OpenCodeAdapter(),
      cline: new ClineAdapter({ profileDir: '/fixture/profile', provider: 'fixture', model: 'fixture' }),
    }
    const adapter = adapters[id]
    const registry = new ProviderAdapterRegistry()
    expect(registry.register(adapter)).toBe(registry)
    expect(registry.get(id)).toBe(adapter)
    expect(registry.listAdapters()).toEqual([id])
    const production = new ProviderAdapterRegistry()
    production.registerProductionAdapters([adapter])
    expect(production.listAdapters()).toEqual([])
    expect(getProductProviders()).not.toContain(id)
    expect(getRunnableProviders()).not.toContain(id)
    expect(HTTP_ROUTABLE_PROVIDER_IDS).not.toContain(id)
  })

  describe('registerProductionAdapters', () => {
    it('registers adapter with providerId "claude" (productIntegrated: true)', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerProductionAdapters([createMockAdapter('claude')])

      expect(registry.listAdapters()).toContain('claude')
      expect(registry.listAdapters()).toHaveLength(1)
    })

    it('registers adapter with providerId "codex" (productIntegrated: true)', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerProductionAdapters([createMockAdapter('codex')])

      expect(registry.listAdapters()).toContain('codex')
      expect(registry.listAdapters()).toHaveLength(1)
    })

    it('does NOT register adapter with providerId "goose" (productIntegrated: false)', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerProductionAdapters([createMockAdapter('goose')])

      expect(registry.listAdapters()).not.toContain('goose')
      expect(registry.listAdapters()).toHaveLength(0)
    })

    it('registers adapter with providerId "crush" after Codev product integration', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerProductionAdapters([createMockAdapter('crush')])

      expect(registry.listAdapters()).toContain('crush')
      expect(registry.listAdapters()).toHaveLength(1)
    })

    it('does NOT register adapter with providerId "gemini-sdk" (productIntegrated: false)', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerProductionAdapters([
        createMockAdapter('gemini-sdk'),
      ])

      expect(registry.listAdapters()).not.toContain('gemini-sdk')
      expect(registry.listAdapters()).toHaveLength(0)
    })
  })

  describe('registerExperimentalAdapters', () => {
    it('DOES register "goose" when given a valid flag string', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerExperimentalAdapters(
        [createMockAdapter('goose')],
        'enable-experimental',
      )

      expect(registry.listAdapters()).toContain('goose')
      expect(registry.listAdapters()).toHaveLength(1)
    })

    it('throws when flag is empty string', () => {
      const registry = new ProviderAdapterRegistry()

      expect(() =>
        registry.registerExperimentalAdapters(
          [createMockAdapter('goose')],
          '',
        ),
      ).toThrow('registerExperimentalAdapters requires a non-empty flag string opt-in')

      expect(registry.listAdapters()).toHaveLength(0)
    })

    it('does NOT register "claude" (productIntegrated: true, not experimental)', () => {
      const registry = new ProviderAdapterRegistry()
      registry.registerExperimentalAdapters(
        [createMockAdapter('claude')],
        'enable-experimental',
      )

      expect(registry.listAdapters()).not.toContain('claude')
      expect(registry.listAdapters()).toHaveLength(0)
    })
  })
})
