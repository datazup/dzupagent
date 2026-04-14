import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentInput,
} from '../types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAdapter(
  providerId: AdapterProviderId,
  result: string,
  delayMs = 0,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
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
        durationMs: delayMs,
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

function createFailingAdapter(
  providerId: AdapterProviderId,
  errorMessage: string,
  delayMs = 0,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      throw new Error(errorMessage)
    },
    async *resumeSession() { /* noop */ },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

function createAbortAwareAdapter(
  providerId: AdapterProviderId,
  result: string,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput) {
      yield {
        type: 'adapter:started' as const,
        providerId,
        sessionId: `sess-${providerId}`,
        timestamp: Date.now(),
      }

      await new Promise<void>((resolve) => {
        if (!input.signal || input.signal.aborted) {
          resolve()
          return
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })

      if (input.signal?.aborted) return

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

function createMockRegistry(adapters: Map<AdapterProviderId, AgentCLIAdapter>): AdapterRegistry {
  return {
    getHealthy(providerId: AdapterProviderId) {
      return adapters.get(providerId)
    },
    listAdapters() {
      return [...adapters.keys()]
    },
  } as unknown as AdapterRegistry
}

// We reuse the same two provider IDs from the union type for all stress tests.
const PROVIDER_A: AdapterProviderId = 'claude'
const PROVIDER_B: AdapterProviderId = 'gemini'

// ---------------------------------------------------------------------------
// Stress Tests
// ---------------------------------------------------------------------------

describe('ParallelExecutor stress tests', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  it('handles 20 concurrent first-wins executions without hanging promises', async () => {
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createMockAdapter(PROVIDER_A, 'a-result', 5)],
      [PROVIDER_B, createMockAdapter(PROVIDER_B, 'b-result', 10)],
    ])
    const registry = createMockRegistry(adapters)
    const executor = new ParallelExecutor({ registry, eventBus: bus })

    const executions = Array.from({ length: 20 }, (_, i) =>
      executor.execute(
        { prompt: `stress-test-${String(i)}` },
        {
          providers: [PROVIDER_A, PROVIDER_B],
          mergeStrategy: 'first-wins',
        },
      ),
    )

    const results = await Promise.all(executions)

    expect(results).toHaveLength(20)
    for (const result of results) {
      expect(result.strategy).toBe('first-wins')
      expect(result.selectedResult.success).toBe(true)
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('handles rapid abort/cancel cycles without unhandled rejections', async () => {
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createAbortAwareAdapter(PROVIDER_A, 'a-result')],
      [PROVIDER_B, createAbortAwareAdapter(PROVIDER_B, 'b-result')],
    ])
    const registry = createMockRegistry(adapters)
    const executor = new ParallelExecutor({ registry, eventBus: bus })

    const iterations = 10
    const results = []

    for (let i = 0; i < iterations; i++) {
      const controller = new AbortController()

      const execution = executor.execute(
        { prompt: `abort-cycle-${String(i)}` },
        {
          providers: [PROVIDER_A, PROVIDER_B],
          mergeStrategy: 'first-wins',
          signal: controller.signal,
        },
      )

      // Abort immediately
      controller.abort()

      const result = await execution
      results.push(result)
    }

    expect(results).toHaveLength(iterations)
    for (const result of results) {
      expect(result.cancelled).toBe(true)
      // Every result should have both providers in allResults
      expect(result.allResults).toHaveLength(2)
    }
  })

  it('handles mixed success/failure under load', async () => {
    // Run 10 concurrent executions: 5 with succeeding adapters, 5 with one failing
    const succeedingAdapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createMockAdapter(PROVIDER_A, 'a-ok', 5)],
      [PROVIDER_B, createMockAdapter(PROVIDER_B, 'b-ok', 5)],
    ])
    const mixedAdapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createMockAdapter(PROVIDER_A, 'a-ok', 5)],
      [PROVIDER_B, createFailingAdapter(PROVIDER_B, 'b-error', 5)],
    ])

    const succeedingRegistry = createMockRegistry(succeedingAdapters)
    const mixedRegistry = createMockRegistry(mixedAdapters)

    const succeedingExecutor = new ParallelExecutor({ registry: succeedingRegistry, eventBus: bus })
    const mixedExecutor = new ParallelExecutor({ registry: mixedRegistry, eventBus: bus })

    const allExecutions: Array<Promise<{ idx: number; hasFailing: boolean; result: Awaited<ReturnType<typeof succeedingExecutor.execute>> }>> = []

    for (let i = 0; i < 5; i++) {
      allExecutions.push(
        succeedingExecutor.execute(
          { prompt: `success-${String(i)}` },
          { providers: [PROVIDER_A, PROVIDER_B], mergeStrategy: 'all' },
        ).then((result) => ({ idx: i, hasFailing: false, result })),
      )
    }

    for (let i = 0; i < 5; i++) {
      allExecutions.push(
        mixedExecutor.execute(
          { prompt: `mixed-${String(i)}` },
          { providers: [PROVIDER_A, PROVIDER_B], mergeStrategy: 'all' },
        ).then((result) => ({ idx: i + 5, hasFailing: true, result })),
      )
    }

    const outcomes = await Promise.all(allExecutions)

    expect(outcomes).toHaveLength(10)

    for (const outcome of outcomes) {
      expect(outcome.result.allResults).toHaveLength(2)

      if (!outcome.hasFailing) {
        // All-success: both providers should succeed
        expect(outcome.result.allResults.every((r) => r.success)).toBe(true)
        expect(outcome.result.selectedResult.success).toBe(true)
      } else {
        // Mixed: one should succeed, one should fail
        const providerA = outcome.result.allResults.find((r) => r.providerId === PROVIDER_A)
        const providerB = outcome.result.allResults.find((r) => r.providerId === PROVIDER_B)
        expect(providerA?.success).toBe(true)
        expect(providerB?.success).toBe(false)
        expect(providerB?.error).toBe('b-error')
        // selectedResult should be the successful one
        expect(outcome.result.selectedResult.success).toBe(true)
        expect(outcome.result.selectedResult.providerId).toBe(PROVIDER_A)
      }
    }
  })

  it('respects concurrency bounds under concurrent load', async () => {
    // Track concurrency using enter/exit counters that do not rely on
    // generator cleanup (since the executor may break out of the for-await
    // after seeing adapter:completed, which defers .return() to GC).
    let peakConcurrency = 0
    let currentConcurrency = 0
    let totalEnterCount = 0

    function createTrackedAdapter(
      providerId: AdapterProviderId,
      delayMs: number,
    ): AgentCLIAdapter {
      return {
        providerId,
        async *execute(_input: AgentInput) {
          currentConcurrency += 1
          totalEnterCount += 1
          if (currentConcurrency > peakConcurrency) {
            peakConcurrency = currentConcurrency
          }

          yield {
            type: 'adapter:started' as const,
            providerId,
            sessionId: `sess-${providerId}`,
            timestamp: Date.now(),
          }

          await new Promise((r) => setTimeout(r, delayMs))

          currentConcurrency -= 1

          yield {
            type: 'adapter:completed' as const,
            providerId,
            sessionId: `sess-${providerId}`,
            result: `result-${providerId}`,
            durationMs: delayMs,
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

    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createTrackedAdapter(PROVIDER_A, 20)],
      [PROVIDER_B, createTrackedAdapter(PROVIDER_B, 20)],
    ])
    const registry = createMockRegistry(adapters)
    const executor = new ParallelExecutor({ registry, eventBus: bus })

    const concurrentCount = 5
    const executions = Array.from({ length: concurrentCount }, (_, i) =>
      executor.execute(
        { prompt: `concurrent-${String(i)}` },
        { providers: [PROVIDER_A, PROVIDER_B], mergeStrategy: 'all' },
      ),
    )

    const results = await Promise.all(executions)

    expect(results).toHaveLength(concurrentCount)
    for (const result of results) {
      expect(result.allResults).toHaveLength(2)
      expect(result.allResults.every((r) => r.success)).toBe(true)
    }

    // Each execution spawns 2 providers, so total enter count = concurrentCount * 2
    expect(totalEnterCount).toBe(concurrentCount * 2)

    // Peak concurrency should be bounded — at most concurrentCount * 2
    // (each execution runs 2 providers in parallel)
    expect(peakConcurrency).toBeLessThanOrEqual(concurrentCount * 2)
    expect(peakConcurrency).toBeGreaterThan(0)
  })

  it('handles timeout under concurrent first-wins load', async () => {
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createAbortAwareAdapter(PROVIDER_A, 'a-result')],
      [PROVIDER_B, createAbortAwareAdapter(PROVIDER_B, 'b-result')],
    ])
    const registry = createMockRegistry(adapters)
    const executor = new ParallelExecutor({ registry, eventBus: bus })

    const executions = Array.from({ length: 10 }, (_, i) =>
      executor.execute(
        { prompt: `timeout-${String(i)}` },
        {
          providers: [PROVIDER_A, PROVIDER_B],
          mergeStrategy: 'first-wins',
          timeoutMs: 50,
        },
      ),
    )

    const results = await Promise.all(executions)

    expect(results).toHaveLength(10)
    for (const result of results) {
      expect(result.cancelled).toBe(true)
      expect(result.totalDurationMs).toBeLessThan(5000)
    }
  })

  it('handles alternating success and pre-aborted executions', async () => {
    const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
      [PROVIDER_A, createMockAdapter(PROVIDER_A, 'a-result', 5)],
      [PROVIDER_B, createMockAdapter(PROVIDER_B, 'b-result', 5)],
    ])
    const registry = createMockRegistry(adapters)
    const executor = new ParallelExecutor({ registry, eventBus: bus })

    const executions: Array<Promise<Awaited<ReturnType<typeof executor.execute>>>> = []

    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        // Normal execution
        executions.push(
          executor.execute(
            { prompt: `normal-${String(i)}` },
            { providers: [PROVIDER_A, PROVIDER_B], mergeStrategy: 'first-wins' },
          ),
        )
      } else {
        // Pre-aborted execution
        const controller = new AbortController()
        controller.abort()
        executions.push(
          executor.execute(
            { prompt: `aborted-${String(i)}` },
            {
              providers: [PROVIDER_A, PROVIDER_B],
              mergeStrategy: 'first-wins',
              signal: controller.signal,
            },
          ),
        )
      }
    }

    const results = await Promise.all(executions)

    expect(results).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      const result = results[i]!
      if (i % 2 === 0) {
        expect(result.selectedResult.success).toBe(true)
      } else {
        expect(result.cancelled).toBe(true)
      }
    }
  })
})
