/**
 * Integration tests for the ReflectionAnalyzer -> LearningMiddleware feedback loop bridge.
 *
 * Tests cover:
 *   - createReflectionLearningBridge factory
 *   - buildWorkflowEventsFromToolStats conversion
 *   - End-to-end wiring with InMemoryReflectionStore
 *   - Filter behavior
 *   - Error resilience
 */

import { describe, it, expect, vi } from 'vitest'
import { createReflectionLearningBridge, buildWorkflowEventsFromToolStats } from './learning-bridge.js'
import { ReflectionAnalyzer } from './reflection-analyzer.js'
import { InMemoryReflectionStore } from './in-memory-reflection-store.js'
import type { ReflectionSummary } from './reflection-types.js'
import type { ToolStat, StopReason } from '../agent/tool-loop.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<ReflectionSummary> = {}): ReflectionSummary {
  return {
    runId: 'test-run-1',
    completedAt: new Date(),
    durationMs: 1000,
    totalSteps: 4,
    toolCallCount: 2,
    errorCount: 0,
    patterns: [],
    qualityScore: 0.9,
    ...overrides,
  }
}

function makeToolStats(stats: Array<Partial<ToolStat>>): ToolStat[] {
  return stats.map((s, i) => ({
    name: s.name ?? `tool_${i}`,
    calls: s.calls ?? 1,
    errors: s.errors ?? 0,
    totalMs: s.totalMs ?? 100,
    avgMs: s.avgMs ?? 100,
    ...s,
  }))
}

// ---------------------------------------------------------------------------
// buildWorkflowEventsFromToolStats
// ---------------------------------------------------------------------------

describe('buildWorkflowEventsFromToolStats', () => {
  it('produces step:started + step:completed events for successful calls', () => {
    const stats = makeToolStats([{ name: 'readFile', calls: 3, errors: 0, totalMs: 300, avgMs: 100 }])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')

    const started = events.filter(e => e.type === 'step:started')
    const completed = events.filter(e => e.type === 'step:completed')

    expect(started).toHaveLength(3)
    expect(completed).toHaveLength(3)
    for (const e of started) {
      expect(e).toEqual({ type: 'step:started', stepId: 'readFile' })
    }
    for (const e of completed) {
      expect(e).toEqual({ type: 'step:completed', stepId: 'readFile', durationMs: 100 })
    }
  })

  it('produces step:failed events for error calls (grouped consecutively)', () => {
    const stats = makeToolStats([{ name: 'writeFile', calls: 2, errors: 2, totalMs: 200, avgMs: 100 }])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')

    const failed = events.filter(e => e.type === 'step:failed')
    expect(failed).toHaveLength(2)
    for (const e of failed) {
      if (e.type === 'step:failed') {
        expect(e.stepId).toBe('writeFile')
        expect(e.error).toContain('writeFile')
      }
    }

    // Failures should be consecutive (no step:started interleaved)
    const failedIndices = events
      .map((e, i) => e.type === 'step:failed' ? i : -1)
      .filter(i => i >= 0)
    for (let i = 1; i < failedIndices.length; i++) {
      expect(failedIndices[i]).toBe(failedIndices[i - 1]! + 1)
    }
  })

  it('handles mixed success and error calls', () => {
    const stats = makeToolStats([{ name: 'api_call', calls: 5, errors: 2, totalMs: 500, avgMs: 100 }])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')

    const started = events.filter(e => e.type === 'step:started')
    const completed = events.filter(e => e.type === 'step:completed')
    const failed = events.filter(e => e.type === 'step:failed')
    expect(started).toHaveLength(3) // only successful calls get step:started
    expect(completed).toHaveLength(3) // 5 - 2
    expect(failed).toHaveLength(2)
  })

  it('produces workflow:completed for normal stop reasons', () => {
    const stats = makeToolStats([{ name: 'tool_a', calls: 1, errors: 0, totalMs: 50, avgMs: 50 }])

    for (const reason of ['complete', 'iteration_limit', 'budget_exceeded', 'aborted'] as StopReason[]) {
      const events = buildWorkflowEventsFromToolStats(stats, reason)
      const terminal = events[events.length - 1]
      expect(terminal?.type).toBe('workflow:completed')
    }
  })

  it('produces workflow:failed for stuck stop reason', () => {
    const stats = makeToolStats([{ name: 'tool_a', calls: 1, errors: 0, totalMs: 50, avgMs: 50 }])
    const events = buildWorkflowEventsFromToolStats(stats, 'stuck')
    const terminal = events[events.length - 1]
    expect(terminal?.type).toBe('workflow:failed')
  })

  it('produces workflow:failed for error stop reason', () => {
    const stats = makeToolStats([{ name: 'tool_a', calls: 1, errors: 1, totalMs: 50, avgMs: 50 }])
    const events = buildWorkflowEventsFromToolStats(stats, 'error')
    const terminal = events[events.length - 1]
    expect(terminal?.type).toBe('workflow:failed')
  })

  it('handles empty tool stats', () => {
    const events = buildWorkflowEventsFromToolStats([], 'complete')
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('workflow:completed')
    if (events[0]?.type === 'workflow:completed') {
      expect(events[0].durationMs).toBe(0)
    }
  })

  it('handles multiple tools with successes grouped before failures', () => {
    const stats = makeToolStats([
      { name: 'tool_a', calls: 2, errors: 0, totalMs: 200, avgMs: 100 },
      { name: 'tool_b', calls: 1, errors: 1, totalMs: 50, avgMs: 50 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')

    // tool_a: 2 started + 2 completed (success phase)
    // tool_b: 0 successful calls (1 call - 1 error = 0)
    // tool_b: 1 step:failed (failure phase)
    // workflow:completed = 1
    const started = events.filter(e => e.type === 'step:started')
    const completed = events.filter(e => e.type === 'step:completed')
    const failed = events.filter(e => e.type === 'step:failed')

    expect(started).toHaveLength(2) // 2 for tool_a, 0 for tool_b (no successes)
    expect(completed).toHaveLength(2) // 2 for tool_a
    expect(failed).toHaveLength(1) // 1 for tool_b
  })

  it('sets correct durationMs on workflow:completed', () => {
    const stats = makeToolStats([
      { name: 'a', calls: 1, errors: 0, totalMs: 100, avgMs: 100 },
      { name: 'b', calls: 1, errors: 0, totalMs: 200, avgMs: 200 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')
    const terminal = events[events.length - 1]
    if (terminal?.type === 'workflow:completed') {
      expect(terminal.durationMs).toBe(300)
    }
  })
})

// ---------------------------------------------------------------------------
// buildWorkflowEventsFromToolStats + ReflectionAnalyzer integration
// ---------------------------------------------------------------------------

describe('buildWorkflowEventsFromToolStats -> ReflectionAnalyzer', () => {
  it('produces a valid ReflectionSummary when fed to ReflectionAnalyzer', () => {
    const stats = makeToolStats([
      { name: 'readFile', calls: 3, errors: 0, totalMs: 300, avgMs: 100 },
      { name: 'writeFile', calls: 1, errors: 0, totalMs: 50, avgMs: 50 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')
    const analyzer = new ReflectionAnalyzer()
    const summary = analyzer.analyze('test-run', events)

    expect(summary.runId).toBe('test-run')
    expect(summary.toolCallCount).toBe(4) // 3 + 1 completed
    expect(summary.errorCount).toBe(0)
    expect(summary.qualityScore).toBeGreaterThan(0)
    expect(summary.qualityScore).toBeLessThanOrEqual(1)
    expect(summary.durationMs).toBe(350) // from workflow:completed
  })

  it('detects repeated_tool pattern from consecutive same-tool calls', () => {
    const stats = makeToolStats([
      { name: 'search', calls: 5, errors: 0, totalMs: 500, avgMs: 100 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')
    const analyzer = new ReflectionAnalyzer({ repeatedToolThreshold: 2 })
    const summary = analyzer.analyze('test-run', events)

    const repeated = summary.patterns.filter(p => p.type === 'repeated_tool')
    expect(repeated.length).toBeGreaterThan(0)
    expect(repeated[0]!.description).toContain('search')
  })

  it('detects error_loop pattern from consecutive failures', () => {
    const stats = makeToolStats([
      { name: 'deploy', calls: 3, errors: 3, totalMs: 300, avgMs: 100 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'error')
    const analyzer = new ReflectionAnalyzer({ errorLoopThreshold: 2 })
    const summary = analyzer.analyze('test-run', events)

    const errorLoops = summary.patterns.filter(p => p.type === 'error_loop')
    expect(errorLoops.length).toBeGreaterThan(0)
  })

  it('produces lower quality score for runs with errors', () => {
    const goodStats = makeToolStats([
      { name: 'tool', calls: 3, errors: 0, totalMs: 300, avgMs: 100 },
    ])
    const badStats = makeToolStats([
      { name: 'tool', calls: 3, errors: 3, totalMs: 300, avgMs: 100 },
    ])
    const analyzer = new ReflectionAnalyzer()

    const goodSummary = analyzer.analyze('good', buildWorkflowEventsFromToolStats(goodStats, 'complete'))
    const badSummary = analyzer.analyze('bad', buildWorkflowEventsFromToolStats(badStats, 'error'))

    expect(goodSummary.qualityScore).toBeGreaterThan(badSummary.qualityScore)
  })

  it('detects successful_strategy for 3+ consecutive successes', () => {
    const stats = makeToolStats([
      { name: 'step1', calls: 1, errors: 0, totalMs: 100, avgMs: 100 },
      { name: 'step2', calls: 1, errors: 0, totalMs: 100, avgMs: 100 },
      { name: 'step3', calls: 1, errors: 0, totalMs: 100, avgMs: 100 },
    ])
    const events = buildWorkflowEventsFromToolStats(stats, 'complete')
    const analyzer = new ReflectionAnalyzer()
    const summary = analyzer.analyze('test-run', events)

    const strategies = summary.patterns.filter(p => p.type === 'successful_strategy')
    expect(strategies.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// createReflectionLearningBridge
// ---------------------------------------------------------------------------

describe('createReflectionLearningBridge', () => {
  it('calls onSummary with the provided summary', async () => {
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({ onSummary })
    const summary = makeSummary()

    await bridge(summary)

    expect(onSummary).toHaveBeenCalledTimes(1)
    expect(onSummary).toHaveBeenCalledWith(summary)
  })

  it('saves to store before calling onSummary', async () => {
    const store = new InMemoryReflectionStore()
    const callOrder: string[] = []
    const onSummary = vi.fn().mockImplementation(async () => {
      callOrder.push('onSummary')
      // By this point, the store should already have the summary
      const stored = await store.get('test-run-1')
      expect(stored).toBeDefined()
    })

    // Spy on store.save
    const originalSave = store.save.bind(store)
    store.save = async (s) => {
      callOrder.push('store.save')
      return originalSave(s)
    }

    const bridge = createReflectionLearningBridge({ onSummary, store })
    await bridge(makeSummary())

    expect(callOrder).toEqual(['store.save', 'onSummary'])
    expect(store.size).toBe(1)
  })

  it('persists summary in the store', async () => {
    const store = new InMemoryReflectionStore()
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({ onSummary, store })

    const summary = makeSummary({ runId: 'persist-test' })
    await bridge(summary)

    const stored = await store.get('persist-test')
    expect(stored).toBeDefined()
    expect(stored?.runId).toBe('persist-test')
    expect(stored?.qualityScore).toBe(0.9)
  })

  it('skips callback when filter returns false', async () => {
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({
      onSummary,
      filter: (s) => s.qualityScore < 0.5, // Only forward low-quality runs
    })

    await bridge(makeSummary({ qualityScore: 0.9 }))
    expect(onSummary).not.toHaveBeenCalled()

    await bridge(makeSummary({ qualityScore: 0.3 }))
    expect(onSummary).toHaveBeenCalledTimes(1)
  })

  it('filter prevents store persistence too', async () => {
    const store = new InMemoryReflectionStore()
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({
      onSummary,
      store,
      filter: () => false,
    })

    await bridge(makeSummary())
    expect(store.size).toBe(0)
    expect(onSummary).not.toHaveBeenCalled()
  })

  it('passes filter receives the correct summary', async () => {
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const filterFn = vi.fn().mockReturnValue(true)
    const bridge = createReflectionLearningBridge({
      onSummary,
      filter: filterFn,
    })

    const summary = makeSummary({ runId: 'filter-check' })
    await bridge(summary)

    expect(filterFn).toHaveBeenCalledWith(summary)
    expect(onSummary).toHaveBeenCalledWith(summary)
  })

  it('works without a store', async () => {
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({ onSummary })

    await bridge(makeSummary())
    expect(onSummary).toHaveBeenCalledTimes(1)
  })

  it('propagates errors from onSummary (caller decides error handling)', async () => {
    const onSummary = vi.fn().mockRejectedValue(new Error('learning failed'))
    const bridge = createReflectionLearningBridge({ onSummary })

    await expect(bridge(makeSummary())).rejects.toThrow('learning failed')
  })

  it('propagates errors from store.save', async () => {
    const store = new InMemoryReflectionStore()
    store.save = async () => {
      throw new Error('store error')
    }
    const onSummary = vi.fn().mockResolvedValue(undefined)
    const bridge = createReflectionLearningBridge({ onSummary, store })

    await expect(bridge(makeSummary())).rejects.toThrow('store error')
  })

  it('handles multiple sequential calls', async () => {
    const store = new InMemoryReflectionStore()
    const summaries: ReflectionSummary[] = []
    const onSummary = vi.fn().mockImplementation(async (s: ReflectionSummary) => {
      summaries.push(s)
    })
    const bridge = createReflectionLearningBridge({ onSummary, store })

    await bridge(makeSummary({ runId: 'run-1' }))
    await bridge(makeSummary({ runId: 'run-2' }))
    await bridge(makeSummary({ runId: 'run-3' }))

    expect(store.size).toBe(3)
    expect(summaries).toHaveLength(3)
    expect(summaries.map(s => s.runId)).toEqual(['run-1', 'run-2', 'run-3'])
  })
})

// ---------------------------------------------------------------------------
// End-to-end: ToolStats -> WorkflowEvents -> Analyzer -> Bridge -> Store
// ---------------------------------------------------------------------------

describe('end-to-end reflection feedback loop', () => {
  it('full pipeline: toolStats -> events -> analyze -> bridge -> store', async () => {
    const store = new InMemoryReflectionStore()
    const receivedSummaries: ReflectionSummary[] = []
    const bridge = createReflectionLearningBridge({
      onSummary: async (summary) => {
        receivedSummaries.push(summary)
      },
      store,
    })

    const stats = makeToolStats([
      { name: 'readFile', calls: 3, errors: 0, totalMs: 150, avgMs: 50 },
      { name: 'writeFile', calls: 2, errors: 1, totalMs: 200, avgMs: 100 },
    ])

    const events = buildWorkflowEventsFromToolStats(stats, 'complete')
    const analyzer = new ReflectionAnalyzer()
    const summary = analyzer.analyze('e2e-run', events)

    await bridge(summary)

    // Verify stored
    const stored = await store.get('e2e-run')
    expect(stored).toBeDefined()
    expect(stored!.runId).toBe('e2e-run')
    expect(stored!.errorCount).toBe(1)
    expect(stored!.toolCallCount).toBe(4) // 3 + 1 successful

    // Verify forwarded
    expect(receivedSummaries).toHaveLength(1)
    expect(receivedSummaries[0]!.runId).toBe('e2e-run')
    expect(receivedSummaries[0]!.qualityScore).toBeLessThan(1.0)
  })

  it('full pipeline with quality filter only forwards poor runs', async () => {
    const receivedSummaries: ReflectionSummary[] = []
    const bridge = createReflectionLearningBridge({
      onSummary: async (summary) => {
        receivedSummaries.push(summary)
      },
      filter: (s) => s.qualityScore < 0.8,
    })

    const analyzer = new ReflectionAnalyzer()

    // Good run
    const goodStats = makeToolStats([
      { name: 'tool', calls: 5, errors: 0, totalMs: 500, avgMs: 100 },
    ])
    const goodSummary = analyzer.analyze('good-run', buildWorkflowEventsFromToolStats(goodStats, 'complete'))
    await bridge(goodSummary)

    // Bad run
    const badStats = makeToolStats([
      { name: 'tool', calls: 5, errors: 4, totalMs: 500, avgMs: 100 },
    ])
    const badSummary = analyzer.analyze('bad-run', buildWorkflowEventsFromToolStats(badStats, 'error'))
    await bridge(badSummary)

    expect(receivedSummaries).toHaveLength(1)
    expect(receivedSummaries[0]!.runId).toBe('bad-run')
  })

  it('can retrieve patterns from store after multiple runs', async () => {
    const store = new InMemoryReflectionStore()
    const bridge = createReflectionLearningBridge({
      onSummary: async () => {},
      store,
    })
    const analyzer = new ReflectionAnalyzer({ repeatedToolThreshold: 2 })

    // Run with repeated tool pattern
    const stats1 = makeToolStats([
      { name: 'search', calls: 5, errors: 0, totalMs: 500, avgMs: 100 },
    ])
    const summary1 = analyzer.analyze('run-1', buildWorkflowEventsFromToolStats(stats1, 'complete'))
    await bridge(summary1)

    // Clean run
    const stats2 = makeToolStats([
      { name: 'read', calls: 1, errors: 0, totalMs: 50, avgMs: 50 },
      { name: 'write', calls: 1, errors: 0, totalMs: 50, avgMs: 50 },
    ])
    const summary2 = analyzer.analyze('run-2', buildWorkflowEventsFromToolStats(stats2, 'complete'))
    await bridge(summary2)

    const repeatedPatterns = await store.getPatterns('repeated_tool')
    expect(repeatedPatterns.length).toBeGreaterThan(0)
    expect(repeatedPatterns[0]!.description).toContain('search')

    const allSummaries = await store.list()
    expect(allSummaries).toHaveLength(2)
  })
})
