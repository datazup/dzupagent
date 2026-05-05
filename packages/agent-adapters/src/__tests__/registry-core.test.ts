import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { AdapterHealthMonitor } from '../registry/health-monitor.js'
import { AdapterRegistryCore } from '../registry/registry-core.js'
import type { AdapterProviderId, AgentCLIAdapter, AgentEvent, AgentInput } from '../types.js'

function makeAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

describe('AdapterRegistryCore', () => {
  it('registers an adapter and emits provider_registered on the bus', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)
    const bus = createEventBus()
    const captured: any[] = []
    bus.onAny((e) => captured.push(e))
    core.setEventBus(bus)

    core.register(makeAdapter('claude'))

    expect(core.listAdapters()).toEqual(['claude'])
    expect(core.get('claude')).toBeDefined()
    expect(core.isEnabled('claude')).toBe(true)
    expect(captured.some((e: any) => e.type === 'adapter_registry:provider_registered' && e.providerId === 'claude')).toBe(true)
  })

  it('disable/enable toggle excludes from getHealthy and getHealthyProviderIds without unregistering', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)

    core.register(makeAdapter('claude')).register(makeAdapter('codex'))
    expect(core.getHealthyProviderIds()).toEqual(['claude', 'codex'])

    expect(core.disable('claude')).toBe(true)
    expect(core.isEnabled('claude')).toBe(false)
    expect(core.getHealthy('claude')).toBeUndefined()
    expect(core.getHealthyProviderIds()).toEqual(['codex'])

    expect(core.enable('claude')).toBe(true)
    expect(core.isEnabled('claude')).toBe(true)
    expect(core.getHealthyProviderIds()).toEqual(['claude', 'codex'])
  })

  it('unregister forgets adapter and emits provider_deregistered exactly once', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)
    const bus = createEventBus()
    const captured: any[] = []
    bus.onAny((e) => captured.push(e))
    core.setEventBus(bus)

    core.register(makeAdapter('claude'))
    expect(core.unregister('claude')).toBe(true)
    expect(core.unregister('claude')).toBe(false) // already gone
    expect(core.get('claude')).toBeUndefined()

    const deregEvents = captured.filter((e: any) => e.type === 'adapter_registry:provider_deregistered')
    expect(deregEvents).toHaveLength(1)
    expect(deregEvents[0].providerId).toBe('claude')
  })

  it('warmupAll calls warmup on adapters that define it and ignores rejections', async () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)

    const ok = makeAdapter('claude')
    ok.warmup = vi.fn().mockResolvedValue(undefined)
    const fails = makeAdapter('codex')
    fails.warmup = vi.fn().mockRejectedValue(new Error('boom'))

    core.register(ok).register(fails)
    await expect(core.warmupAll()).resolves.toBeUndefined()
    expect(ok.warmup).toHaveBeenCalledTimes(1)
    expect(fails.warmup).toHaveBeenCalledTimes(1)
  })

  it('registerExperimentalAdapters throws when flag is empty', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)
    expect(() => core.registerExperimentalAdapters([makeAdapter('crush')], '')).toThrow(
      'registerExperimentalAdapters requires a non-empty flag string opt-in',
    )
    expect(() => core.registerExperimentalAdapters([makeAdapter('crush')], '   ')).toThrow()
  })
})
