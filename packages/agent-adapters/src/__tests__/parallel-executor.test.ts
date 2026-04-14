import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'

import { ParallelExecutor } from '../orchestration/parallel-executor.js'
import type { ProviderResult } from '../orchestration/parallel-executor.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
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
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput) {
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
  state: {
    executeCalls: number
    abortListenerCalls: number
    signals: AbortSignal[]
  },
  onReady?: () => void,
): AgentCLIAdapter {
  return {
    providerId,
    async *execute(input: AgentInput) {
      state.executeCalls += 1

      if (input.signal) {
        state.signals.push(input.signal)
        input.signal.addEventListener(
          'abort',
          () => {
            state.abortListenerCalls += 1
          },
          { once: true },
        )
      }

      onReady?.()

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

function collectBusEvents(bus: DzupEventBus): DzupEvent[] {
  const events: DzupEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ParallelExecutor', () => {
  let bus: DzupEventBus
  let emitted: DzupEvent[]

  beforeEach(() => {
    bus = createEventBus()
    emitted = collectBusEvents(bus)
  })

  describe('first-wins strategy', () => {
    it('returns the first successful completion', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 50)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 10)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'first-wins',
        },
      )

      expect(result.strategy).toBe('first-wins')
      expect(result.selectedResult.success).toBe(true)
      // Gemini should win since it has shorter delay
      expect(result.selectedResult.providerId).toBe('gemini')
      expect(result.selectedResult.result).toBe('gemini-result')
    })

    it('returns promptly without waiting for slower providers to complete', async () => {
      const slowGate = createDeferred<void>()
      const fastCompleted = createDeferred<void>()
      const slowState = {
        executeCalls: 0,
        startedCalls: 0,
        completedCalls: 0,
      }
      const fastState = {
        executeCalls: 0,
        startedCalls: 0,
        completedCalls: 0,
      }
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        [
          'claude',
          {
            providerId: 'claude',
            async *execute() {
              slowState.executeCalls += 1
              slowState.startedCalls += 1
              yield {
                type: 'adapter:started' as const,
                providerId: 'claude',
                sessionId: 'sess-claude',
                timestamp: Date.now(),
              }

              await slowGate.promise

              slowState.completedCalls += 1
              yield {
                type: 'adapter:completed' as const,
                providerId: 'claude',
                sessionId: 'sess-claude',
                result: 'claude-result',
                durationMs: 0,
                timestamp: Date.now(),
              }
            },
            async *resumeSession() { /* noop */ },
            interrupt() {},
            async healthCheck() {
              return { healthy: true, providerId: 'claude', sdkInstalled: true, cliAvailable: true }
            },
            configure() {},
          },
        ],
        [
          'gemini',
          {
            providerId: 'gemini',
            async *execute() {
              fastState.executeCalls += 1
              fastState.startedCalls += 1
              yield {
                type: 'adapter:started' as const,
                providerId: 'gemini',
                sessionId: 'sess-gemini',
                timestamp: Date.now(),
              }

              fastState.completedCalls += 1
              fastCompleted.resolve()
              yield {
                type: 'adapter:completed' as const,
                providerId: 'gemini',
                sessionId: 'sess-gemini',
                result: 'gemini-result',
                durationMs: 0,
                timestamp: Date.now(),
              }
            },
            async *resumeSession() { /* noop */ },
            interrupt() {},
            async healthCheck() {
              return { healthy: true, providerId: 'gemini', sdkInstalled: true, cliAvailable: true }
            },
            configure() {},
          },
        ],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const execution = executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'first-wins',
        },
      )

      let settled = false
      void execution.then(() => {
        settled = true
      })

      await fastCompleted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(settled).toBe(true)
      expect(slowState.startedCalls).toBe(1)
      expect(slowState.completedCalls).toBe(0)

      const result = await execution
      expect(result.strategy).toBe('first-wins')
      expect(result.selectedResult.success).toBe(true)
      expect(result.selectedResult.providerId).toBe('gemini')

      slowGate.resolve()
      await Promise.resolve()
    })

    it('handles all providers failing', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createFailingAdapter('claude', 'claude-error')],
        ['gemini', createFailingAdapter('gemini', 'gemini-error')],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'first-wins',
        },
      )

      expect(result.selectedResult.success).toBe(false)
    })
  })

  describe('all strategy', () => {
    it('waits for all providers and returns combined results', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 20)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 10)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
        },
      )

      expect(result.strategy).toBe('all')
      expect(result.allResults).toHaveLength(2)
      expect(result.allResults.every((r) => r.success)).toBe(true)
      // selectedResult should be the first successful one
      expect(result.selectedResult.success).toBe(true)
    })

    it('includes failed providers in allResults', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result')],
        ['gemini', createFailingAdapter('gemini', 'gemini-error')],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
        },
      )

      expect(result.allResults).toHaveLength(2)
      const claude = result.allResults.find((r) => r.providerId === 'claude')
      const gemini = result.allResults.find((r) => r.providerId === 'gemini')
      expect(claude?.success).toBe(true)
      expect(gemini?.success).toBe(false)
      expect(gemini?.error).toBe('gemini-error')
    })
  })

  describe('best-of-n strategy', () => {
    it('uses scorer to select best result', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'short')],
        ['gemini', createMockAdapter('gemini', 'this is a longer and better result')],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      // Scorer that prefers longer results
      const scorer = (r: ProviderResult): number => {
        if (!r.success) return -1
        return r.result.length
      }

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'best-of-n',
          scorer,
        },
      )

      expect(result.strategy).toBe('best-of-n')
      expect(result.selectedResult.providerId).toBe('gemini')
      expect(result.selectedResult.result).toBe('this is a longer and better result')
    })

    it('uses default scorer when none provided (prefers faster)', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 50)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 5)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'best-of-n',
        },
      )

      // Default scorer prefers shorter duration
      expect(result.selectedResult.success).toBe(true)
    })
  })

  describe('provider failures', () => {
    it('handles unhealthy/missing provider gracefully', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result')],
        // gemini not registered
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
        },
      )

      expect(result.allResults).toHaveLength(2)
      const gemini = result.allResults.find((r) => r.providerId === 'gemini')
      expect(gemini?.success).toBe(false)
      expect(gemini?.error).toContain('not healthy or not registered')
    })
  })

  describe('race() convenience method', () => {
    it('returns first successful result', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 50)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 5)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.race(
        { prompt: 'test' },
        ['claude', 'gemini'],
      )

      expect(result.success).toBe(true)
      expect(result.providerId).toBe('gemini')
    })

    it('surfaces cancellation as run_cancelled and not run_completed', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 50)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 5)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })
      const controller = new AbortController()
      controller.abort()

      const result = await executor.race(
        { prompt: 'test' },
        ['claude', 'gemini'],
        controller.signal,
      )

      expect(result.cancelled).toBe(true)
      expect(result.success).toBe(false)
      expect(result.error).toContain('cancel')

      const types = emitted.map((event) => event.type)
      expect(types).toContain('pipeline:run_started')
      expect(types).toContain('pipeline:run_cancelled')
      expect(types).not.toContain('pipeline:run_completed')

      const cancelledEvent = emitted.find((event) => event.type === 'pipeline:run_cancelled')
      expect(cancelledEvent).toMatchObject({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        reason: expect.stringContaining('cancel'),
      })
    })
  })

  describe('timeout', () => {
    it('aborts all providers on timeout', async () => {
      const claudeState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      const geminiState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createAbortAwareAdapter('claude', 'claude-result', claudeState)],
        ['gemini', createAbortAwareAdapter('gemini', 'gemini-result', geminiState)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
          timeoutMs: 50,
        },
      )

      // Both should have been aborted -- they may show as success=true
      // The total duration should be well under the adapter delay (5000ms).
      expect(result.cancelled).toBe(true)
      expect(result.allResults.every((provider) => provider.cancelled)).toBe(true)
      expect(claudeState.executeCalls).toBe(1)
      expect(geminiState.executeCalls).toBe(1)
      expect(claudeState.abortListenerCalls).toBe(1)
      expect(geminiState.abortListenerCalls).toBe(1)
      expect(claudeState.signals.every((signal) => signal.aborted)).toBe(true)
      expect(geminiState.signals.every((signal) => signal.aborted)).toBe(true)
      expect(result.totalDurationMs).toBeLessThan(5500)

      const types = emitted.map((event) => event.type)
      expect(types).toContain('pipeline:run_started')
      expect(types).toContain('pipeline:run_cancelled')
      expect(types).not.toContain('pipeline:run_completed')

      const cancelledEvent = emitted.find((event) => event.type === 'pipeline:run_cancelled')
      expect(cancelledEvent).toMatchObject({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        reason: expect.stringContaining('timed out'),
      })
    })
  })

  describe('cancellation', () => {
    it('returns cancelled results without starting providers when already aborted', async () => {
      const claudeState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      const geminiState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createAbortAwareAdapter('claude', 'claude-result', claudeState)],
        ['gemini', createAbortAwareAdapter('gemini', 'gemini-result', geminiState)],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })
      const controller = new AbortController()
      controller.abort()

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
          signal: controller.signal,
        },
      )

      expect(result.cancelled).toBe(true)
      expect(result.selectedResult.cancelled).toBe(true)
      expect(result.allResults).toHaveLength(2)
      expect(result.allResults.every((provider) => provider.cancelled)).toBe(true)
      expect(claudeState.executeCalls).toBe(0)
      expect(geminiState.executeCalls).toBe(0)
      expect(emitted.some((event) => event.type === 'pipeline:node_started')).toBe(false)
      expect(emitted.some((event) => event.type === 'pipeline:run_started')).toBe(true)
      expect(emitted.some((event) => event.type === 'pipeline:run_completed')).toBe(false)

      const cancelledEvent = emitted.find((event) => event.type === 'pipeline:run_cancelled')
      expect(cancelledEvent).toMatchObject({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        reason: expect.stringContaining('cancel'),
      })
    })

    it('returns an explicit cancelled result for externally aborted runs', async () => {
      const claudeState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      const geminiState = {
        executeCalls: 0,
        abortListenerCalls: 0,
        signals: [] as AbortSignal[],
      }
      let resolveClaudeReady: (() => void) | undefined
      let resolveGeminiReady: (() => void) | undefined
      const claudeReady = new Promise<void>((resolve) => {
        resolveClaudeReady = resolve
      })
      const geminiReady = new Promise<void>((resolve) => {
        resolveGeminiReady = resolve
      })
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        [
          'claude',
          createAbortAwareAdapter('claude', 'claude-result', claudeState, () => {
            resolveClaudeReady?.()
          }),
        ],
        [
          'gemini',
          createAbortAwareAdapter('gemini', 'gemini-result', geminiState, () => {
            resolveGeminiReady?.()
          }),
        ],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })
      const controller = new AbortController()

      const execution = executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude', 'gemini'],
          mergeStrategy: 'all',
          signal: controller.signal,
        },
      )

      await Promise.all([claudeReady, geminiReady])
      controller.abort()
      const result = await execution

      expect(result.cancelled).toBe(true)
      expect(result.selectedResult.cancelled).toBe(true)
      expect(result.allResults).toHaveLength(2)
      expect(result.allResults.every((provider) => provider.cancelled)).toBe(true)
      expect(claudeState.executeCalls).toBe(1)
      expect(geminiState.executeCalls).toBe(1)
      expect(claudeState.abortListenerCalls).toBe(1)
      expect(geminiState.abortListenerCalls).toBe(1)
      expect(claudeState.signals[0]?.aborted).toBe(true)
      expect(geminiState.signals[0]?.aborted).toBe(true)
      expect(claudeState.signals[0]?.reason).toBe('external')
      expect(geminiState.signals[0]?.reason).toBe('external')
      expect(controller.signal.aborted).toBe(true)

      const types = emitted.map((event) => event.type)
      expect(types).toContain('pipeline:run_started')
      expect(types).toContain('pipeline:run_cancelled')
      expect(types).not.toContain('pipeline:run_completed')

      const cancelledEvent = emitted.find((event) => event.type === 'pipeline:run_cancelled')
      expect(cancelledEvent).toMatchObject({
        type: 'pipeline:run_cancelled',
        pipelineId: 'parallel-executor',
        reason: expect.stringContaining('cancel'),
      })
    })
  })

  describe('fallback attribution', () => {
    it('falls back to unknown when no providers are supplied', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['gemini', createMockAdapter('gemini', 'gemini-result')],
        ['claude', createMockAdapter('claude', 'claude-result')],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      const result = await executor.execute(
        { prompt: 'test' },
        {
          providers: [],
          mergeStrategy: 'all',
        },
      )

      expect(result.selectedResult.providerId).toBe('unknown' as AdapterProviderId)
      expect(result.selectedResult.success).toBe(false)
      expect(result.allResults).toHaveLength(0)
    })
  })

  describe('event bus emissions', () => {
    it('emits pipeline lifecycle events', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'result')],
      ])
      const registry = createMockRegistry(adapters)
      const executor = new ParallelExecutor({ registry, eventBus: bus })

      await executor.execute(
        { prompt: 'test' },
        {
          providers: ['claude'],
          mergeStrategy: 'all',
        },
      )

      const types = emitted.map((e) => e.type)
      expect(types).toContain('pipeline:run_started')
      expect(types).toContain('pipeline:run_completed')
    })
  })
})
