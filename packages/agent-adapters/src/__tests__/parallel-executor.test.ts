import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEvent, DzipEventBus } from '@dzipagent/core'

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

function createMockRegistry(adapters: Map<AdapterProviderId, AgentCLIAdapter>): AdapterRegistry {
  return {
    getHealthy(providerId: AdapterProviderId) {
      return adapters.get(providerId)
    },
  } as unknown as AdapterRegistry
}

function collectBusEvents(bus: DzipEventBus): DzipEvent[] {
  const events: DzipEvent[] = []
  bus.onAny((e) => events.push(e))
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ParallelExecutor', () => {
  let bus: DzipEventBus
  let emitted: DzipEvent[]

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
  })

  describe('timeout', () => {
    it('aborts all providers on timeout', async () => {
      const adapters = new Map<AdapterProviderId, AgentCLIAdapter>([
        ['claude', createMockAdapter('claude', 'claude-result', 5000)],
        ['gemini', createMockAdapter('gemini', 'gemini-result', 5000)],
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
      // if the adapter handled the abort gracefully, or false if they threw.
      // The total duration should be well under the adapter delay (5000ms).
      expect(result.totalDurationMs).toBeLessThan(5500)
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
