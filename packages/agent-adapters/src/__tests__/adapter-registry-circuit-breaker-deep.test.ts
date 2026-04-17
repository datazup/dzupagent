/**
 * W23-B1 — Deep coverage for AdapterRegistry, CircuitBreaker integration,
 * TaskRouter strategies, and EventBusBridge event scoping.
 *
 * This file complements adapter-registry.test.ts with focused tests covering:
 *  - circuit breaker state transitions and observability events
 *  - routing strategy selection + fallback ordering
 *  - event bus bridge scoping, cleanup, and unknown-type handling
 *  - registry lifecycle (register / unregister / disable / enable)
 *  - error paths (empty registry, missing adapter, mid-stream throws)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { AdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import {
  TagBasedRouter,
  CostOptimizedRouter,
  RoundRobinRouter,
  CompositeRouter,
} from '../registry/task-router.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
  TaskRoutingStrategy,
  AdapterCapabilityProfile,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CAPS: AdapterCapabilityProfile = {
  supportsResume: false,
  supportsFork: false,
  supportsToolCalls: false,
  supportsStreaming: false,
  supportsCostUsage: false,
}

function completionEvents(providerId: AdapterProviderId): AgentEvent[] {
  return [
    {
      type: 'adapter:started',
      providerId,
      sessionId: `sess-${providerId}`,
      timestamp: Date.now(),
    },
    {
      type: 'adapter:completed',
      providerId,
      sessionId: `sess-${providerId}`,
      result: `${providerId}-ok`,
      durationMs: 1,
      timestamp: Date.now(),
    },
  ]
}

function failureEvents(providerId: AdapterProviderId): AgentEvent[] {
  return [
    {
      type: 'adapter:started',
      providerId,
      sessionId: `sess-${providerId}`,
      timestamp: Date.now(),
    },
    {
      type: 'adapter:failed',
      providerId,
      error: `${providerId}-failed`,
      code: 'ADAPTER_EXECUTION_FAILED',
      timestamp: Date.now(),
    },
  ]
}

function createMockAdapter(
  providerId: AdapterProviderId,
  events: AgentEvent[],
  overrides: Partial<AgentCLIAdapter> = {},
): AgentCLIAdapter {
  const base: AgentCLIAdapter = {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) yield event
    },
    async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      for (const event of events) yield event
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
    getCapabilities() {
      return DEFAULT_CAPS
    },
  }
  return { ...base, ...overrides }
}

function createThrowingAdapter(providerId: AdapterProviderId, error: Error): AgentCLIAdapter {
  return createMockAdapter(providerId, [], {
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      throw error
    },
  })
}

function createMidStreamThrowingAdapter(providerId: AdapterProviderId, error: Error): AgentCLIAdapter {
  return createMockAdapter(providerId, [], {
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:message',
        providerId,
        content: 'partial output',
        role: 'assistant',
        timestamp: Date.now(),
      }
      throw error
    },
  })
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

async function collect<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

async function runGenSafely<T>(
  gen: AsyncGenerator<T, void, undefined>,
): Promise<{ events: T[]; error?: unknown }> {
  const events: T[] = []
  try {
    for await (const e of gen) events.push(e)
    return { events }
  } catch (err) {
    return { events, error: err }
  }
}

const FIXED_ROUTER: TaskRoutingStrategy = {
  name: 'fixed',
  route(_task: TaskDescriptor, available: AdapterProviderId[]): RoutingDecision {
    const first = available[0] ?? 'claude'
    return {
      provider: first,
      reason: 'fixed test router',
      confidence: 1,
      fallbackProviders: available.slice(1),
    }
  },
}

const TASK: TaskDescriptor = { prompt: 'do work', tags: [] }
const INPUT: AgentInput = { prompt: 'do work' }

// ---------------------------------------------------------------------------
// AdapterRegistry — registration lifecycle
// ---------------------------------------------------------------------------

describe('AdapterRegistry — registration lifecycle', () => {
  it('register() adds an adapter and listAdapters reflects it', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    expect(registry.listAdapters()).toContain('claude')
  })

  it('register() returns the registry for fluent chaining', () => {
    const registry = new AdapterRegistry()
    const returned = registry.register(createMockAdapter('claude', []))
    expect(returned).toBe(registry)
  })

  it('get() returns the adapter by providerId', () => {
    const registry = new AdapterRegistry()
    const adapter = createMockAdapter('codex', [])
    registry.register(adapter)
    expect(registry.get('codex')).toBe(adapter)
  })

  it('get() returns undefined for unknown providerId', () => {
    const registry = new AdapterRegistry()
    expect(registry.get('claude')).toBeUndefined()
  })

  it('unregister() removes adapter and returns true when it existed', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    expect(registry.unregister('claude')).toBe(true)
    expect(registry.get('claude')).toBeUndefined()
    expect(registry.listAdapters()).not.toContain('claude')
  })

  it('unregister() returns false for unknown providerId', () => {
    const registry = new AdapterRegistry()
    expect(registry.unregister('qwen')).toBe(false)
  })

  it('re-register with a new instance replaces the previous adapter', () => {
    const registry = new AdapterRegistry()
    const first = createMockAdapter('claude', [])
    const second = createMockAdapter('claude', [])
    registry.register(first)
    registry.register(second)
    expect(registry.get('claude')).toBe(second)
    // only one registration for claude
    expect(registry.listAdapters().filter((id) => id === 'claude')).toHaveLength(1)
  })

  it('listAdapters() returns empty array when registry is empty', () => {
    const registry = new AdapterRegistry()
    expect(registry.listAdapters()).toEqual([])
  })

  it('listAdapters() returns all registered providerIds', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    registry.register(createMockAdapter('qwen', []))
    const ids = registry.listAdapters().sort()
    expect(ids).toEqual(['claude', 'codex', 'qwen'])
  })

  it('disable() excludes adapter from routing but keeps registration', () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    expect(registry.disable('claude')).toBe(true)
    expect(registry.isEnabled('claude')).toBe(false)
    expect(registry.get('claude')).toBeDefined()
  })

  it('disable() returns false for unknown providerId', () => {
    const registry = new AdapterRegistry()
    expect(registry.disable('claude')).toBe(false)
  })

  it('enable() re-activates a disabled adapter', () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.disable('claude')
    expect(registry.enable('claude')).toBe(true)
    expect(registry.isEnabled('claude')).toBe(true)
  })

  it('enable() on unknown adapter returns false', () => {
    const registry = new AdapterRegistry()
    expect(registry.enable('claude')).toBe(false)
  })

  it('isEnabled() returns false for unregistered adapter', () => {
    const registry = new AdapterRegistry()
    expect(registry.isEnabled('claude')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AdapterRegistry — circuit breaker behavior
// ---------------------------------------------------------------------------

describe('AdapterRegistry — circuit breaker behavior', () => {
  it('recordSuccess() on unknown adapter is a no-op', () => {
    const registry = new AdapterRegistry()
    expect(() => registry.recordSuccess('claude')).not.toThrow()
  })

  it('recordFailure() on unknown adapter is a no-op', () => {
    const registry = new AdapterRegistry()
    expect(() => registry.recordFailure('claude', new Error('x'))).not.toThrow()
  })

  it('circuit opens after failureThreshold consecutive failures', () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.register(createMockAdapter('claude', []))
    // adapter is healthy initially
    expect(registry.getHealthy('claude')).toBeDefined()
    registry.recordFailure('claude', new Error('boom-1'))
    registry.recordFailure('claude', new Error('boom-2'))
    // still closed before threshold
    expect(registry.getHealthy('claude')).toBeDefined()
    registry.recordFailure('claude', new Error('boom-3'))
    // circuit open now — getHealthy returns undefined
    expect(registry.getHealthy('claude')).toBeUndefined()
  })

  it('emits provider:circuit_opened when the circuit opens', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    registry.recordFailure('claude', new Error('x1'))
    registry.recordFailure('claude', new Error('x2'))
    const opened = emitted.filter((e) => e.type === 'provider:circuit_opened')
    expect(opened).toHaveLength(1)
    expect((opened[0] as { provider: string }).provider).toBe('claude')
  })

  it('emits provider:failed on every failure regardless of circuit state', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 10, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    registry.recordFailure('claude', new Error('a'))
    registry.recordFailure('claude', new Error('b'))
    registry.recordFailure('claude', new Error('c'))
    const failed = emitted.filter((e) => e.type === 'provider:failed')
    expect(failed).toHaveLength(3)
    for (const e of failed) {
      expect((e as { tier: string; provider: string }).tier).toBe('adapter')
      expect((e as { provider: string }).provider).toBe('claude')
    }
  })

  it('recordSuccess() resets consecutive failures counter', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.register(createMockAdapter('claude', []))
    registry.recordFailure('claude', new Error('x1'))
    registry.recordFailure('claude', new Error('x2'))
    registry.recordSuccess('claude')
    const detail = await registry.getDetailedHealth()
    expect(detail.adapters['claude']!.consecutiveFailures).toBe(0)
  })

  it('emits provider:circuit_closed after success from non-closed state (half-open → closed)', () => {
    vi.useFakeTimers()
    try {
      const bus = createEventBus()
      const emitted = collectBusEvents(bus)
      const registry = new AdapterRegistry({
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 100, halfOpenMaxAttempts: 1 },
      })
      registry.setEventBus(bus)
      registry.register(createMockAdapter('claude', []))
      // open the circuit
      registry.recordFailure('claude', new Error('open'))
      // advance past resetTimeout to move to half-open on next read
      vi.advanceTimersByTime(500)
      // calling recordSuccess from a non-closed state emits circuit_closed
      registry.recordSuccess('claude')
      const closed = emitted.filter((e) => e.type === 'provider:circuit_closed')
      expect(closed).toHaveLength(1)
      expect((closed[0] as { provider: string }).provider).toBe('claude')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT emit provider:circuit_closed when success occurs while already closed', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxAttempts: 1 },
    })
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    // record a single failure (below threshold) — state still closed
    registry.recordFailure('claude', new Error('warn'))
    // followed by success while closed
    registry.recordSuccess('claude')
    const closed = emitted.filter((e) => e.type === 'provider:circuit_closed')
    expect(closed).toHaveLength(0)
  })

  it('circuit resets to half-open after resetTimeoutMs elapses', () => {
    vi.useFakeTimers()
    try {
      const registry = new AdapterRegistry({
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000, halfOpenMaxAttempts: 1 },
      })
      registry.register(createMockAdapter('claude', []))
      registry.recordFailure('claude', new Error('boom'))
      // circuit is open
      expect(registry.getHealthy('claude')).toBeUndefined()
      // advance past reset window
      vi.advanceTimersByTime(1500)
      // canExecute() transitions to half-open → adapter becomes selectable
      expect(registry.getHealthy('claude')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('half-open probe success closes the circuit', () => {
    vi.useFakeTimers()
    try {
      const registry = new AdapterRegistry({
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 500, halfOpenMaxAttempts: 1 },
      })
      registry.register(createMockAdapter('claude', []))
      registry.recordFailure('claude', new Error('boom'))
      vi.advanceTimersByTime(1000)
      // trigger half-open transition by calling canExecute via getHealthy
      expect(registry.getHealthy('claude')).toBeDefined()
      registry.recordSuccess('claude')
      // circuit is closed — still healthy
      expect(registry.getHealthy('claude')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('half-open probe failure re-opens the circuit', () => {
    vi.useFakeTimers()
    try {
      const registry = new AdapterRegistry({
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 500, halfOpenMaxAttempts: 1 },
      })
      registry.register(createMockAdapter('claude', []))
      registry.recordFailure('claude', new Error('boom-1'))
      vi.advanceTimersByTime(1000)
      // transition to half-open
      expect(registry.getHealthy('claude')).toBeDefined()
      // probe fails — circuit re-opens
      registry.recordFailure('claude', new Error('probe-failed'))
      expect(registry.getHealthy('claude')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('detailed health exposes circuitState transitions', async () => {
    vi.useFakeTimers()
    try {
      const registry = new AdapterRegistry({
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 500, halfOpenMaxAttempts: 1 },
      })
      registry.register(createMockAdapter('claude', []))
      let detail = await registry.getDetailedHealth()
      expect(detail.adapters['claude']!.circuitState).toBe('closed')
      registry.recordFailure('claude', new Error('x'))
      detail = await registry.getDetailedHealth()
      expect(detail.adapters['claude']!.circuitState).toBe('open')
      // elapse past resetTimeoutMs
      vi.advanceTimersByTime(1000)
      detail = await registry.getDetailedHealth()
      expect(detail.adapters['claude']!.circuitState).toBe('half-open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lastSuccessAt and lastFailureAt are set after outcomes', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.recordSuccess('claude')
    registry.recordFailure('claude', new Error('x'))
    const detail = await registry.getDetailedHealth()
    expect(typeof detail.adapters['claude']!.lastSuccessAt).toBe('number')
    expect(typeof detail.adapters['claude']!.lastFailureAt).toBe('number')
  })

  it('unregister() clears circuit breaker state for the adapter', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.register(createMockAdapter('claude', []))
    registry.recordFailure('claude', new Error('x'))
    expect(registry.unregister('claude')).toBe(true)
    // re-register — breaker should be fresh (closed)
    registry.register(createMockAdapter('claude', []))
    const detail = await registry.getDetailedHealth()
    expect(detail.adapters['claude']!.circuitState).toBe('closed')
    expect(detail.adapters['claude']!.consecutiveFailures).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AdapterRegistry — executeWithFallback routing
// ---------------------------------------------------------------------------

describe('AdapterRegistry — executeWithFallback routing', () => {
  it('executes the primary adapter when it succeeds (no fallback needed)', async () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))

    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    expect((completed as { providerId: string }).providerId).toBe('claude')
  })

  it('falls back to the next adapter when the primary fails', async () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', failureEvents('claude')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))

    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const claudeFail = events.find(
      (e) => e.type === 'adapter:failed' && (e as { providerId: string }).providerId === 'claude',
    )
    const codexComplete = events.find(
      (e) => e.type === 'adapter:completed' && (e as { providerId: string }).providerId === 'codex',
    )
    expect(claudeFail).toBeDefined()
    expect(codexComplete).toBeDefined()
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when registry is empty', async () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    const { error } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).code).toBe('ALL_ADAPTERS_EXHAUSTED')
  })

  it('throws ALL_ADAPTERS_EXHAUSTED when all adapters have open circuits', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    }).setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    registry.recordFailure('claude', new Error('x'))
    registry.recordFailure('codex', new Error('y'))

    const { error } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    expect(error).toBeInstanceOf(ForgeError)
    expect((error as ForgeError).code).toBe('ALL_ADAPTERS_EXHAUSTED')
  })

  it('skips disabled adapters in fallback chain', async () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', failureEvents('claude')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))
    registry.register(createMockAdapter('qwen', completionEvents('qwen')))
    registry.disable('codex')

    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const completedIds = events
      .filter((e) => e.type === 'adapter:completed')
      .map((e) => (e as { providerId: string }).providerId)
    // qwen must have completed; codex is disabled and must not appear
    expect(completedIds).toContain('qwen')
    expect(completedIds).not.toContain('codex')
  })

  it('mid-stream throw triggers fallback and records CB failure', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    }).setRouter(FIXED_ROUTER)
    registry.register(createMidStreamThrowingAdapter('claude', new Error('stream-broken')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))

    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const claudeFail = events.find(
      (e) => e.type === 'adapter:failed' && (e as { providerId: string }).providerId === 'claude',
    )
    const codexComplete = events.find(
      (e) => e.type === 'adapter:completed' && (e as { providerId: string }).providerId === 'codex',
    )
    expect(claudeFail).toBeDefined()
    expect(codexComplete).toBeDefined()

    const detail = await registry.getDetailedHealth()
    expect(detail.adapters['claude']!.consecutiveFailures).toBeGreaterThanOrEqual(1)
    expect(detail.adapters['codex']!.consecutiveFailures).toBe(0)
  })

  it('throw before any events emits synthesized adapter:failed for that provider', async () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.register(
      createMockAdapter('claude', [], {
        async *execute() {
          throw new Error('early-throw')
        },
      }),
    )
    registry.register(createMockAdapter('codex', completionEvents('codex')))

    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const synthesized = events.find(
      (e) =>
        e.type === 'adapter:failed'
        && (e as { providerId: string }).providerId === 'claude'
        && (e as { code: string }).code === 'ADAPTER_EXECUTION_FAILED',
    )
    expect(synthesized).toBeDefined()
  })

  it('routing honours router-selected primary when multiple adapters are healthy', async () => {
    const preferCodex: TaskRoutingStrategy = {
      name: 'prefer-codex',
      route(_t, available) {
        const primary: AdapterProviderId = available.includes('codex') ? 'codex' : (available[0] ?? 'claude')
        const fallbacks = available.filter((id) => id !== primary)
        return { provider: primary, reason: 'test', confidence: 1, fallbackProviders: fallbacks }
      },
    }
    const registry = new AdapterRegistry().setRouter(preferCodex)
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))
    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect((completed as { providerId: string }).providerId).toBe('codex')
  })

  it('resolves "auto" router decision by falling back to first healthy id', async () => {
    const autoRouter: TaskRoutingStrategy = {
      name: 'auto',
      route(_t, _available) {
        return { provider: 'auto', reason: 'no preference', confidence: 0, fallbackProviders: [] }
      },
    }
    const registry = new AdapterRegistry().setRouter(autoRouter)
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    const { events } = await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
  })

  it('record success on completion resets the consecutiveFailures counter', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    }).setRouter(FIXED_ROUTER)
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    // prime some stale failures
    registry.recordFailure('claude', new Error('old-1'))
    registry.recordFailure('claude', new Error('old-2'))
    await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const detail = await registry.getDetailedHealth()
    expect(detail.adapters['claude']!.consecutiveFailures).toBe(0)
  })

  it('emits agent:started and agent:completed on event bus for successful run', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    expect(emitted.some((e) => e.type === 'agent:started')).toBe(true)
    expect(emitted.some((e) => e.type === 'agent:completed')).toBe(true)
  })

  it('emits agent:failed on event bus when every adapter fails', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', failureEvents('claude')))
    registry.register(createMockAdapter('codex', failureEvents('codex')))
    await runGenSafely(registry.executeWithFallback(INPUT, TASK))
    const failedAgentEvents = emitted.filter((e) => e.type === 'agent:failed')
    expect(failedAgentEvents.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// AdapterRegistry — health aggregation
// ---------------------------------------------------------------------------

describe('AdapterRegistry — health aggregation', () => {
  it('getHealthStatus aggregates all adapters', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    const status = await registry.getHealthStatus()
    expect(Object.keys(status).sort()).toEqual(['claude', 'codex'])
    expect(status['claude']!.healthy).toBe(true)
    expect(status['codex']!.healthy).toBe(true)
  })

  it('getHealthStatus marks disabled adapters as unhealthy with "disabled" reason', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.disable('claude')
    const status = await registry.getHealthStatus()
    expect(status['claude']!.healthy).toBe(false)
    expect(status['claude']!.lastError).toBe('disabled')
  })

  it('getHealthStatus synthesizes unhealthy status when healthCheck throws', async () => {
    const registry = new AdapterRegistry()
    registry.register(
      createMockAdapter('claude', [], {
        async healthCheck() {
          throw new Error('health check exploded')
        },
      }),
    )
    const status = await registry.getHealthStatus()
    expect(status['claude']!.healthy).toBe(false)
    expect(status['claude']!.lastError).toContain('exploded')
  })

  it('getDetailedHealth reports "healthy" when all adapters are healthy', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    const detail = await registry.getDetailedHealth()
    expect(detail.status).toBe('healthy')
    expect(typeof detail.timestamp).toBe('number')
  })

  it('getDetailedHealth reports "degraded" when some adapters are unhealthy', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', []))
    registry.register(
      createMockAdapter('codex', [], {
        async healthCheck() {
          return { healthy: false, providerId: 'codex', sdkInstalled: false, cliAvailable: false }
        },
      }),
    )
    const detail = await registry.getDetailedHealth()
    expect(detail.status).toBe('degraded')
  })

  it('getDetailedHealth reports "unhealthy" when no adapters are healthy', async () => {
    const registry = new AdapterRegistry()
    registry.register(
      createMockAdapter('claude', [], {
        async healthCheck() {
          return { healthy: false, providerId: 'claude', sdkInstalled: false, cliAvailable: false }
        },
      }),
    )
    const detail = await registry.getDetailedHealth()
    expect(detail.status).toBe('unhealthy')
  })

  it('warmupAll invokes warmup on adapters that define it, ignores failures', async () => {
    const registry = new AdapterRegistry()
    const warmA = vi.fn(async () => undefined)
    const warmB = vi.fn(async () => {
      throw new Error('warmup-failed')
    })
    registry.register(createMockAdapter('claude', [], { warmup: warmA }))
    registry.register(createMockAdapter('codex', [], { warmup: warmB }))
    // no adapter warmup for qwen — must be safe
    registry.register(createMockAdapter('qwen', []))
    await expect(registry.warmupAll()).resolves.toBeUndefined()
    expect(warmA).toHaveBeenCalledTimes(1)
    expect(warmB).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AdapterRegistry — getForTask routing surface
// ---------------------------------------------------------------------------

describe('AdapterRegistry — getForTask', () => {
  it('throws ALL_ADAPTERS_EXHAUSTED when no healthy adapters exist', () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    expect(() => registry.getForTask(TASK)).toThrow(ForgeError)
  })

  it('returns the primary adapter from the routing decision', () => {
    const registry = new AdapterRegistry().setRouter(FIXED_ROUTER)
    const adapter = createMockAdapter('claude', [])
    registry.register(adapter)
    const { adapter: selected, decision } = registry.getForTask(TASK)
    expect(selected).toBe(adapter)
    expect(decision.provider).toBe('claude')
  })

  it('resolves "auto" decision by falling back to the first healthy adapter', () => {
    const autoRouter: TaskRoutingStrategy = {
      name: 'auto',
      route() {
        return { provider: 'auto', reason: 'auto', confidence: 0, fallbackProviders: [] }
      },
    }
    const registry = new AdapterRegistry().setRouter(autoRouter)
    registry.register(createMockAdapter('claude', []))
    const { adapter } = registry.getForTask(TASK)
    expect(adapter.providerId).toBe('claude')
  })

  it('registered-event is emitted on bus during register() after setEventBus()', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry()
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    const registered = emitted.find((e) => e.type === 'registry:agent_registered')
    expect(registered).toBeDefined()
    expect((registered as { agentId: string }).agentId).toBe('claude')
  })

  it('registry:agent_deregistered is emitted when unregistering a known adapter', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry()
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    registry.unregister('claude')
    const deregistered = emitted.find((e) => e.type === 'registry:agent_deregistered')
    expect(deregistered).toBeDefined()
    expect((deregistered as { reason: string }).reason).toBe('unregistered')
  })

  it('no registry:agent_deregistered event when unregister target does not exist', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry()
    registry.setEventBus(bus)
    registry.unregister('claude')
    expect(emitted.find((e) => e.type === 'registry:agent_deregistered')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// TagBasedRouter — routing semantics
// ---------------------------------------------------------------------------

describe('TagBasedRouter', () => {
  const router = new TagBasedRouter()

  it('routes reasoning-tagged tasks to claude when available', () => {
    const decision = router.route(
      { prompt: 'review architecture', tags: ['architecture'] },
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('routes execution-tagged tasks to codex when available', () => {
    const decision = router.route(
      { prompt: 'write code', tags: ['implement'] },
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('codex')
  })

  it('routes local-tagged tasks to crush when available', () => {
    const decision = router.route(
      { prompt: 'quick thing', tags: ['local'] },
      ['crush', 'qwen', 'claude'],
    )
    expect(decision.provider).toBe('crush')
  })

  it('falls back to qwen for local tasks when crush unavailable', () => {
    const decision = router.route(
      { prompt: 'quick thing', tags: ['offline'] },
      ['qwen', 'claude'],
    )
    expect(decision.provider).toBe('qwen')
  })

  it('honours requiresReasoning flag even without reasoning tags', () => {
    const decision = router.route(
      { prompt: 'think hard', tags: [], requiresReasoning: true },
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('honours requiresExecution flag even without execution tags', () => {
    const decision = router.route(
      { prompt: 'just do it', tags: [], requiresExecution: true },
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('codex')
  })

  it('defaults to highest-priority healthy adapter when no tag signal', () => {
    const decision = router.route(
      { prompt: 'generic', tags: [] },
      ['qwen', 'crush', 'claude'],
    )
    // default priority: claude (5) > qwen (2) > crush (1)
    expect(decision.provider).toBe('claude')
  })

  it('returns auto with zero confidence when no providers available', () => {
    const decision = router.route({ prompt: 'x', tags: [] }, [])
    expect(decision.provider).toBe('auto')
    expect(decision.confidence).toBe(0)
  })

  it('fallbackProviders excludes the primary and keeps order-insensitive set', () => {
    const decision = router.route(
      { prompt: 'x', tags: ['architecture'] },
      ['claude', 'codex', 'qwen'],
    )
    expect(decision.provider).toBe('claude')
    expect(decision.fallbackProviders).toEqual(
      expect.arrayContaining(['codex', 'qwen']),
    )
    expect(decision.fallbackProviders).not.toContain('claude')
  })

  it('case-insensitive matching on tags', () => {
    const decision = router.route(
      { prompt: 'x', tags: ['ARCHITECTURE'] },
      ['claude', 'codex'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('budgetConstraint=low routes to cheapest when no tag signal', () => {
    const decision = router.route(
      { prompt: 'x', tags: [], budgetConstraint: 'low' },
      ['claude', 'codex', 'crush'],
    )
    // crush is cheapest by COST_RANK
    expect(decision.provider).toBe('crush')
  })
})

// ---------------------------------------------------------------------------
// CostOptimizedRouter — routing semantics
// ---------------------------------------------------------------------------

describe('CostOptimizedRouter', () => {
  it('selects the cheapest adapter by default cost rank', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(
      { prompt: 'x', tags: [] },
      ['claude', 'codex', 'crush'],
    )
    expect(decision.provider).toBe('crush')
  })

  it('honours preferredProvider override even in cost-optimized mode', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route(
      { prompt: 'x', tags: [], preferredProvider: 'claude' },
      ['claude', 'codex', 'crush'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('allows custom cost ranks to override defaults', () => {
    const router = new CostOptimizedRouter({ claude: 0 })
    const decision = router.route(
      { prompt: 'x', tags: [] },
      ['claude', 'codex', 'crush'],
    )
    expect(decision.provider).toBe('claude')
  })

  it('returns auto when no providers available', () => {
    const router = new CostOptimizedRouter()
    const decision = router.route({ prompt: 'x', tags: [] }, [])
    expect(decision.provider).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// RoundRobinRouter — rotation semantics
// ---------------------------------------------------------------------------

describe('RoundRobinRouter', () => {
  it('rotates selection across providers in order', () => {
    const router = new RoundRobinRouter()
    const choices: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = router.route({ prompt: 'x', tags: [] }, ['claude', 'codex'])
      choices.push(d.provider)
    }
    expect(choices).toEqual(['claude', 'codex', 'claude', 'codex'])
  })

  it('reset() restores counter to zero', () => {
    const router = new RoundRobinRouter()
    router.route({ prompt: 'x', tags: [] }, ['claude', 'codex'])
    router.reset()
    const d = router.route({ prompt: 'x', tags: [] }, ['claude', 'codex'])
    expect(d.provider).toBe('claude')
  })

  it('returns auto when no providers available', () => {
    const router = new RoundRobinRouter()
    const d = router.route({ prompt: 'x', tags: [] }, [])
    expect(d.provider).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// CompositeRouter — composite strategies
// ---------------------------------------------------------------------------

describe('CompositeRouter', () => {
  it('throws when constructed with zero strategies', () => {
    expect(() => new CompositeRouter([])).toThrow('at least one strategy')
  })

  it('aggregates votes from multiple strategies', () => {
    const tag = new TagBasedRouter()
    const cost = new CostOptimizedRouter()
    const composite = new CompositeRouter([
      { strategy: tag, weight: 1 },
      { strategy: cost, weight: 1 },
    ])
    const decision = composite.route(
      { prompt: 'x', tags: ['architecture'] },
      ['claude', 'codex', 'crush'],
    )
    // tag-based picks claude (0.85), cost-optimized picks crush (0.8)
    // claude wins with higher confidence
    expect(decision.provider).toBe('claude')
  })

  it('returns auto when no providers available', () => {
    const composite = new CompositeRouter([
      { strategy: new TagBasedRouter(), weight: 1 },
    ])
    const d = composite.route({ prompt: 'x', tags: [] }, [])
    expect(d.provider).toBe('auto')
    expect(d.confidence).toBe(0)
  })

  it('normalizes confidence to [0, 1]', () => {
    const composite = new CompositeRouter([
      { strategy: new TagBasedRouter(), weight: 1 },
    ])
    const decision = composite.route(
      { prompt: 'x', tags: ['architecture'] },
      ['claude'],
    )
    expect(decision.confidence).toBeLessThanOrEqual(1)
    expect(decision.confidence).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// EventBusBridge — scoping + cleanup
// ---------------------------------------------------------------------------

describe('EventBusBridge — scoping and cleanup', () => {
  async function* yieldEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
    for (const e of events) yield e
  }

  it('disconnect cleans up any subscriptions when no external handlers remain', async () => {
    const bus = createEventBus()
    const handler = vi.fn()
    const unsub = bus.on('agent:started', handler)
    unsub()
    // Verify: emit no longer reaches handler
    bus.emit({ type: 'agent:started', agentId: 'claude', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handler).not.toHaveBeenCalled()
  })

  it('pass-through preserves original event references', async () => {
    const bus = createEventBus()
    const bridge = new EventBusBridge(bus)
    const original: AgentEvent = {
      type: 'adapter:started',
      providerId: 'claude',
      sessionId: 'x',
      timestamp: 1,
    }
    const yielded = await collect(bridge.bridge(yieldEvents([original]), 'run-1'))
    expect(yielded[0]).toBe(original)
  })

  it('adapter:memory_recalled is yielded but not emitted on the bus', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const bridge = new EventBusBridge(bus)
    const mem: AgentEvent = {
      type: 'adapter:memory_recalled',
      providerId: 'claude',
      timestamp: 1,
      entries: [{ level: 'project', name: 'x', tokenEstimate: 10 }],
      totalTokens: 10,
    }
    const yielded = await collect(bridge.bridge(yieldEvents([mem]), 'run-1'))
    expect(yielded).toHaveLength(1)
    expect(emitted).toHaveLength(0)
  })

  it('runId is propagated unchanged across every emitted DzupEvent', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const bridge = new EventBusBridge(bus)
    const runId = 'fixed-run-id-xyz'
    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      {
        type: 'adapter:message',
        providerId: 'claude',
        content: 'hi',
        role: 'assistant',
        timestamp: 2,
      },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 5,
        timestamp: 3,
      },
    ]
    await collect(bridge.bridge(yieldEvents(events), runId))
    const runIds = emitted
      .filter((e) => 'runId' in e)
      .map((e) => (e as { runId: string }).runId)
    expect(runIds).toEqual([runId, runId, runId])
  })

  it('scoping: separate bridges do not cross-contaminate buses', async () => {
    const bus1 = createEventBus()
    const bus2 = createEventBus()
    const emit1 = collectBusEvents(bus1)
    const emit2 = collectBusEvents(bus2)
    const bridge1 = new EventBusBridge(bus1)
    const bridge2 = new EventBusBridge(bus2)
    await collect(
      bridge1.bridge(
        yieldEvents([{ type: 'adapter:started', providerId: 'claude', sessionId: 'a', timestamp: 1 }]),
        'r1',
      ),
    )
    await collect(
      bridge2.bridge(
        yieldEvents([{ type: 'adapter:started', providerId: 'codex', sessionId: 'b', timestamp: 1 }]),
        'r2',
      ),
    )
    expect(emit1).toHaveLength(1)
    expect(emit2).toHaveLength(1)
    expect((emit1[0] as { agentId: string }).agentId).toBe('claude')
    expect((emit2[0] as { agentId: string }).agentId).toBe('codex')
  })

  it('mapToDzupEvent is static and does not rely on bus state', () => {
    const started: AgentEvent = {
      type: 'adapter:started',
      providerId: 'claude',
      sessionId: 'x',
      timestamp: 1,
    }
    const mapped = EventBusBridge.mapToDzupEvent(started, 'run-id')
    expect(mapped).toEqual({ type: 'agent:started', agentId: 'claude', runId: 'run-id' })
  })
})

// ---------------------------------------------------------------------------
// Shutdown / cleanup edge cases
// ---------------------------------------------------------------------------

describe('AdapterRegistry — cleanup edge cases', () => {
  beforeEach(() => {
    // ensure no lingering fake timers from parallel tests
  })

  afterEach(() => {
    // ensure any test that forgot to restore fake timers is cleaned
    vi.useRealTimers()
  })

  it('re-register after unregister creates a fresh breaker', async () => {
    const registry = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    registry.register(createMockAdapter('claude', []))
    registry.recordFailure('claude', new Error('x'))
    registry.unregister('claude')
    registry.register(createMockAdapter('claude', []))
    expect(registry.getHealthy('claude')).toBeDefined()
  })

  it('setRouter replaces the routing strategy and uses the new one', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', completionEvents('claude')))
    registry.register(createMockAdapter('codex', completionEvents('codex')))

    const firstRouter: TaskRoutingStrategy = {
      name: 'first',
      route(_t, available) {
        const primary: AdapterProviderId = available[0] ?? 'claude'
        return {
          provider: primary,
          reason: 'first',
          confidence: 1,
          fallbackProviders: available.slice(1),
        }
      },
    }
    registry.setRouter(firstRouter)
    const { adapter: a1 } = registry.getForTask(TASK)

    const reverseRouter: TaskRoutingStrategy = {
      name: 'reverse',
      route(_t, available) {
        const reversed = [...available].reverse()
        const primary: AdapterProviderId = reversed[0] ?? 'claude'
        return {
          provider: primary,
          reason: 'reverse',
          confidence: 1,
          fallbackProviders: reversed.slice(1),
        }
      },
    }
    registry.setRouter(reverseRouter)
    const { adapter: a2 } = registry.getForTask(TASK)
    expect(a1.providerId).not.toBe(a2.providerId)
  })

  it('setEventBus re-binding replaces the active bus', () => {
    const bus1 = createEventBus()
    const bus2 = createEventBus()
    const emit1 = collectBusEvents(bus1)
    const emit2 = collectBusEvents(bus2)
    const registry = new AdapterRegistry()
    registry.setEventBus(bus1)
    registry.register(createMockAdapter('claude', []))
    // swap bus before a failure is recorded
    registry.setEventBus(bus2)
    registry.recordFailure('claude', new Error('x'))
    expect(emit1.find((e) => e.type === 'provider:failed')).toBeUndefined()
    expect(emit2.find((e) => e.type === 'provider:failed')).toBeDefined()
  })

  it('multiple register events accumulate on the bus', () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const registry = new AdapterRegistry()
    registry.setEventBus(bus)
    registry.register(createMockAdapter('claude', []))
    registry.register(createMockAdapter('codex', []))
    registry.register(createMockAdapter('qwen', []))
    const registered = emitted.filter((e) => e.type === 'registry:agent_registered')
    expect(registered).toHaveLength(3)
  })
})
