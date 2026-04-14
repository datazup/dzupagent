import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentInput,
} from '../types.js'

function createMockRegistry(adapters: Map<AdapterProviderId, AgentCLIAdapter>): AdapterRegistry {
  return {
    getHealthy(providerId: AdapterProviderId) {
      return adapters.get(providerId)
    },
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((event) => events.push(event))
  return events
}

function createDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })

  return { promise, resolve }
}

function createWinningAdapter(providerId: AdapterProviderId, result: string): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      yield {
        type: 'adapter:started' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }

      yield {
        type: 'adapter:completed' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        result,
        durationMs: 0,
        timestamp: Date.now(),
      }
    },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createGatedAdapter(
  providerId: AdapterProviderId,
  gate: { promise: Promise<void> },
  state: { started: number; completed: number },
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      state.started += 1

      yield {
        type: 'adapter:started' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }

      await gate.promise

      state.completed += 1

      yield {
        type: 'adapter:completed' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        result: `${providerId}-result`,
        durationMs: 0,
        timestamp: Date.now(),
      }
    },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

describe('ParallelExecutor first-wins contract', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a settled allResults snapshot at the return boundary', async () => {
    const bus = createEventBus()
    const emitted = collectBusEvents(bus)
    const slowGate = createDeferred<void>()
    const slowState = { started: 0, completed: 0 }

    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      ['gemini', createWinningAdapter('gemini', 'gemini-result')],
      ['claude', createGatedAdapter('claude', slowGate, slowState)],
    ])

    const executor = new ParallelExecutor({
      registry: createMockRegistry(adapters),
      eventBus: bus,
    })

    const execution = executor.execute(
      { prompt: 'test' },
      {
        providers: ['gemini', 'claude'],
        mergeStrategy: 'first-wins',
      },
    )

    let settled = false
    void execution.then(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(settled).toBe(true)
    })

    expect(slowState.started).toBe(1)
    expect(slowState.completed).toBe(0)

    const result = await execution
    const snapshot = result.allResults.map((provider) => ({
      providerId: provider.providerId,
      success: provider.success,
      cancelled: provider.cancelled ?? false,
      result: provider.result,
    }))

    expect(result.strategy).toBe('first-wins')
    expect(result.cancelled).toBeUndefined()
    expect(result.selectedResult.providerId).toBe('gemini')
    expect(result.allResults).toHaveLength(1)
    expect(result.allResults.map((provider) => provider.providerId)).toEqual(['gemini'])
    expect(emitted.some((event) => event.type === 'pipeline:run_cancelled')).toBe(false)
    expect(emitted.some((event) => event.type === 'pipeline:run_completed')).toBe(true)

    slowGate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(result.allResults).toHaveLength(1)
    expect(result.allResults.map((provider) => ({
      providerId: provider.providerId,
      success: provider.success,
      cancelled: provider.cancelled ?? false,
      result: provider.result,
    }))).toEqual(snapshot)
    expect(slowState.completed).toBe(1)
  })
})
