/**
 * Tests for playground/ui/utils — helper functions used by the
 * Playground UI Vue components.
 */
import { describe, it, expect } from 'vitest'
import type { TimelineNode } from '../replay/replay-types.js'
import type { NodeMetrics, ReplaySummary } from '../replay/replay-inspector.js'
import {
  getNodeStatus,
  formatMs,
  formatCost,
  barWidthPercent,
  getMaxDuration,
  getTotalDuration,
  deepEqual,
  computeDiffRows,
  getFailedNodeCount,
  getBottleneckNodes,
  getErrorEventTypes,
  formatValue,
  traceUiStyles,
  traceToneStyles,
  getTraceStatusTone,
  getTraceStatusStyles,
  getTraceChangeTone,
  getTraceChangeStyles,
} from '../playground/ui/utils.js'

// ---------------------------------------------------------------------------
// Helpers to create test data
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<TimelineNode> = {}): TimelineNode {
  return {
    index: 0,
    timestamp: 1000,
    type: 'node:completed',
    isError: false,
    durationMs: 100,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    runId: 'run-1',
    totalEvents: 10,
    totalDurationMs: 5000,
    totalTokens: 1500,
    totalCostCents: 250,
    errorCount: 1,
    recoveryCount: 0,
    nodeCount: 3,
    nodeMetrics: {},
    eventTypeCounts: {},
    ...overrides,
  }
}

function makeMetrics(overrides: Partial<NodeMetrics> = {}): NodeMetrics {
  return {
    nodeId: 'node-1',
    eventCount: 5,
    totalDurationMs: 500,
    errorCount: 0,
    retryCount: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getNodeStatus
// ---------------------------------------------------------------------------

describe('getNodeStatus', () => {
  it('returns "error" when isError is true', () => {
    expect(getNodeStatus(makeNode({ isError: true }))).toBe('error')
  })

  it('returns "success" when durationMs > 0 and not error', () => {
    expect(getNodeStatus(makeNode({ durationMs: 150 }))).toBe('success')
  })

  it('returns "running" for :started type', () => {
    expect(getNodeStatus(makeNode({ type: 'llm:started', durationMs: undefined }))).toBe('running')
  })

  it('returns "running" for type containing "running"', () => {
    expect(getNodeStatus(makeNode({ type: 'task_running', durationMs: undefined }))).toBe('running')
  })

  it('returns "pending" when no duration and not started/running', () => {
    expect(getNodeStatus(makeNode({ type: 'unknown', durationMs: undefined }))).toBe('pending')
  })

  it('error takes priority over success duration', () => {
    expect(getNodeStatus(makeNode({ isError: true, durationMs: 500 }))).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// trace UI style adapter
// ---------------------------------------------------------------------------

describe('trace UI style adapter', () => {
  it('maps node statuses to semantic trace tones', () => {
    expect(getTraceStatusTone('error')).toBe('danger')
    expect(getTraceStatusTone('success')).toBe('success')
    expect(getTraceStatusTone('running')).toBe('warning')
    expect(getTraceStatusTone('pending')).toBe('neutral')
  })

  it('returns centralized classes for node status treatments', () => {
    expect(getTraceStatusStyles('error')).toBe(traceToneStyles.danger)
    expect(getTraceStatusStyles('success')).toBe(traceToneStyles.success)
    expect(getTraceStatusStyles('running').badge).toContain('yellow')
    expect(getTraceStatusStyles('pending').bar).toBe(traceToneStyles.neutral.bar)
  })

  it('maps state diff change types to semantic trace tones', () => {
    expect(getTraceChangeTone('added')).toBe('success')
    expect(getTraceChangeTone('removed')).toBe('danger')
    expect(getTraceChangeTone('modified')).toBe('warning')
    expect(getTraceChangeTone('unchanged')).toBe('neutral')
  })

  it('centralizes shared surface, border, selected, and muted text primitives', () => {
    expect(traceUiStyles.panel).toContain('border')
    expect(traceUiStyles.selected).toContain('border-blue')
    expect(traceUiStyles.textMuted).toContain('text-gray')
    expect(getTraceChangeStyles('removed').panel).toBe(traceToneStyles.danger.panel)
  })
})

// ---------------------------------------------------------------------------
// formatMs
// ---------------------------------------------------------------------------

describe('formatMs', () => {
  it('formats sub-second durations as ms', () => {
    expect(formatMs(42)).toBe('42ms')
    expect(formatMs(999)).toBe('999ms')
  })

  it('rounds sub-second durations', () => {
    expect(formatMs(42.7)).toBe('43ms')
  })

  it('formats seconds with 2 decimal places', () => {
    expect(formatMs(1500)).toBe('1.50s')
    expect(formatMs(59999)).toBe('60.00s')
  })

  it('formats minutes for >= 60s', () => {
    expect(formatMs(60_000)).toBe('1.0m')
    expect(formatMs(150_000)).toBe('2.5m')
  })

  it('handles zero', () => {
    expect(formatMs(0)).toBe('0ms')
  })
})

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------

describe('formatCost', () => {
  it('returns "$0.00" for zero', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('formats cents to dollars with 4 decimal places', () => {
    expect(formatCost(150)).toBe('$1.5000')
    expect(formatCost(1)).toBe('$0.0100')
    expect(formatCost(0.5)).toBe('$0.0050')
  })
})

// ---------------------------------------------------------------------------
// barWidthPercent
// ---------------------------------------------------------------------------

describe('barWidthPercent', () => {
  it('returns 100% for max duration', () => {
    expect(barWidthPercent(500, 500)).toBe('100%')
  })

  it('returns proportional width', () => {
    expect(barWidthPercent(250, 500)).toBe('50%')
  })

  it('returns minimum 2% for zero duration', () => {
    expect(barWidthPercent(0, 500)).toBe('2%')
  })

  it('handles zero max by treating as 1', () => {
    expect(barWidthPercent(0, 0)).toBe('2%')
  })
})

// ---------------------------------------------------------------------------
// getMaxDuration
// ---------------------------------------------------------------------------

describe('getMaxDuration', () => {
  it('returns the maximum durationMs', () => {
    const nodes = [
      makeNode({ durationMs: 100 }),
      makeNode({ durationMs: 500 }),
      makeNode({ durationMs: 200 }),
    ]
    expect(getMaxDuration(nodes)).toBe(500)
  })

  it('falls back to latencyMs when durationMs is undefined', () => {
    const nodes = [
      makeNode({ durationMs: undefined, latencyMs: 300 }),
      makeNode({ durationMs: undefined, latencyMs: 100 }),
    ]
    expect(getMaxDuration(nodes)).toBe(300)
  })

  it('returns 1 for empty array', () => {
    expect(getMaxDuration([])).toBe(1)
  })

  it('returns 1 when all durations are zero', () => {
    const nodes = [
      makeNode({ durationMs: 0, latencyMs: 0 }),
    ]
    expect(getMaxDuration(nodes)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getTotalDuration
// ---------------------------------------------------------------------------

describe('getTotalDuration', () => {
  it('returns difference between first and last timestamps', () => {
    const nodes = [
      makeNode({ timestamp: 1000 }),
      makeNode({ timestamp: 2000 }),
      makeNode({ timestamp: 4000 }),
    ]
    expect(getTotalDuration(nodes)).toBe(3000)
  })

  it('returns 0 for single node', () => {
    expect(getTotalDuration([makeNode()])).toBe(0)
  })

  it('returns 0 for empty array', () => {
    expect(getTotalDuration([])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------

describe('deepEqual', () => {
  it('returns true for identical primitives', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('abc', 'abc')).toBe(true)
    expect(deepEqual(null, null)).toBe(true)
  })

  it('returns false for different primitives', () => {
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('a', 'b')).toBe(false)
  })

  it('compares objects deeply', () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('compares arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual([1], [2])).toBe(false)
  })

  it('handles null vs object', () => {
    expect(deepEqual(null, { a: 1 })).toBe(false)
    expect(deepEqual({ a: 1 }, null)).toBe(false)
  })

  it('uses Object.is for NaN', () => {
    expect(deepEqual(NaN, NaN)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeDiffRows
// ---------------------------------------------------------------------------

describe('computeDiffRows', () => {
  it('detects added keys', () => {
    const rows = computeDiffRows({}, { newKey: 'value' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      key: 'newKey',
      changeType: 'added',
      before: undefined,
      after: 'value',
    })
  })

  it('detects removed keys', () => {
    const rows = computeDiffRows({ oldKey: 42 }, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      key: 'oldKey',
      changeType: 'removed',
      before: 42,
      after: undefined,
    })
  })

  it('detects modified keys', () => {
    const rows = computeDiffRows({ x: 1 }, { x: 2 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      key: 'x',
      changeType: 'modified',
      before: 1,
      after: 2,
    })
  })

  it('detects unchanged keys', () => {
    const rows = computeDiffRows({ x: 1 }, { x: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.changeType).toBe('unchanged')
  })

  it('sorts changed items before unchanged', () => {
    const rows = computeDiffRows(
      { a: 1, b: 2 },
      { a: 1, b: 99, c: 3 },
    )
    expect(rows.map(r => r.changeType)).toEqual(['added', 'modified', 'unchanged'])
  })

  it('returns empty array for identical empty objects', () => {
    expect(computeDiffRows({}, {})).toHaveLength(0)
  })

  it('handles complex nested objects', () => {
    const before = { config: { a: 1, b: 2 } }
    const after = { config: { a: 1, b: 3 } }
    const rows = computeDiffRows(before, after)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.changeType).toBe('modified')
  })
})

// ---------------------------------------------------------------------------
// getFailedNodeCount
// ---------------------------------------------------------------------------

describe('getFailedNodeCount', () => {
  it('counts nodes with errorCount > 0', () => {
    const summary = makeSummary({
      nodeMetrics: {
        'node-a': makeMetrics({ nodeId: 'node-a', errorCount: 2 }),
        'node-b': makeMetrics({ nodeId: 'node-b', errorCount: 0 }),
        'node-c': makeMetrics({ nodeId: 'node-c', errorCount: 1 }),
      },
    })
    expect(getFailedNodeCount(summary)).toBe(2)
  })

  it('returns 0 when no errors', () => {
    const summary = makeSummary({
      nodeMetrics: {
        'node-a': makeMetrics({ errorCount: 0 }),
      },
    })
    expect(getFailedNodeCount(summary)).toBe(0)
  })

  it('returns 0 for empty metrics', () => {
    expect(getFailedNodeCount(makeSummary())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getBottleneckNodes
// ---------------------------------------------------------------------------

describe('getBottleneckNodes', () => {
  it('returns top 3 nodes by duration descending', () => {
    const summary = makeSummary({
      nodeMetrics: {
        a: makeMetrics({ nodeId: 'a', totalDurationMs: 100 }),
        b: makeMetrics({ nodeId: 'b', totalDurationMs: 500 }),
        c: makeMetrics({ nodeId: 'c', totalDurationMs: 300 }),
        d: makeMetrics({ nodeId: 'd', totalDurationMs: 200 }),
      },
    })
    const result = getBottleneckNodes(summary)
    expect(result).toHaveLength(3)
    expect(result[0]?.nodeId).toBe('b')
    expect(result[1]?.nodeId).toBe('c')
    expect(result[2]?.nodeId).toBe('d')
  })

  it('respects custom limit', () => {
    const summary = makeSummary({
      nodeMetrics: {
        a: makeMetrics({ nodeId: 'a', totalDurationMs: 100 }),
        b: makeMetrics({ nodeId: 'b', totalDurationMs: 500 }),
      },
    })
    expect(getBottleneckNodes(summary, 1)).toHaveLength(1)
  })

  it('excludes nodes with zero duration', () => {
    const summary = makeSummary({
      nodeMetrics: {
        a: makeMetrics({ nodeId: 'a', totalDurationMs: 0 }),
        b: makeMetrics({ nodeId: 'b', totalDurationMs: 100 }),
      },
    })
    expect(getBottleneckNodes(summary)).toHaveLength(1)
  })

  it('returns empty for no metrics', () => {
    expect(getBottleneckNodes(makeSummary())).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getErrorEventTypes
// ---------------------------------------------------------------------------

describe('getErrorEventTypes', () => {
  it('filters error-related event types', () => {
    const summary = makeSummary({
      eventTypeCounts: {
        'node:completed': 5,
        'node:failed': 2,
        'llm:error': 1,
        'task:retry': 3,
        'stuck_recovery': 1,
        'llm:started': 4,
      },
    })
    const result = getErrorEventTypes(summary)
    expect(result).toHaveLength(4)
    expect(result.map(e => e.type)).toEqual([
      'task:retry',
      'node:failed',
      'llm:error',
      'stuck_recovery',
    ])
  })

  it('sorts by count descending', () => {
    const summary = makeSummary({
      eventTypeCounts: {
        'a:failed': 1,
        'b:failed': 10,
      },
    })
    const result = getErrorEventTypes(summary)
    expect(result[0]?.count).toBe(10)
  })

  it('returns empty when no error types', () => {
    const summary = makeSummary({
      eventTypeCounts: { 'node:completed': 5 },
    })
    expect(getErrorEventTypes(summary)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

describe('formatValue', () => {
  it('formats undefined', () => {
    expect(formatValue(undefined)).toBe('undefined')
  })

  it('formats null', () => {
    expect(formatValue(null)).toBe('null')
  })

  it('returns strings as-is', () => {
    expect(formatValue('hello')).toBe('hello')
  })

  it('formats objects as pretty JSON', () => {
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('formats arrays as pretty JSON', () => {
    expect(formatValue([1, 2])).toBe('[\n  1,\n  2\n]')
  })

  it('formats numbers', () => {
    expect(formatValue(42)).toBe('42')
  })
})
