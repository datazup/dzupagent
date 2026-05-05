import { describe, expect, it } from 'vitest'

import { AdapterHealthMonitor } from '../registry/health-monitor.js'
import type { AdapterProviderId, AgentCLIAdapter, AgentEvent, AgentInput } from '../types.js'

function makeAdapter(providerId: AdapterProviderId, healthy = true): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    async *resumeSession(_s: string, _i: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return {
        healthy,
        providerId,
        sdkInstalled: healthy,
        cliAvailable: healthy,
        ...(healthy ? {} : { lastError: 'unhealthy' }),
      }
    },
    configure() {},
  }
}

describe('AdapterHealthMonitor', () => {
  it('opens the circuit after threshold consecutive failures and reports transition', () => {
    const monitor = new AdapterHealthMonitor({ failureThreshold: 2 })
    monitor.ensureBreaker('claude')

    const t1 = monitor.recordFailure('claude')
    expect(t1.opened).toBe(false)
    expect(monitor.getCircuitState('claude')).toBe('closed')

    const t2 = monitor.recordFailure('claude')
    expect(t2.opened).toBe(true)
    expect(monitor.getCircuitState('claude')).toBe('open')
    expect(monitor.canExecute('claude')).toBe(false)
  })

  it('recordSuccess closes an open circuit and reports the transition', () => {
    const monitor = new AdapterHealthMonitor({ failureThreshold: 1 })
    monitor.ensureBreaker('codex')
    monitor.recordFailure('codex')
    expect(monitor.getCircuitState('codex')).toBe('open')

    const t = monitor.recordSuccess('codex')
    expect(t.closed).toBe(true)
    expect(monitor.getCircuitState('codex')).toBe('closed')
    expect(monitor.canExecute('codex')).toBe(true)
  })

  it('forget removes all bookkeeping for an adapter', () => {
    const monitor = new AdapterHealthMonitor({ failureThreshold: 1 })
    monitor.ensureBreaker('claude')
    monitor.recordFailure('claude')
    expect(monitor.getCircuitState('claude')).toBe('open')

    monitor.forget('claude')
    expect(monitor.getCircuitState('claude')).toBe('closed') // back to default
    expect(monitor.canExecute('claude')).toBe(true)
  })

  it('getHealthStatus surfaces health for each adapter and marks disabled adapters unhealthy', async () => {
    const monitor = new AdapterHealthMonitor()
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      ['claude', makeAdapter('claude', true)],
      ['codex', makeAdapter('codex', true)],
    ])
    const disabled = new Set<AdapterProviderId>(['codex'])

    const status = await monitor.getHealthStatus(adapters, disabled)
    expect(status.claude?.healthy).toBe(true)
    expect(status.codex?.healthy).toBe(false)
    expect(status.codex?.lastError).toBe('disabled')
  })

  it('getDetailedHealth aggregates per-adapter detail with circuit state and counters', async () => {
    const monitor = new AdapterHealthMonitor({ failureThreshold: 5 })
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      ['claude', makeAdapter('claude', true)],
    ])
    monitor.ensureBreaker('claude')
    monitor.recordFailure('claude')

    const detailed = await monitor.getDetailedHealth(adapters, new Set())
    expect(detailed.status).toBe('healthy') // healthCheck still returned healthy
    expect(detailed.adapters.claude?.consecutiveFailures).toBe(1)
    expect(detailed.adapters.claude?.circuitState).toBe('closed')
    expect(typeof detailed.timestamp).toBe('number')
  })
})
