import { describe, expect, it, beforeEach } from 'vitest'
import type { WorkflowEvent } from '../workflow/workflow-types.js'
import type { ReflectionSummary } from './reflection-types.js'
import { ReflectionAnalyzer } from './reflection-analyzer.js'
import { InMemoryReflectionStore } from './in-memory-reflection-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStarted(stepId: string): WorkflowEvent {
  return { type: 'step:started', stepId }
}

function makeCompleted(stepId: string, durationMs: number): WorkflowEvent {
  return { type: 'step:completed', stepId, durationMs }
}

function makeFailed(stepId: string, error: string): WorkflowEvent {
  return { type: 'step:failed', stepId, error }
}

function makeWorkflowCompleted(durationMs: number): WorkflowEvent {
  return { type: 'workflow:completed', durationMs }
}

function makeWorkflowFailed(error: string): WorkflowEvent {
  return { type: 'workflow:failed', error }
}

// ---------------------------------------------------------------------------
// ReflectionAnalyzer
// ---------------------------------------------------------------------------

describe('ReflectionAnalyzer', () => {
  let analyzer: ReflectionAnalyzer

  beforeEach(() => {
    analyzer = new ReflectionAnalyzer()
  })

  it('produces a valid ReflectionSummary for an empty event list', () => {
    const summary = analyzer.analyze('run-1', [])
    expect(summary.runId).toBe('run-1')
    expect(summary.totalSteps).toBe(0)
    expect(summary.toolCallCount).toBe(0)
    expect(summary.errorCount).toBe(0)
    expect(summary.patterns).toEqual([])
    expect(summary.qualityScore).toBeGreaterThanOrEqual(0)
    expect(summary.qualityScore).toBeLessThanOrEqual(1)
  })

  it('counts errorCount from step:failed events', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeFailed('a', 'boom'),
      makeStarted('b'),
      makeCompleted('b', 100),
      makeStarted('c'),
      makeFailed('c', 'crash'),
    ]
    const summary = analyzer.analyze('run-err', events)
    expect(summary.errorCount).toBe(2)
  })

  it('counts toolCallCount from step:completed events', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 50),
      makeStarted('b'),
      makeCompleted('b', 80),
      makeStarted('c'),
      makeCompleted('c', 60),
    ]
    const summary = analyzer.analyze('run-tc', events)
    expect(summary.toolCallCount).toBe(3)
  })

  it('detects repeated_tool pattern from consecutive step:started events with same stepId', () => {
    const events: WorkflowEvent[] = [
      makeStarted('read_file'),
      makeCompleted('read_file', 50),
      makeStarted('read_file'),
      makeCompleted('read_file', 55),
      makeStarted('read_file'),
      makeCompleted('read_file', 48),
    ]
    const summary = analyzer.analyze('run-repeat', events)
    const repeatedPatterns = summary.patterns.filter((p) => p.type === 'repeated_tool')
    expect(repeatedPatterns.length).toBeGreaterThanOrEqual(1)
    expect(repeatedPatterns[0]!.occurrences).toBe(3)
    expect(repeatedPatterns[0]!.description).toContain('read_file')
  })

  it('does not flag repeated_tool when different tools alternate', () => {
    const events: WorkflowEvent[] = [
      makeStarted('tool_a'),
      makeCompleted('tool_a', 50),
      makeStarted('tool_b'),
      makeCompleted('tool_b', 50),
      makeStarted('tool_a'),
      makeCompleted('tool_a', 50),
    ]
    const summary = analyzer.analyze('run-alt', events)
    const repeatedPatterns = summary.patterns.filter((p) => p.type === 'repeated_tool')
    expect(repeatedPatterns).toEqual([])
  })

  it('detects error_loop pattern from consecutive step:failed events', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeFailed('a', 'err1'),
      makeFailed('a', 'err2'),
      makeFailed('a', 'err3'),
    ]
    const summary = analyzer.analyze('run-errloop', events)
    const errorLoops = summary.patterns.filter((p) => p.type === 'error_loop')
    expect(errorLoops.length).toBe(1)
    expect(errorLoops[0]!.occurrences).toBe(3)
  })

  it('detects slow_step pattern when a step exceeds the median threshold', () => {
    const events: WorkflowEvent[] = [
      makeStarted('fast1'),
      makeCompleted('fast1', 100),
      makeStarted('fast2'),
      makeCompleted('fast2', 100),
      makeStarted('fast3'),
      makeCompleted('fast3', 100),
      makeStarted('slow_one'),
      makeCompleted('slow_one', 5000), // 50x the median of 100
    ]
    const summary = analyzer.analyze('run-slow', events)
    const slowPatterns = summary.patterns.filter((p) => p.type === 'slow_step')
    expect(slowPatterns.length).toBeGreaterThanOrEqual(1)
    expect(slowPatterns[0]!.description).toContain('slow_one')
  })

  it('detects successful_strategy from 3+ consecutive completions', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 50),
      makeStarted('b'),
      makeCompleted('b', 60),
      makeStarted('c'),
      makeCompleted('c', 70),
    ]
    const summary = analyzer.analyze('run-success', events)
    const strategies = summary.patterns.filter((p) => p.type === 'successful_strategy')
    expect(strategies.length).toBe(1)
    expect(strategies[0]!.occurrences).toBe(3)
  })

  it('computes lower quality score when there are many errors', () => {
    const cleanEvents: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 50),
      makeStarted('b'),
      makeCompleted('b', 60),
      makeWorkflowCompleted(110),
    ]
    const errorEvents: WorkflowEvent[] = [
      makeStarted('a'),
      makeFailed('a', 'err1'),
      makeFailed('a', 'err2'),
      makeFailed('a', 'err3'),
      makeWorkflowFailed('too many errors'),
    ]

    const cleanSummary = analyzer.analyze('clean', cleanEvents)
    const errorSummary = analyzer.analyze('errors', errorEvents)

    expect(cleanSummary.qualityScore).toBeGreaterThan(errorSummary.qualityScore)
    expect(errorSummary.qualityScore).toBeLessThan(0.5)
  })

  it('gives perfect score (1.0) for a clean run with completions and no errors', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 50),
      makeWorkflowCompleted(50),
    ]
    const summary = analyzer.analyze('perfect', events)
    // Base 1.0 + success bonus capped at 1.0
    expect(summary.qualityScore).toBe(1.0)
  })

  it('uses workflow:completed durationMs as the summary durationMs', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 50),
      makeWorkflowCompleted(200),
    ]
    const summary = analyzer.analyze('dur', events)
    expect(summary.durationMs).toBe(200)
  })

  it('falls back to summing step durations when no workflow:completed event', () => {
    const events: WorkflowEvent[] = [
      makeStarted('a'),
      makeCompleted('a', 100),
      makeStarted('b'),
      makeCompleted('b', 200),
    ]
    const summary = analyzer.analyze('dur-sum', events)
    expect(summary.durationMs).toBe(300)
  })

  it('respects custom config thresholds', () => {
    const strict = new ReflectionAnalyzer({
      repeatedToolThreshold: 1,
      errorLoopThreshold: 1,
      slowStepMultiplier: 1.5,
    })
    // A single step:started is enough for repeated_tool with threshold=1
    // But we need at least 1 started event, so threshold=1 means 1 consecutive = flagged
    // Actually threshold=1 means any single occurrence counts - let's test threshold=2 with 2
    const lenient = new ReflectionAnalyzer({ repeatedToolThreshold: 3 })

    const events: WorkflowEvent[] = [
      makeStarted('x'),
      makeCompleted('x', 50),
      makeStarted('x'),
      makeCompleted('x', 55),
    ]
    const strictSummary = strict.analyze('s', events)
    const lenientSummary = lenient.analyze('l', events)

    const strictRepeated = strictSummary.patterns.filter((p) => p.type === 'repeated_tool')
    const lenientRepeated = lenientSummary.patterns.filter((p) => p.type === 'repeated_tool')

    // strict threshold=1 means even 2 is flagged
    expect(strictRepeated.length).toBeGreaterThanOrEqual(1)
    // lenient threshold=3 means 2 is NOT flagged
    expect(lenientRepeated.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// InMemoryReflectionStore
// ---------------------------------------------------------------------------

describe('InMemoryReflectionStore', () => {
  let store: InMemoryReflectionStore

  const makeSummary = (runId: string, overrides?: Partial<ReflectionSummary>): ReflectionSummary => ({
    runId,
    completedAt: overrides?.completedAt ?? new Date(),
    durationMs: overrides?.durationMs ?? 1000,
    totalSteps: overrides?.totalSteps ?? 5,
    toolCallCount: overrides?.toolCallCount ?? 3,
    errorCount: overrides?.errorCount ?? 0,
    patterns: overrides?.patterns ?? [],
    qualityScore: overrides?.qualityScore ?? 0.9,
  })

  beforeEach(() => {
    store = new InMemoryReflectionStore()
  })

  it('save() and get() round-trip a summary', async () => {
    const summary = makeSummary('run-1')
    await store.save(summary)
    const retrieved = await store.get('run-1')
    expect(retrieved).toEqual(summary)
  })

  it('get() returns undefined for missing run', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('save() overwrites an existing summary with the same runId', async () => {
    await store.save(makeSummary('run-1', { qualityScore: 0.5 }))
    await store.save(makeSummary('run-1', { qualityScore: 0.9 }))
    const retrieved = await store.get('run-1')
    expect(retrieved!.qualityScore).toBe(0.9)
    expect(store.size).toBe(1)
  })

  it('list() returns summaries ordered by completedAt descending', async () => {
    const old = makeSummary('old', { completedAt: new Date('2025-01-01T00:00:00Z') })
    const mid = makeSummary('mid', { completedAt: new Date('2025-06-01T00:00:00Z') })
    const recent = makeSummary('recent', { completedAt: new Date('2026-01-01T00:00:00Z') })

    await store.save(mid)
    await store.save(old)
    await store.save(recent)

    const all = await store.list()
    expect(all.map((s) => s.runId)).toEqual(['recent', 'mid', 'old'])
  })

  it('list() respects the limit parameter', async () => {
    await store.save(makeSummary('a', { completedAt: new Date('2025-01-01') }))
    await store.save(makeSummary('b', { completedAt: new Date('2025-02-01') }))
    await store.save(makeSummary('c', { completedAt: new Date('2025-03-01') }))

    const limited = await store.list(2)
    expect(limited.length).toBe(2)
    expect(limited[0]!.runId).toBe('c')
    expect(limited[1]!.runId).toBe('b')
  })

  it('list() returns all when no limit provided', async () => {
    await store.save(makeSummary('a'))
    await store.save(makeSummary('b'))
    const all = await store.list()
    expect(all.length).toBe(2)
  })

  it('getPatterns() returns matching patterns across all summaries', async () => {
    await store.save(
      makeSummary('run-1', {
        patterns: [
          { type: 'repeated_tool', description: 'tool X repeated', occurrences: 3, stepIndices: [0, 1, 2] },
          { type: 'slow_step', description: 'step Y slow', occurrences: 1, stepIndices: [4] },
        ],
      }),
    )
    await store.save(
      makeSummary('run-2', {
        patterns: [
          { type: 'repeated_tool', description: 'tool Z repeated', occurrences: 2, stepIndices: [0, 1] },
          { type: 'error_loop', description: '2 consecutive failures', occurrences: 2, stepIndices: [3, 4] },
        ],
      }),
    )

    const repeated = await store.getPatterns('repeated_tool')
    expect(repeated.length).toBe(2)
    expect(repeated.every((p) => p.type === 'repeated_tool')).toBe(true)

    const errorLoops = await store.getPatterns('error_loop')
    expect(errorLoops.length).toBe(1)
    expect(errorLoops[0]!.type).toBe('error_loop')

    const successful = await store.getPatterns('successful_strategy')
    expect(successful.length).toBe(0)
  })

  it('getPatterns() returns empty array when store is empty', async () => {
    const result = await store.getPatterns('repeated_tool')
    expect(result).toEqual([])
  })

  it('clear() removes all summaries', async () => {
    await store.save(makeSummary('a'))
    await store.save(makeSummary('b'))
    expect(store.size).toBe(2)
    store.clear()
    expect(store.size).toBe(0)
    expect(await store.list()).toEqual([])
  })
})
