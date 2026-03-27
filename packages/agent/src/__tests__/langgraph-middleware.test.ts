import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LangGraphLearningMiddleware } from '../self-correction/langgraph-middleware.js'
import type { LangGraphLearningConfig, LearningRunMetrics } from '../self-correction/langgraph-middleware.js'

// ---------------------------------------------------------------------------
// Mock BaseStore
// ---------------------------------------------------------------------------

interface MockStoreItem {
  key: string
  value: Record<string, unknown>
  namespace: string[]
}

function createMockStore() {
  const items: MockStoreItem[] = []

  return {
    items,
    put: vi.fn(async (namespace: string[], key: string, value: Record<string, unknown>) => {
      items.push({ key, value, namespace })
    }),
    search: vi.fn(async (_namespace: string[], _opts?: { limit?: number }) => {
      return [] as Array<{ key: string; value: Record<string, unknown> }>
    }),
    get: vi.fn(async (_namespace: string[], _key: string) => {
      return undefined
    }),
    delete: vi.fn(async (_namespace: string[], _key: string) => {
      // no-op
    }),
  }
}

type MockStore = ReturnType<typeof createMockStore>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait a tick for async operations. */
const tick = () => new Promise<void>((r) => setTimeout(r, 10))

function makeConfig(store: MockStore, overrides?: Partial<LangGraphLearningConfig>): LangGraphLearningConfig {
  return {
    store: store as unknown as LangGraphLearningConfig['store'],
    taskType: 'crud',
    riskClass: 'standard',
    ...overrides,
  }
}

interface TestState extends Record<string, unknown> {
  input: string
  output?: string
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LangGraphLearningMiddleware', () => {
  let store: MockStore
  let middleware: LangGraphLearningMiddleware

  beforeEach(() => {
    store = createMockStore()
    middleware = new LangGraphLearningMiddleware(makeConfig(store))
  })

  // -----------------------------------------------------------------------
  // wrapNode — signature preservation
  // -----------------------------------------------------------------------

  describe('wrapNode', () => {
    it('preserves function signature and return value', async () => {
      const original = vi.fn(async (state: TestState) => ({
        output: `processed: ${state.input}`,
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      const result = await wrapped({ input: 'hello' })

      expect(result).toEqual({ output: 'processed: hello' })
      expect(original).toHaveBeenCalledTimes(1)
    })

    it('passes config argument through to original function', async () => {
      const original = vi.fn(async (state: TestState, _config?: unknown) => ({
        output: state.input,
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      const nodeConfig = { configurable: { thread_id: '123' } }
      await wrapped({ input: 'test' }, nodeConfig)

      expect(original).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'test' }),
        nodeConfig,
      )
    })

    it('applies enrichment to state when store has data', async () => {
      // Make the store return rules
      store.search.mockResolvedValue([
        {
          key: 'rule1',
          value: { text: 'Always use TypeScript strict', scope: '*' },
        },
      ])

      const original = vi.fn(async (state: TestState) => ({
        output: state.input,
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      await wrapped({ input: 'test' })

      // The original should receive enriched state with _learningContext
      const calledState = original.mock.calls[0]![0] as TestState
      expect(calledState._learningContext).toBeDefined()
      expect(typeof calledState._learningContext).toBe('string')
      expect(calledState._learningContext as string).toContain('Always use TypeScript strict')
    })

    it('applies enrichment to systemPromptAddendum if present in state', async () => {
      store.search.mockResolvedValue([
        {
          key: 'rule1',
          value: { text: 'Use ESM imports', scope: '*' },
        },
      ])

      const original = vi.fn(async (state: Record<string, unknown>) => ({
        output: 'done',
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      await wrapped({ input: 'test', systemPromptAddendum: 'existing context' })

      const calledState = original.mock.calls[0]![0] as Record<string, unknown>
      expect(typeof calledState['systemPromptAddendum']).toBe('string')
      expect(calledState['systemPromptAddendum'] as string).toContain('existing context')
      expect(calledState['systemPromptAddendum'] as string).toContain('Use ESM imports')
    })

    it('records trajectory step on success', async () => {
      const original = async (state: TestState) => ({ output: state.input })
      const wrapped = middleware.wrapNode('gen_backend', original)
      await middleware.onPipelineStart('run-1')
      await wrapped({ input: 'test' })

      // store.put should have been called for trajectory step recording
      const trajectoryCalls = store.put.mock.calls.filter(
        (call) => {
          const ns = call[0] as string[]
          return ns.some((s: string) => s === 'steps')
        },
      )
      expect(trajectoryCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('records errors on failure and re-throws', async () => {
      const original = async (_state: TestState): Promise<Partial<TestState>> => {
        throw new Error('compilation failed')
      }

      const wrapped = middleware.wrapNode('gen_backend', original)

      await expect(wrapped({ input: 'test' })).rejects.toThrow('compilation failed')
    })

    it('never swallows node errors — always re-throws', async () => {
      const original = async (_state: TestState): Promise<Partial<TestState>> => {
        throw new TypeError('type error in node')
      }

      const wrapped = middleware.wrapNode('gen_backend', original)

      try {
        await wrapped({ input: 'test' })
        // Should not reach here
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError)
        expect((err as Error).message).toBe('type error in node')
      }
    })

    it('learning errors do not affect node execution', async () => {
      // Make store.search throw to simulate learning failure
      store.search.mockRejectedValue(new Error('store unavailable'))

      const original = vi.fn(async (state: TestState) => ({
        output: `ok: ${state.input}`,
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      const result = await wrapped({ input: 'hello' })

      // Node should still succeed
      expect(result).toEqual({ output: 'ok: hello' })
      expect(original).toHaveBeenCalledTimes(1)
    })

    it('learning errors during trajectory recording do not affect result', async () => {
      // Store put will fail
      store.put.mockRejectedValue(new Error('write failed'))

      const original = async (state: TestState) => ({
        output: state.input,
      })

      const wrapped = middleware.wrapNode('gen_backend', original)
      const result = await wrapped({ input: 'test' })

      expect(result).toEqual({ output: 'test' })
    })
  })

  // -----------------------------------------------------------------------
  // Feature flags
  // -----------------------------------------------------------------------

  describe('feature flags', () => {
    it('skips enrichment when enableEnrichment is false', async () => {
      middleware = new LangGraphLearningMiddleware(
        makeConfig(store, { enableEnrichment: false }),
      )

      store.search.mockResolvedValue([
        { key: 'r1', value: { text: 'A rule', scope: '*' } },
      ])

      const original = vi.fn(async (state: TestState) => ({
        output: state.input,
      }))

      const wrapped = middleware.wrapNode('gen_backend', original)
      await wrapped({ input: 'test' })

      // State should NOT have _learningContext
      const calledState = original.mock.calls[0]![0] as TestState
      expect(calledState._learningContext).toBeUndefined()
    })

    it('skips trajectory recording when enableTrajectory is false', async () => {
      middleware = new LangGraphLearningMiddleware(
        makeConfig(store, { enableTrajectory: false }),
      )

      const original = async (state: TestState) => ({ output: state.input })
      const wrapped = middleware.wrapNode('gen_backend', original)
      await wrapped({ input: 'test' })

      // No trajectory step calls (put calls for trajectory namespaces)
      const trajectoryCalls = store.put.mock.calls.filter(
        (call) => {
          const ns = call[0] as string[]
          return ns.some((s: string) => s === 'steps')
        },
      )
      expect(trajectoryCalls.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  describe('metrics', () => {
    it('tracks nodesWrapped count', () => {
      const fn = async (s: TestState) => ({ output: s.input })
      middleware.wrapNode('a', fn)
      middleware.wrapNode('b', fn)
      middleware.wrapNode('c', fn)

      expect(middleware.getMetrics().nodesWrapped).toBe(3)
    })

    it('tracks nodesExecuted count', async () => {
      const fn = async (s: TestState) => ({ output: s.input })
      const wrapped = middleware.wrapNode('a', fn)
      await wrapped({ input: '1' })
      await wrapped({ input: '2' })

      expect(middleware.getMetrics().nodesExecuted).toBe(2)
    })

    it('tracks nodesFailed count', async () => {
      const fn = async (_s: TestState): Promise<Partial<TestState>> => {
        throw new Error('fail')
      }
      const wrapped = middleware.wrapNode('a', fn)

      try { await wrapped({ input: '1' }) } catch { /* expected */ }
      try { await wrapped({ input: '2' }) } catch { /* expected */ }

      expect(middleware.getMetrics().nodesFailed).toBe(2)
    })

    it('tracks enrichmentsApplied count', async () => {
      store.search.mockResolvedValue([
        { key: 'r1', value: { text: 'A rule', scope: '*' } },
      ])

      const fn = async (s: TestState) => ({ output: s.input })
      const wrapped = middleware.wrapNode('a', fn)
      await wrapped({ input: 'test' })

      expect(middleware.getMetrics().enrichmentsApplied).toBe(1)
    })

    it('tracks totalDurationMs', async () => {
      const fn = async (s: TestState) => {
        await new Promise<void>((r) => setTimeout(r, 20))
        return { output: s.input }
      }
      const wrapped = middleware.wrapNode('a', fn)
      await wrapped({ input: 'test' })

      expect(middleware.getMetrics().totalDurationMs).toBeGreaterThanOrEqual(15)
    })

    it('returns a copy from getMetrics', () => {
      const m1 = middleware.getMetrics()
      const m2 = middleware.getMetrics()
      expect(m1).not.toBe(m2)
      expect(m1).toEqual(m2)
    })
  })

  // -----------------------------------------------------------------------
  // resetMetrics
  // -----------------------------------------------------------------------

  describe('resetMetrics', () => {
    it('clears all counters', async () => {
      const fn = async (s: TestState) => ({ output: s.input })
      const wrapped = middleware.wrapNode('a', fn)
      await wrapped({ input: 'test' })

      middleware.resetMetrics()
      const metrics = middleware.getMetrics()

      expect(metrics.nodesWrapped).toBe(0)
      expect(metrics.nodesExecuted).toBe(0)
      expect(metrics.nodesFailed).toBe(0)
      expect(metrics.enrichmentsApplied).toBe(0)
      expect(metrics.trajectoryStepsRecorded).toBe(0)
      expect(metrics.totalDurationMs).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // onPipelineStart / onPipelineEnd
  // -----------------------------------------------------------------------

  describe('onPipelineEnd', () => {
    it('produces analysis with lessons and rules', async () => {
      await middleware.onPipelineStart('run-1')

      const result = await middleware.onPipelineEnd({
        runId: 'run-1',
        overallScore: 0.9,
        approved: true,
        errors: [
          {
            nodeId: 'gen_backend',
            error: 'missing import',
            resolved: true,
            resolution: 'added import statement',
          },
        ],
      })

      expect(result.lessonsCreated).toBeGreaterThanOrEqual(0)
      expect(result.rulesCreated).toBeGreaterThanOrEqual(0)
      expect(typeof result.summary).toBe('string')
      expect(result.summary.length).toBeGreaterThan(0)
    })

    it('returns empty result when post-run analysis is disabled', async () => {
      middleware = new LangGraphLearningMiddleware(
        makeConfig(store, { enablePostRunAnalysis: false }),
      )

      const result = await middleware.onPipelineEnd({
        runId: 'run-1',
        overallScore: 0.8,
      })

      expect(result.lessonsCreated).toBe(0)
      expect(result.rulesCreated).toBe(0)
      expect(result.summary).toBe('Post-run analysis disabled.')
    })

    it('handles store failures gracefully', async () => {
      store.put.mockRejectedValue(new Error('store down'))
      await middleware.onPipelineStart('run-1')

      const result = await middleware.onPipelineEnd({
        runId: 'run-1',
        overallScore: 0.5,
      })

      // Should not throw, should return a result
      expect(typeof result.summary).toBe('string')
    })
  })

  // -----------------------------------------------------------------------
  // recommendFixStrategy
  // -----------------------------------------------------------------------

  describe('recommendFixStrategy', () => {
    it('returns a strategy recommendation', async () => {
      const result = await middleware.recommendFixStrategy('type_error', 'gen_backend')

      expect(typeof result.strategy).toBe('string')
      expect(typeof result.confidence).toBe('number')
      expect(typeof result.reasoning).toBe('string')
    })

    it('returns default when strategy advice is disabled', async () => {
      middleware = new LangGraphLearningMiddleware(
        makeConfig(store, { enableStrategyAdvice: false }),
      )

      const result = await middleware.recommendFixStrategy('type_error', 'gen_backend')

      expect(result.strategy).toBe('targeted')
      expect(result.reasoning).toBe('Strategy advice disabled.')
    })

    it('handles store failures gracefully', async () => {
      store.search.mockRejectedValue(new Error('store down'))

      const result = await middleware.recommendFixStrategy('type_error', 'gen_backend')

      expect(typeof result.strategy).toBe('string')
      expect(typeof result.confidence).toBe('number')
    })
  })

  // -----------------------------------------------------------------------
  // enrichPrompt
  // -----------------------------------------------------------------------

  describe('enrichPrompt', () => {
    it('returns formatted enrichment content', async () => {
      store.search.mockResolvedValue([
        { key: 'r1', value: { text: 'Always validate inputs', scope: '*' } },
      ])

      const content = await middleware.enrichPrompt('gen_backend')

      expect(typeof content).toBe('string')
      expect(content).toContain('Always validate inputs')
    })

    it('returns empty string when no enrichment data', async () => {
      store.search.mockResolvedValue([])

      const content = await middleware.enrichPrompt('gen_backend')

      expect(content).toBe('')
    })

    it('returns empty string on store error', async () => {
      store.search.mockRejectedValue(new Error('store down'))

      const content = await middleware.enrichPrompt('gen_backend')

      expect(content).toBe('')
    })
  })

  // -----------------------------------------------------------------------
  // Default config
  // -----------------------------------------------------------------------

  describe('default config', () => {
    it('uses sensible defaults when no options provided', () => {
      const m = new LangGraphLearningMiddleware({
        store: store as unknown as LangGraphLearningConfig['store'],
      })

      // Should not throw
      const metrics = m.getMetrics()
      expect(metrics.nodesWrapped).toBe(0)
    })

    it('enables all features by default', async () => {
      const m = new LangGraphLearningMiddleware({
        store: store as unknown as LangGraphLearningConfig['store'],
      })

      store.search.mockResolvedValue([
        { key: 'r1', value: { text: 'A rule', scope: '*' } },
      ])

      const fn = vi.fn(async (s: TestState) => ({ output: s.input }))
      const wrapped = m.wrapNode('test_node', fn)
      await wrapped({ input: 'hello' })

      // Enrichment should have been applied
      const calledState = fn.mock.calls[0]![0] as TestState
      expect(calledState._learningContext).toBeDefined()
    })
  })
})
