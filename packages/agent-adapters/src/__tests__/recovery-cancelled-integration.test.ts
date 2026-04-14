import { describe, it, expect } from 'vitest'
import { createEventBus, ForgeError } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { AdapterRecoveryCopilot } from '../recovery/adapter-recovery.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import { collectEvents } from './test-helpers.js'

function createAbortingAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      yield {
        type: 'adapter:started',
        providerId,
        sessionId: 'sess-abort',
        timestamp: Date.now(),
      }
      yield {
        type: 'adapter:failed',
        providerId,
        error: 'cancelled',
        code: 'AGENT_ABORTED',
        timestamp: Date.now(),
      }
      throw new ForgeError({
        code: 'AGENT_ABORTED',
        message: 'cancelled',
        recoverable: true,
      })
    },
    async *resumeSession(_id: string, _input: AgentInput) {
      /* noop */
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createAbortRegistry(providerId: AdapterProviderId): AdapterRegistry {
  const adapter = createAbortingAdapter(providerId)
  return {
    getForTask() {
      return {
        adapter,
        decision: {
          provider: providerId,
          reason: 'abort integration test',
          confidence: 1,
        },
      }
    },
    listAdapters() {
      return [providerId]
    },
    recordSuccess() {},
    recordFailure() {},
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

describe('recovery cancellation integration', () => {
  it('surfaces recovery:cancelled through executeWithRecoveryStream and the event bus', async () => {
    const recoveryBus = createEventBus()
    const bridgedBus = createEventBus()
    const recoveryBusEvents = collectBusEvents(recoveryBus)
    const bridgedBusEvents = collectBusEvents(bridgedBus)

    const registry = createAbortRegistry('claude')
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      eventBus: recoveryBus,
    })
    const bridge = new EventBusBridge(bridgedBus)

    const yielded = await collectEvents(
      bridge.bridge(copilot.executeWithRecoveryStream({ prompt: 'do it' })),
    )

    expect(yielded.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:failed',
      'recovery:cancelled',
    ])

    const recoveryCancelledFromRecoveryBus = recoveryBusEvents.find(
      (event) => event.type === 'recovery:cancelled',
    )
    expect(recoveryCancelledFromRecoveryBus).toMatchObject({
      type: 'recovery:cancelled',
      agentId: 'claude',
      attempts: 1,
      reason: 'cancelled',
    })

    const recoveryCancelledFromBridgeBus = bridgedBusEvents.find(
      (event) => event.type === 'recovery:cancelled',
    )
    expect(recoveryCancelledFromBridgeBus).toMatchObject({
      type: 'recovery:cancelled',
      agentId: 'claude',
      attempts: 1,
      reason: 'cancelled',
    })
  })

  it('returns a cancelled result and emits recovery:cancelled for executeWithRecovery', async () => {
    const bus = createEventBus()
    const events = collectBusEvents(bus)

    const registry = createAbortRegistry('claude')
    const copilot = new AdapterRecoveryCopilot(registry, {
      maxAttempts: 3,
      eventBus: bus,
    })

    const result = await copilot.executeWithRecovery({ prompt: 'do it' })

    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      strategy: 'abort',
      error: 'cancelled',
    })

    const recoveryCancelled = events.find((event) => event.type === 'recovery:cancelled')
    expect(recoveryCancelled).toMatchObject({
      type: 'recovery:cancelled',
      agentId: 'claude',
      attempts: 1,
      reason: 'cancelled',
    })
  })
})
