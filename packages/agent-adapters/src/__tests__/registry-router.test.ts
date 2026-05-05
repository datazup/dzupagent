import { describe, expect, it } from 'vitest'
import { ForgeError } from '@dzupagent/core'

import { AdapterHealthMonitor } from '../registry/health-monitor.js'
import { AdapterRegistryCore } from '../registry/registry-core.js'
import { AdapterRegistryRouter } from '../registry/registry-router.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
} from '../types.js'
import { collectEvents } from './test-helpers.js'

function makeAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[] = [],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const e of events) yield e
    },
    async *resumeSession(_s: string, _i: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      return
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

const successEvents = (providerId: AdapterProviderId): AgentEvent[] => [
  { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() },
  {
    type: 'adapter:completed',
    providerId,
    sessionId: 's',
    result: 'ok',
    durationMs: 1,
    timestamp: Date.now(),
  },
]

const failEvents = (providerId: AdapterProviderId): AgentEvent[] => [
  { type: 'adapter:started', providerId, sessionId: 's', timestamp: Date.now() },
  {
    type: 'adapter:failed',
    providerId,
    error: 'bad',
    code: 'ADAPTER_EXECUTION_FAILED',
    timestamp: Date.now(),
  },
]

const task: TaskDescriptor = { prompt: 'p', tags: [] }
const input: AgentInput = { prompt: 'p' }

const fixedRouter: TaskRoutingStrategy = {
  name: 'fixed',
  route(_t: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
    return {
      provider: available[0] ?? 'claude',
      reason: 'fixed',
      confidence: 1,
      fallbackProviders: available.slice(1),
    }
  },
}

function buildRouter(...adapters: AgentCLIAdapter[]): AdapterRegistryRouter {
  const health = new AdapterHealthMonitor()
  const core = new AdapterRegistryCore(health)
  for (const a of adapters) core.register(a)
  const router = new AdapterRegistryRouter(core, health, undefined)
  router.setStrategy(fixedRouter)
  return router
}

describe('AdapterRegistryRouter', () => {
  it('getForTask throws ALL_ADAPTERS_EXHAUSTED when no healthy adapters exist', () => {
    const health = new AdapterHealthMonitor()
    const core = new AdapterRegistryCore(health)
    const router = new AdapterRegistryRouter(core, health, undefined)
    expect(() => router.getForTask(task)).toThrow(ForgeError)
  })

  it('executeWithFallback returns success on first adapter and emits routing progress', async () => {
    const router = buildRouter(makeAdapter('claude', successEvents('claude')))
    const events = await collectEvents(router.executeWithFallback(input, task))

    const progress = events.filter((e) => e.type === 'adapter:progress')
    expect(progress.length).toBeGreaterThanOrEqual(2) // routing + primary
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'claude')).toBe(true)
  })

  it('falls back to next provider when primary emits failure event', async () => {
    const router = buildRouter(
      makeAdapter('claude', failEvents('claude')),
      makeAdapter('codex', successEvents('codex')),
    )
    const events = await collectEvents(router.executeWithFallback(input, task))

    expect(events.some((e) => e.type === 'adapter:failed' && e.providerId === 'claude')).toBe(true)
    expect(events.some((e) => e.type === 'adapter:completed' && e.providerId === 'codex')).toBe(true)
  })

  it('records circuit-breaker failures so unhealthy adapters are skipped on next call', async () => {
    const health = new AdapterHealthMonitor({ failureThreshold: 1 })
    const core = new AdapterRegistryCore(health)
    core.register(makeAdapter('claude', failEvents('claude')))
    core.register(makeAdapter('codex', successEvents('codex')))
    const router = new AdapterRegistryRouter(core, health, undefined)
    router.setStrategy(fixedRouter)

    await collectEvents(router.executeWithFallback(input, task))
    expect(health.getCircuitState('claude')).toBe('open')

    // Second call: claude is already open, codex should be primary
    const events = await collectEvents(router.executeWithFallback(input, task))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed?.providerId).toBe('codex')
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when every adapter fails', async () => {
    const router = buildRouter(
      makeAdapter('claude', failEvents('claude')),
      makeAdapter('codex', failEvents('codex')),
    )
    await expect(collectEvents(router.executeWithFallback(input, task))).rejects.toThrow(
      'All adapters failed',
    )
  })
})
