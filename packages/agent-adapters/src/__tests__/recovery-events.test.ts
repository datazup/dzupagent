import { describe, it, expect, vi } from 'vitest'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import {
  AdapterRecoveryCopilot,
} from '../recovery/adapter-recovery.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  RoutingDecision,
  TaskDescriptor,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  results: AgentEvent[],
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      for (const e of results) yield e
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  } as unknown as AgentCLIAdapter
}

function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMsg: string,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      throw new Error(errorMsg)
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  } as unknown as AgentCLIAdapter
}

function createRetryRegistry(
  failCount: number,
  successProviderId: AdapterProviderId = 'claude',
): ProviderAdapterRegistry {
  let callCount = 0

  const successAdapter = createMockAdapter(successProviderId, [
    {
      type: 'adapter:completed',
      providerId: successProviderId,
      sessionId: 'sess-1',
      result: 'recovered',
      durationMs: 50,
      timestamp: Date.now(),
    } as AgentEvent,
  ])

  const failAdapter = createFailingAdapter(successProviderId, 'transient failure')

  return {
    getForTask(_task: TaskDescriptor) {
      callCount++
      const adapter = callCount <= failCount ? failAdapter : successAdapter
      return {
        adapter,
        decision: {
          provider: successProviderId,
          reason: 'mock',
          confidence: 1,
        },
      }
    },
    listAdapters() {
      return [successProviderId]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as ProviderAdapterRegistry
}

function createAlwaysFailRegistry(
  providerId: AdapterProviderId = 'claude',
): ProviderAdapterRegistry {
  const failAdapter = createFailingAdapter(providerId, 'permanent failure')
  return {
    getForTask(_task: TaskDescriptor) {
      return {
        adapter: failAdapter,
        decision: {
          provider: providerId,
          reason: 'mock',
          confidence: 1,
        } satisfies RoutingDecision,
      }
    },
    listAdapters() {
      return [providerId]
    },
    recordSuccess(_id: AdapterProviderId) {},
    recordFailure(_id: AdapterProviderId, _err: Error) {},
  } as unknown as ProviderAdapterRegistry
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Recovery Event Semantics', () => {
  it('emits recovery:attempt_started for each recovery attempt', async () => {
    const events: DzupEvent[] = []
    const eventBus: DzupEventBus = {
      emit: (event: DzupEvent) => { events.push(event) },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as DzupEventBus

    const registry = createRetryRegistry(1)
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      eventBus,
      backoffMs: 0,
      maxBackoffMs: 0,
    })

    await copilot.executeWithRecovery({ prompt: 'test' })

    const startEvents = events.filter(e => e.type === 'recovery:attempt_started')
    expect(startEvents.length).toBeGreaterThan(0)
    // Verify shape
    const first = startEvents[0] as Extract<DzupEvent, { type: 'recovery:attempt_started' }>
    expect(first.attempt).toBeGreaterThanOrEqual(1)
    expect(first.maxAttempts).toBe(3)
    expect(typeof first.strategy).toBe('string')
    expect(typeof first.timestamp).toBe('number')
  })

  it('emits recovery:succeeded when recovery succeeds', async () => {
    const events: DzupEvent[] = []
    const eventBus: DzupEventBus = {
      emit: (event: DzupEvent) => { events.push(event) },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as DzupEventBus

    const registry = createRetryRegistry(1)
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      eventBus,
      backoffMs: 0,
      maxBackoffMs: 0,
    })

    await copilot.executeWithRecovery({ prompt: 'test' })

    const successEvents = events.filter(e => e.type === 'recovery:succeeded')
    expect(successEvents.length).toBeGreaterThan(0)
    const first = successEvents[0] as Extract<DzupEvent, { type: 'recovery:succeeded' }>
    expect(first.attempt).toBeGreaterThanOrEqual(1)
    expect(typeof first.strategy).toBe('string')
    expect(typeof first.durationMs).toBe('number')
  })

  it('emits recovery:exhausted when all attempts fail', async () => {
    const events: DzupEvent[] = []
    const eventBus: DzupEventBus = {
      emit: (event: DzupEvent) => { events.push(event) },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as DzupEventBus

    const registry = createAlwaysFailRegistry()
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 2,
      eventBus,
      backoffMs: 0,
      maxBackoffMs: 0,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'test' })
    expect(result.success).toBe(false)

    const exhaustedEvents = events.filter(e => e.type === 'recovery:exhausted')
    expect(exhaustedEvents.length).toBe(1)
    const first = exhaustedEvents[0] as Extract<DzupEvent, { type: 'recovery:exhausted' }>
    expect(first.attempts).toBe(2)
    expect(Array.isArray(first.strategies)).toBe(true)
    expect(typeof first.durationMs).toBe('number')
    expect(typeof first.lastError).toBe('string')
  })

  it('does not emit agent:stuck_detected for recovery events', async () => {
    const events: DzupEvent[] = []
    const eventBus: DzupEventBus = {
      emit: (event: DzupEvent) => { events.push(event) },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as DzupEventBus

    const registry = createRetryRegistry(1)
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      eventBus,
      backoffMs: 0,
      maxBackoffMs: 0,
    })

    await copilot.executeWithRecovery({ prompt: 'test' })

    // Recovery events should NOT be shoehorned into agent:stuck_detected
    const stuckEvents = events.filter(e => e.type === 'agent:stuck_detected')
    expect(stuckEvents.length).toBe(0)
  })
})
