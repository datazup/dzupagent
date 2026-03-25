import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineAnalytics } from '../pipeline/pipeline-analytics.js'
import type { AnalyticsRunInput } from '../pipeline/pipeline-analytics.js'

/** Helper to create a run input. */
function makeRun(overrides: Partial<AnalyticsRunInput> & { pipelineId: string }): AnalyticsRunInput {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    state: 'completed',
    nodeResults: new Map(),
    totalDurationMs: 1000,
    ...overrides,
  }
}

describe('PipelineAnalytics', () => {
  let analytics: PipelineAnalytics

  beforeEach(() => {
    analytics = new PipelineAnalytics()
  })

  // -----------------------------------------------------------------------
  // Basic data storage
  // -----------------------------------------------------------------------

  it('addRun stores run data and getReport reflects it', () => {
    analytics.addRun(makeRun({ pipelineId: 'p1', totalDurationMs: 500 }))
    const report = analytics.getReport('p1')
    expect(report.totalRuns).toBe(1)
    expect(report.avgDurationMs).toBe(500)
  })

  it('getReport returns empty report for unknown pipeline', () => {
    const report = analytics.getReport('nonexistent')
    expect(report.totalRuns).toBe(0)
    expect(report.avgDurationMs).toBe(0)
    expect(report.successRate).toBe(0)
    expect(report.nodeMetrics).toEqual([])
  })

  // -----------------------------------------------------------------------
  // Node metrics aggregation
  // -----------------------------------------------------------------------

  it('getReport aggregates node metrics correctly', () => {
    const nodeResults = new Map([
      ['n1', { nodeId: 'llm:generate', output: {}, durationMs: 200 }],
      ['n2', { nodeId: 'validate-schema', output: {}, durationMs: 50 }],
    ])
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults, totalDurationMs: 250 }))

    const report = analytics.getReport('p1')
    expect(report.nodeMetrics.length).toBe(2)

    const llmNode = report.nodeMetrics.find((n) => n.nodeId === 'llm:generate')
    expect(llmNode).toBeDefined()
    expect(llmNode!.executionCount).toBe(1)
    expect(llmNode!.avgDurationMs).toBe(200)
    expect(llmNode!.successRate).toBe(1)
    expect(llmNode!.nodeType).toBe('llm')
  })

  it('getReport calculates success rate for pipeline', () => {
    analytics.addRun(makeRun({ pipelineId: 'p1', state: 'completed' }))
    analytics.addRun(makeRun({ pipelineId: 'p1', state: 'completed' }))
    analytics.addRun(makeRun({ pipelineId: 'p1', state: 'failed' }))

    const report = analytics.getReport('p1')
    expect(report.successRate).toBeCloseTo(2 / 3, 5)
  })

  it('getReport calculates node success rate correctly', () => {
    const successResults = new Map([
      ['n1', { nodeId: 'step-a', output: {}, durationMs: 100 }],
    ])
    const failResults = new Map([
      ['n1', { nodeId: 'step-a', output: {}, durationMs: 100, error: 'boom' }],
    ])

    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: successResults }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: successResults }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: failResults }))

    const report = analytics.getReport('p1')
    const node = report.nodeMetrics.find((n) => n.nodeId === 'step-a')
    expect(node).toBeDefined()
    expect(node!.successCount).toBe(2)
    expect(node!.failureCount).toBe(1)
    expect(node!.successRate).toBeCloseTo(2 / 3, 5)
  })

  // -----------------------------------------------------------------------
  // Multiple runs aggregation
  // -----------------------------------------------------------------------

  it('multiple runs are aggregated correctly', () => {
    const nr1 = new Map([
      ['n1', { nodeId: 'step-x', output: {}, durationMs: 100 }],
    ])
    const nr2 = new Map([
      ['n1', { nodeId: 'step-x', output: {}, durationMs: 300 }],
    ])

    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: nr1, totalDurationMs: 100 }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: nr2, totalDurationMs: 300 }))

    const report = analytics.getReport('p1')
    expect(report.totalRuns).toBe(2)
    expect(report.avgDurationMs).toBe(200)

    const node = report.nodeMetrics.find((n) => n.nodeId === 'step-x')
    expect(node).toBeDefined()
    expect(node!.executionCount).toBe(2)
    expect(node!.avgDurationMs).toBe(200)
    expect(node!.minDurationMs).toBe(100)
    expect(node!.maxDurationMs).toBe(300)
  })

  // -----------------------------------------------------------------------
  // Bottleneck detection
  // -----------------------------------------------------------------------

  it('getBottlenecks returns slowest node', () => {
    const nodeResults = new Map([
      ['n1', { nodeId: 'fast-step', output: {}, durationMs: 10 }],
      ['n2', { nodeId: 'slow-step', output: {}, durationMs: 5000 }],
    ])
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults }))

    const bottlenecks = analytics.getBottlenecks('p1')
    const slowest = bottlenecks.find((b) => b.reason === 'slowest')
    expect(slowest).toBeDefined()
    expect(slowest!.nodeId).toBe('slow-step')
    expect(slowest!.value).toBe(5000)
  })

  it('getBottlenecks returns highest failure rate (min 3 executions)', () => {
    const success = new Map([
      ['n1', { nodeId: 'stable', output: {}, durationMs: 10 }],
      ['n2', { nodeId: 'flaky', output: {}, durationMs: 10 }],
    ])
    const failFlaky = new Map([
      ['n1', { nodeId: 'stable', output: {}, durationMs: 10 }],
      ['n2', { nodeId: 'flaky', output: {}, durationMs: 10, error: 'oops' }],
    ])

    // 3 runs: stable always succeeds, flaky fails 2/3
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: success }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: failFlaky }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: failFlaky }))

    const bottlenecks = analytics.getBottlenecks('p1')
    const failure = bottlenecks.find((b) => b.reason === 'highest-failure-rate')
    expect(failure).toBeDefined()
    expect(failure!.nodeId).toBe('flaky')
    expect(failure!.value).toBeCloseTo(1 / 3, 5)
  })

  it('getBottlenecks does not flag failure rate with fewer than 3 executions', () => {
    const fail = new Map([
      ['n1', { nodeId: 'rare', output: {}, durationMs: 10, error: 'fail' }],
    ])
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: fail }))
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults: fail }))

    const bottlenecks = analytics.getBottlenecks('p1')
    const failure = bottlenecks.find((b) => b.reason === 'highest-failure-rate')
    expect(failure).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Cost aggregation
  // -----------------------------------------------------------------------

  it('costByNodeType aggregation works', () => {
    const nodeResults = new Map([
      ['n1', { nodeId: 'llm:gen', output: { costCents: 5 }, durationMs: 100 }],
      ['n2', { nodeId: 'llm:review', output: { costCents: 3 }, durationMs: 50 }],
      ['n3', { nodeId: 'validate-check', output: { cost_cents: 1 }, durationMs: 20 }],
    ])
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults }))

    const report = analytics.getReport('p1')
    expect(report.costByNodeType['llm']).toBe(8) // 5 + 3
    expect(report.costByNodeType['validate']).toBe(1)
  })

  it('getBottlenecks returns most-expensive node', () => {
    const nodeResults = new Map([
      ['n1', { nodeId: 'cheap-step', output: { costCents: 1 }, durationMs: 10 }],
      ['n2', { nodeId: 'expensive-step', output: { costCents: 50 }, durationMs: 10 }],
    ])
    analytics.addRun(makeRun({ pipelineId: 'p1', nodeResults }))

    const bottlenecks = analytics.getBottlenecks('p1')
    const expensive = bottlenecks.find((b) => b.reason === 'most-expensive')
    expect(expensive).toBeDefined()
    expect(expensive!.nodeId).toBe('expensive-step')
    expect(expensive!.value).toBe(50)
  })

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  it('reset clears all data', () => {
    analytics.addRun(makeRun({ pipelineId: 'p1' }))
    analytics.addRun(makeRun({ pipelineId: 'p2' }))
    analytics.reset()

    expect(analytics.getReport('p1').totalRuns).toBe(0)
    expect(analytics.getReport('p2').totalRuns).toBe(0)
  })
})
