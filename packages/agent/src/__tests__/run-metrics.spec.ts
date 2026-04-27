import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import {
  RunMetricsAggregator,
  attachRunMetricsBridge,
} from '../observability/index.js'

describe('RunMetricsAggregator', () => {
  it('recordStart then recordComplete updates status, duration, tokens, and cost', () => {
    let now = 1_000
    const agg = new RunMetricsAggregator({ now: () => now })
    agg.recordStart('r1', 'openai')
    now = 1_500
    agg.recordComplete('r1', { input: 100, output: 50, cached: 10 }, 250_000)
    const row = agg.getRunMetrics('r1')
    expect(row).toBeDefined()
    expect(row?.status).toBe('completed')
    expect(row?.durationMs).toBe(500)
    expect(row?.tokenUsage).toEqual({ input: 100, output: 50, cached: 10 })
    expect(row?.costMicros).toBe(250_000)
    expect(row?.completedAt).toBe(1_500)
  })

  it('successRate calculation: 1 of 2 failed yields 0.5', () => {
    let now = 1_000
    const agg = new RunMetricsAggregator({ now: () => now })
    agg.recordStart('a', 'openai')
    agg.recordStart('b', 'openai')
    now = 1_100
    agg.recordComplete('a', { input: 0, output: 0, cached: 0 }, 0)
    now = 1_200
    agg.recordFailure('b')
    const m = agg.getAggregated()
    expect(m.totalRuns).toBe(2)
    expect(m.completedRuns).toBe(1)
    expect(m.failedRuns).toBe(1)
    expect(m.successRate).toBe(0.5)
  })

  it('byProvider breakdown rolls up successRate and avgCost per provider', () => {
    let now = 1_000
    const agg = new RunMetricsAggregator({ now: () => now })
    agg.recordStart('o1', 'openai')
    agg.recordStart('o2', 'openai')
    agg.recordStart('a1', 'anthropic')
    now = 2_000
    agg.recordComplete('o1', { input: 0, output: 0, cached: 0 }, 100_000)
    agg.recordFailure('o2')
    agg.recordComplete('a1', { input: 0, output: 0, cached: 0 }, 200_000)
    const m = agg.getAggregated()
    expect(m.byProvider.openai).toEqual({
      runs: 2,
      successRate: 0.5,
      avgCostMicros: 50_000,
    })
    expect(m.byProvider.anthropic).toEqual({
      runs: 1,
      successRate: 1,
      avgCostMicros: 200_000,
    })
  })

  it('filter.providerId restricts aggregation to a single provider', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('o1', 'openai')
    agg.recordStart('a1', 'anthropic')
    agg.recordComplete('o1', { input: 0, output: 0, cached: 0 }, 100_000)
    agg.recordComplete('a1', { input: 0, output: 0, cached: 0 }, 50_000)
    const m = agg.getAggregated({ providerId: 'openai' })
    expect(m.totalRuns).toBe(1)
    expect(m.totalCostMicros).toBe(100_000)
    expect(Object.keys(m.byProvider)).toEqual(['openai'])
  })

  it('filter.since excludes older runs', () => {
    let now = 1_000
    const agg = new RunMetricsAggregator({ now: () => now })
    agg.recordStart('old', 'openai')
    now = 5_000
    agg.recordStart('new', 'openai')
    const m = agg.getAggregated({ since: 4_000 })
    expect(m.totalRuns).toBe(1)
    const row = agg.getRunMetrics('new')
    expect(row?.startedAt).toBe(5_000)
  })

  it('evict removes runs older than the retention window', () => {
    let now = 0
    const agg = new RunMetricsAggregator({ now: () => now })
    now = 1_000
    agg.recordStart('old', 'openai')
    now = 100_000
    agg.recordStart('new', 'openai')
    now = 200_000
    const removed = agg.evict(150_000)
    expect(removed).toBe(1)
    expect(agg.getRunMetrics('old')).toBeUndefined()
    expect(agg.getRunMetrics('new')).toBeDefined()
  })

  it('getRunMetrics returns undefined for unknown runId', () => {
    const agg = new RunMetricsAggregator()
    expect(agg.getRunMetrics('does-not-exist')).toBeUndefined()
  })

  it('recordToolCall increments counter and is no-op for unknown run', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('r', 'openai')
    agg.recordToolCall('r')
    agg.recordToolCall('r')
    agg.recordToolCall('missing')
    expect(agg.getRunMetrics('r')?.toolCallCount).toBe(2)
  })

  it('aggregated avgDurationMs is null when no terminal runs exist', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('r', 'openai')
    const m = agg.getAggregated()
    expect(m.avgDurationMs).toBeNull()
    expect(m.successRate).toBe(0)
  })

  it('totalTokens sums input/output/cached across runs', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('a', 'openai')
    agg.recordStart('b', 'openai')
    agg.recordComplete('a', { input: 10, output: 20, cached: 5 }, 0)
    agg.recordComplete('b', { input: 1, output: 2, cached: 3 }, 0)
    const m = agg.getAggregated()
    expect(m.totalTokens).toBe(10 + 20 + 5 + 1 + 2 + 3)
  })

  it('returned row is a defensive clone — mutating it does not affect store', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('r', 'openai')
    const row = agg.getRunMetrics('r')
    if (!row) throw new Error('row missing')
    row.toolCallCount = 999
    row.tokenUsage.input = 999
    expect(agg.getRunMetrics('r')?.toolCallCount).toBe(0)
    expect(agg.getRunMetrics('r')?.tokenUsage.input).toBe(0)
  })
})

describe('attachRunMetricsBridge', () => {
  it('feeds aggregator from agent + tool + llm bus events', async () => {
    const bus = createEventBus()
    const agg = new RunMetricsAggregator()
    const detach = attachRunMetricsBridge(bus, agg)

    bus.emit({ type: 'agent:started', agentId: 'openai', runId: 'r1' })
    bus.emit({
      type: 'llm:invoked',
      agentId: 'openai',
      runId: 'r1',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costCents: 5,
      timestamp: Date.now(),
    })
    bus.emit({ type: 'tool:called', toolName: 't', input: {}, runId: 'r1' })
    bus.emit({ type: 'tool:called', toolName: 't', input: {}, runId: 'r1' })
    bus.emit({ type: 'agent:completed', agentId: 'openai', runId: 'r1', durationMs: 42 })

    // Allow microtask handlers to flush.
    await Promise.resolve()

    const row = agg.getRunMetrics('r1')
    expect(row?.status).toBe('completed')
    expect(row?.toolCallCount).toBe(2)
    expect(row?.tokenUsage).toEqual({ input: 100, output: 50, cached: 0 })
    // 5 cents = 50_000 micros
    expect(row?.costMicros).toBe(50_000)

    detach()
    // After detach, further events must not mutate state.
    bus.emit({ type: 'tool:called', toolName: 't', input: {}, runId: 'r1' })
    await Promise.resolve()
    expect(agg.getRunMetrics('r1')?.toolCallCount).toBe(2)
  })

  it('increments checkpointCount when checkpoint:created fires on the bus', async () => {
    const bus = createEventBus()
    const agg = new RunMetricsAggregator()
    attachRunMetricsBridge(bus, agg)

    bus.emit({ type: 'agent:started', agentId: 'openai', runId: 'r-cp' })
    bus.emit({
      type: 'checkpoint:created',
      runId: 'r-cp',
      nodeId: 'n1',
      label: 'before-deploy',
      checkpointAt: new Date().toISOString(),
    })
    bus.emit({
      type: 'checkpoint:created',
      runId: 'r-cp',
      nodeId: 'n2',
      label: 'after-tests',
      checkpointAt: new Date().toISOString(),
    })
    await Promise.resolve()

    const row = agg.getRunMetrics('r-cp')
    expect(row).toBeDefined()
    expect(row?.checkpointCount).toBe(2)
  })

  it('getRunMetrics returns checkpointCount in the row snapshot', () => {
    const agg = new RunMetricsAggregator({ now: () => 1_000 })
    agg.recordStart('r1', 'openai')
    agg.recordCheckpoint('r1', 'first')
    const row = agg.getRunMetrics('r1')
    expect(row?.checkpointCount).toBe(1)
    // Defensive-clone parity: mutating the returned snapshot must not affect store.
    if (row) {
      row.checkpointCount = 999
    }
    expect(agg.getRunMetrics('r1')?.checkpointCount).toBe(1)
  })

  it('checkpoint:restored does NOT increment checkpointCount', async () => {
    const bus = createEventBus()
    const agg = new RunMetricsAggregator()
    attachRunMetricsBridge(bus, agg)

    bus.emit({ type: 'agent:started', agentId: 'openai', runId: 'r-restore' })
    bus.emit({
      type: 'checkpoint:restored',
      runId: 'r-restore',
      checkpointLabel: 'before-deploy',
      restored: false,
      reason: 'checkpoint_not_found',
    })
    await Promise.resolve()

    const row = agg.getRunMetrics('r-restore')
    expect(row).toBeDefined()
    expect(row?.checkpointCount).toBe(0)
  })

  it('records failures via agent:failed', async () => {
    const bus = createEventBus()
    const agg = new RunMetricsAggregator()
    attachRunMetricsBridge(bus, agg)
    bus.emit({ type: 'agent:started', agentId: 'p', runId: 'r' })
    bus.emit({
      type: 'agent:failed',
      agentId: 'p',
      runId: 'r',
      errorCode: 'TOOL_EXECUTION_FAILED',
      message: 'boom',
    })
    await Promise.resolve()
    const row = agg.getRunMetrics('r')
    expect(row?.status).toBe('failed')
    expect(row?.errorCount).toBe(1)
  })
})
