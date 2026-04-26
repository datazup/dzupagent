import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'

import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentInput,
} from '../types.js'

function createDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function createMockRegistry(adapters: Map<AdapterProviderId, AgentCLIAdapter>): ProviderAdapterRegistry {
  return {
    getHealthy(providerId: AdapterProviderId) {
      return adapters.get(providerId)
    },
  } as unknown as ProviderAdapterRegistry
}

function createFastWinnerAdapter(
  providerId: AdapterProviderId,
  beforeCompletion?: Promise<void>,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      yield {
        type: 'adapter:started' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }

      if (beforeCompletion) {
        await beforeCompletion
      }

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

function createLateRejectingAdapter(
  providerId: AdapterProviderId,
  gate: { promise: Promise<void> },
  started: { resolve: () => void },
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      started.resolve()
      yield {
        type: 'adapter:started' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }

      await gate.promise

      throw new Error(`${providerId}-late-failure`)
    },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

async function flushMicrotasks(iterations = 3): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve()
  }
}

describe('ParallelExecutor unhandled rejection stress', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not leak unhandled rejections when first-wins returns before a slower provider rejects', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }

    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const slowGate = createDeferred<void>()
      const slowStarted = createDeferred<void>()
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createFastWinnerAdapter('claude', slowStarted.promise)],
        ['gemini', createLateRejectingAdapter('gemini', slowGate, slowStarted)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({
        registry,
        eventBus: createEventBus(),
      })

      const execution = executor.execute(
        { prompt: 'stress test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'first-wins',
        },
      )

      await slowStarted.promise

      const result = await execution

      expect(result.strategy).toBe('first-wins')
      expect(result.cancelled).toBeUndefined()
      expect(result.selectedResult.providerId).toBe('claude')
      expect(result.selectedResult.success).toBe(true)
      expect(result.allResults.some((entry) => entry.providerId === 'claude')).toBe(true)

      slowGate.resolve()
      await flushMicrotasks()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await flushMicrotasks()

      expect(unhandledRejections).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})
