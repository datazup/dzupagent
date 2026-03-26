import { describe, it, expect, beforeEach } from 'vitest'
import { ToolStatsTracker } from '../tools/tool-stats-tracker.js'
import type { ToolCallRecord } from '../tools/tool-stats-tracker.js'

function makeRecord(
  overrides: Partial<ToolCallRecord> & { toolName: string },
): ToolCallRecord {
  return {
    success: true,
    durationMs: 100,
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('ToolStatsTracker', () => {
  let tracker: ToolStatsTracker

  beforeEach(() => {
    tracker = new ToolStatsTracker()
  })

  // ---------- Empty state ----------

  it('returns null stats for unknown tool', () => {
    expect(tracker.getStats('nonexistent')).toBeNull()
  })

  it('returns empty arrays when no records exist', () => {
    expect(tracker.getTopTools()).toEqual([])
    expect(tracker.getTrackedTools()).toEqual([])
    expect(tracker.formatAsPromptHint()).toBe('')
  })

  // ---------- Recording calls and getting stats ----------

  it('records calls and returns correct stats', () => {
    tracker.recordCall(makeRecord({ toolName: 'git_status', durationMs: 50, timestamp: 1000 }))
    tracker.recordCall(makeRecord({ toolName: 'git_status', durationMs: 150, timestamp: 2000 }))

    const stats = tracker.getStats('git_status')
    expect(stats).not.toBeNull()
    expect(stats!.toolName).toBe('git_status')
    expect(stats!.totalCalls).toBe(2)
    expect(stats!.successCount).toBe(2)
    expect(stats!.failureCount).toBe(0)
    expect(stats!.avgDurationMs).toBe(100)
    expect(stats!.lastUsed).toBe(2000)
  })

  // ---------- Success rate ----------

  it('calculates success rate correctly', () => {
    tracker.recordCall(makeRecord({ toolName: 'search', success: true }))
    tracker.recordCall(makeRecord({ toolName: 'search', success: true }))
    tracker.recordCall(makeRecord({ toolName: 'search', success: false }))
    tracker.recordCall(makeRecord({ toolName: 'search', success: false }))

    const stats = tracker.getStats('search')!
    expect(stats.successRate).toBe(0.5)
    expect(stats.successCount).toBe(2)
    expect(stats.failureCount).toBe(2)
  })

  // ---------- Duration stats (avg, p95) ----------

  it('calculates avg and p95 duration', () => {
    // 20 records: 19 at 100ms, 1 at 1000ms
    for (let i = 0; i < 19; i++) {
      tracker.recordCall(makeRecord({ toolName: 'slow', durationMs: 100 }))
    }
    tracker.recordCall(makeRecord({ toolName: 'slow', durationMs: 1000 }))

    const stats = tracker.getStats('slow')!
    expect(stats.avgDurationMs).toBe((19 * 100 + 1000) / 20)
    // p95 index = ceil(20 * 0.95) - 1 = 18 (0-indexed) => 100 (19th of 20 sorted values)
    expect(stats.p95DurationMs).toBe(100)
  })

  it('handles p95 with a single record', () => {
    tracker.recordCall(makeRecord({ toolName: 'once', durationMs: 42 }))
    const stats = tracker.getStats('once')!
    expect(stats.p95DurationMs).toBe(42)
  })

  // ---------- Top tools ranking ----------

  it('ranks tools by combined score', () => {
    // Tool A: 100% success, fast
    for (let i = 0; i < 10; i++) {
      tracker.recordCall(makeRecord({ toolName: 'fast_good', durationMs: 10 }))
    }
    // Tool B: 50% success, slow
    for (let i = 0; i < 10; i++) {
      tracker.recordCall(
        makeRecord({ toolName: 'slow_bad', success: i < 5, durationMs: 500 }),
      )
    }

    const ranking = tracker.getTopTools()
    expect(ranking.length).toBe(2)
    expect(ranking[0].toolName).toBe('fast_good')
    expect(ranking[0].score).toBeGreaterThan(ranking[1].score)
    expect(ranking[0].successRate).toBe(1)
    expect(ranking[1].successRate).toBe(0.5)
  })

  it('respects limit parameter', () => {
    tracker.recordCall(makeRecord({ toolName: 'a' }))
    tracker.recordCall(makeRecord({ toolName: 'b' }))
    tracker.recordCall(makeRecord({ toolName: 'c' }))

    const top = tracker.getTopTools(2)
    expect(top.length).toBe(2)
  })

  // ---------- Intent-filtered ranking ----------

  it('filters ranking by intent', () => {
    tracker.recordCall(makeRecord({ toolName: 'search', intent: 'debug', durationMs: 50 }))
    tracker.recordCall(makeRecord({ toolName: 'search', intent: 'debug', durationMs: 50 }))
    tracker.recordCall(makeRecord({ toolName: 'search', intent: 'codegen', durationMs: 200 }))
    tracker.recordCall(makeRecord({ toolName: 'compile', intent: 'codegen', durationMs: 100 }))

    const debugRanking = tracker.getTopTools(10, 'debug')
    expect(debugRanking.length).toBe(1)
    expect(debugRanking[0].toolName).toBe('search')
    expect(debugRanking[0].callCount).toBe(2)

    const codegenRanking = tracker.getTopTools(10, 'codegen')
    expect(codegenRanking.length).toBe(2)
    // compile should rank higher (faster + same success rate)
    expect(codegenRanking[0].toolName).toBe('compile')
  })

  it('returns empty ranking for unknown intent', () => {
    tracker.recordCall(makeRecord({ toolName: 'x', intent: 'a' }))
    expect(tracker.getTopTools(10, 'nonexistent')).toEqual([])
  })

  // ---------- Sliding window eviction ----------

  it('evicts old records when window size exceeded', () => {
    const smallTracker = new ToolStatsTracker({ windowSize: 5 })

    for (let i = 0; i < 10; i++) {
      smallTracker.recordCall(
        makeRecord({
          toolName: 'evict_test',
          durationMs: i < 5 ? 1000 : 10,
          timestamp: i,
        }),
      )
    }

    const stats = smallTracker.getStats('evict_test')!
    // Only last 5 records (durationMs=10) should remain
    expect(stats.totalCalls).toBe(5)
    expect(stats.avgDurationMs).toBe(10)
    // Oldest surviving timestamp should be 5
    expect(stats.lastUsed).toBe(9)
  })

  // ---------- formatAsPromptHint ----------

  it('formats prompt hint correctly', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordCall(makeRecord({ toolName: 'git_diff', success: i < 9 }))
    }
    for (let i = 0; i < 10; i++) {
      tracker.recordCall(makeRecord({ toolName: 'file_read', success: i < 8 }))
    }

    const hint = tracker.formatAsPromptHint(2)
    expect(hint).toContain('Preferred tools for this task:')
    expect(hint).toContain('git_diff (90% success)')
    expect(hint).toContain('file_read (80% success)')
    // Should have numbered list
    expect(hint).toMatch(/^Preferred tools for this task:\n1\. .+\n2\. .+$/)
  })

  it('returns empty string when no tools tracked', () => {
    expect(tracker.formatAsPromptHint()).toBe('')
  })

  // ---------- Error type tracking ----------

  it('tracks error types and returns top errors', () => {
    tracker.recordCall(makeRecord({ toolName: 'api', success: false, errorType: 'TIMEOUT' }))
    tracker.recordCall(makeRecord({ toolName: 'api', success: false, errorType: 'TIMEOUT' }))
    tracker.recordCall(makeRecord({ toolName: 'api', success: false, errorType: 'TIMEOUT' }))
    tracker.recordCall(makeRecord({ toolName: 'api', success: false, errorType: 'AUTH' }))
    tracker.recordCall(makeRecord({ toolName: 'api', success: true }))

    const stats = tracker.getStats('api')!
    expect(stats.topErrors).toEqual([
      { type: 'TIMEOUT', count: 3 },
      { type: 'AUTH', count: 1 },
    ])
  })

  it('ignores errorType on successful calls', () => {
    // Even if errorType is set, success=true means it should not appear in topErrors
    tracker.recordCall(
      makeRecord({ toolName: 'odd', success: true, errorType: 'SPURIOUS' }),
    )
    const stats = tracker.getStats('odd')!
    expect(stats.topErrors).toEqual([])
  })

  it('handles failures without errorType', () => {
    tracker.recordCall(makeRecord({ toolName: 'bare', success: false }))
    const stats = tracker.getStats('bare')!
    expect(stats.failureCount).toBe(1)
    expect(stats.topErrors).toEqual([])
  })

  // ---------- Reset ----------

  it('clears everything on reset', () => {
    tracker.recordCall(makeRecord({ toolName: 'a' }))
    tracker.recordCall(makeRecord({ toolName: 'b' }))
    expect(tracker.getTrackedTools().length).toBe(2)

    tracker.reset()

    expect(tracker.getTrackedTools()).toEqual([])
    expect(tracker.getStats('a')).toBeNull()
    expect(tracker.getTopTools()).toEqual([])
  })

  // ---------- getTrackedTools ----------

  it('returns all tracked tool names', () => {
    tracker.recordCall(makeRecord({ toolName: 'alpha' }))
    tracker.recordCall(makeRecord({ toolName: 'beta' }))
    tracker.recordCall(makeRecord({ toolName: 'alpha' }))

    const tools = tracker.getTrackedTools()
    expect(tools).toHaveLength(2)
    expect(tools).toContain('alpha')
    expect(tools).toContain('beta')
  })

  // ---------- Custom config ----------

  it('respects custom scoring weights', () => {
    // With successWeight=0, latencyWeight=1 => only speed matters
    const speedTracker = new ToolStatsTracker({
      successWeight: 0,
      latencyWeight: 1,
    })

    // Tool A: 100% success but slow
    for (let i = 0; i < 5; i++) {
      speedTracker.recordCall(makeRecord({ toolName: 'slow_perfect', durationMs: 500 }))
    }
    // Tool B: 50% success but fast
    for (let i = 0; i < 5; i++) {
      speedTracker.recordCall(
        makeRecord({ toolName: 'fast_flaky', success: i < 3, durationMs: 10 }),
      )
    }

    const ranking = speedTracker.getTopTools()
    // fast_flaky should rank first because only speed matters
    expect(ranking[0].toolName).toBe('fast_flaky')
  })

  // ---------- Edge: single tool normalizedSpeed ----------

  it('handles single tool (normalizedSpeed = 0 since avg/max = 1)', () => {
    tracker.recordCall(makeRecord({ toolName: 'only', durationMs: 100 }))
    const ranking = tracker.getTopTools()
    expect(ranking).toHaveLength(1)
    // normalizedSpeed = 1 - (100/100) = 0, score = 1*0.7 + 0*0.3 = 0.7
    expect(ranking[0].score).toBeCloseTo(0.7)
    expect(ranking[0].successRate).toBe(1)
  })
})
