/**
 * Tests for ToolStatsTab component and tool-stats-store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ToolStatsTab from '../components/inspector/ToolStatsTab.vue'
import { useToolStatsStore } from '../stores/tool-stats-store.js'
import type { ToolStatEntry } from '../stores/tool-stats-store.js'

function makeStat(overrides: Partial<ToolStatEntry> = {}): ToolStatEntry {
  return {
    toolName: 'search',
    totalCalls: 10,
    successRate: 0.9,
    avgDurationMs: 45,
    p95DurationMs: 120,
    score: 0.85,
    topErrors: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe('tool-stats-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with empty stats', () => {
    const store = useToolStatsStore()
    expect(store.stats).toEqual([])
    expect(store.toolCount).toBe(0)
    expect(store.avgSuccessRate).toBe(0)
    expect(store.fastestTool).toBeNull()
  })

  it('updateFromRunMetadata populates stats from metadata', () => {
    const store = useToolStatsStore()
    const entries: ToolStatEntry[] = [
      makeStat({ toolName: 'search', totalCalls: 5 }),
      makeStat({ toolName: 'code_edit', totalCalls: 3, avgDurationMs: 200 }),
    ]

    store.updateFromRunMetadata({ toolStats: entries })

    expect(store.stats.length).toBe(2)
    expect(store.toolCount).toBe(2)
    expect(store.stats[0]?.toolName).toBe('search')
    expect(store.stats[1]?.toolName).toBe('code_edit')
  })

  it('updateFromRunMetadata ignores metadata without toolStats', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({ someOtherField: 'value' })
    expect(store.stats.length).toBe(0)
  })

  it('updateFromRunMetadata ignores non-array toolStats', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({ toolStats: 'not an array' })
    expect(store.stats.length).toBe(0)
  })

  it('sortedStats returns stats sorted by score descending', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'low', score: 0.3 }),
        makeStat({ toolName: 'high', score: 0.95 }),
        makeStat({ toolName: 'mid', score: 0.6 }),
      ],
    })

    const sorted = store.sortedStats
    expect(sorted[0]?.toolName).toBe('high')
    expect(sorted[1]?.toolName).toBe('mid')
    expect(sorted[2]?.toolName).toBe('low')
  })

  it('avgSuccessRate computes average across all tools', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ successRate: 0.8 }),
        makeStat({ successRate: 1.0 }),
      ],
    })

    expect(store.avgSuccessRate).toBe(0.9)
  })

  it('fastestTool returns tool with lowest avgDurationMs', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'slow', avgDurationMs: 500 }),
        makeStat({ toolName: 'fast', avgDurationMs: 20 }),
        makeStat({ toolName: 'medium', avgDurationMs: 100 }),
      ],
    })

    expect(store.fastestTool?.toolName).toBe('fast')
    expect(store.fastestTool?.avgDurationMs).toBe(20)
  })

  it('aggregatedErrors merges errors from all tools', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({
          toolName: 'a',
          topErrors: [
            { type: 'TIMEOUT', count: 3 },
            { type: 'RATE_LIMIT', count: 1 },
          ],
        }),
        makeStat({
          toolName: 'b',
          topErrors: [
            { type: 'TIMEOUT', count: 2 },
            { type: 'NOT_FOUND', count: 5 },
          ],
        }),
      ],
    })

    const errors = store.aggregatedErrors
    expect(errors[0]).toEqual({ type: 'TIMEOUT', count: 5 })
    expect(errors[1]).toEqual({ type: 'NOT_FOUND', count: 5 })
    expect(errors[2]).toEqual({ type: 'RATE_LIMIT', count: 1 })
  })

  it('aggregateFromRuns merges stats across multiple runs', () => {
    const store = useToolStatsStore()
    const runs = [
      {
        metadata: {
          toolStats: [
            makeStat({ toolName: 'search', totalCalls: 4, successRate: 1.0, avgDurationMs: 100, score: 0.9 }),
          ],
        },
      },
      {
        metadata: {
          toolStats: [
            makeStat({ toolName: 'search', totalCalls: 6, successRate: 0.5, avgDurationMs: 200, score: 0.6 }),
          ],
        },
      },
    ]

    store.aggregateFromRuns(runs)

    expect(store.stats.length).toBe(1)
    expect(store.stats[0]?.toolName).toBe('search')
    expect(store.stats[0]?.totalCalls).toBe(10)
    // Weighted avg: (1.0*4 + 0.5*6) / 10 = 0.7
    expect(store.stats[0]?.successRate).toBeCloseTo(0.7)
    // Weighted avg: (100*4 + 200*6) / 10 = 160
    expect(store.stats[0]?.avgDurationMs).toBeCloseTo(160)
  })

  it('aggregateFromRuns skips runs without toolStats', () => {
    const store = useToolStatsStore()
    store.aggregateFromRuns([
      { metadata: {} },
      { metadata: undefined },
      {
        metadata: {
          toolStats: [makeStat({ toolName: 'only_one', totalCalls: 2 })],
        },
      },
    ])

    expect(store.stats.length).toBe(1)
    expect(store.stats[0]?.toolName).toBe('only_one')
  })

  it('clear resets all stats', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [makeStat()],
    })
    expect(store.stats.length).toBe(1)

    store.clear()
    expect(store.stats.length).toBe(0)
    expect(store.toolCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe('ToolStatsTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders empty state when no stats', () => {
    const wrapper = mount(ToolStatsTab)
    expect(wrapper.text()).toContain('No tool stats available')
    expect(wrapper.text()).toContain('Run an agent to collect tool performance data')
  })

  it('does not render table when no stats', () => {
    const wrapper = mount(ToolStatsTab)
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('renders tool ranking table with correct data', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'file_read', totalCalls: 15, successRate: 0.95, avgDurationMs: 30, p95DurationMs: 80, score: 0.92 }),
        makeStat({ toolName: 'search', totalCalls: 8, successRate: 0.75, avgDurationMs: 150, p95DurationMs: 400, score: 0.65 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)

    expect(wrapper.text()).toContain('file_read')
    expect(wrapper.text()).toContain('search')
    expect(wrapper.text()).toContain('15')
    expect(wrapper.text()).toContain('8')
    expect(wrapper.text()).toContain('0.92')
    expect(wrapper.text()).toContain('0.65')
  })

  it('renders summary cards with correct aggregates', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'fast_tool', successRate: 0.8, avgDurationMs: 20 }),
        makeStat({ toolName: 'slow_tool', successRate: 1.0, avgDurationMs: 500 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)

    // Tool count
    expect(wrapper.text()).toContain('2')
    // Avg success rate = 90%
    expect(wrapper.text()).toContain('90%')
    // Fastest tool
    expect(wrapper.text()).toContain('fast_tool')
    expect(wrapper.text()).toContain('20ms avg')
  })

  it('success rate uses green color for >= 90%', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'good', successRate: 0.95, score: 0.9 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)
    const rateSpan = wrapper.find('tbody .font-mono.text-pg-success')
    expect(rateSpan.exists()).toBe(true)
    expect(rateSpan.text()).toBe('95%')
  })

  it('success rate uses yellow color for 70-89%', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'ok', successRate: 0.75, score: 0.7 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)
    const rateSpan = wrapper.find('tbody .font-mono.text-pg-warning')
    expect(rateSpan.exists()).toBe(true)
    expect(rateSpan.text()).toBe('75%')
  })

  it('success rate uses red color for < 70%', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'bad', successRate: 0.5, score: 0.4 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)
    const rateSpan = wrapper.find('tbody .font-mono.text-pg-error')
    expect(rateSpan.exists()).toBe(true)
    expect(rateSpan.text()).toBe('50%')
  })

  it('renders sorted by score descending', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({ toolName: 'low_score', score: 0.3 }),
        makeStat({ toolName: 'high_score', score: 0.95 }),
        makeStat({ toolName: 'mid_score', score: 0.6 }),
      ],
    })

    const wrapper = mount(ToolStatsTab)
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0]?.text()).toContain('high_score')
    expect(rows[1]?.text()).toContain('mid_score')
    expect(rows[2]?.text()).toContain('low_score')
  })

  it('renders top errors section when errors exist', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [
        makeStat({
          topErrors: [
            { type: 'TIMEOUT', count: 5 },
            { type: 'RATE_LIMIT', count: 2 },
          ],
        }),
      ],
    })

    const wrapper = mount(ToolStatsTab)
    expect(wrapper.text()).toContain('Top Errors')
    expect(wrapper.text()).toContain('TIMEOUT')
    expect(wrapper.text()).toContain('5x')
    expect(wrapper.text()).toContain('RATE_LIMIT')
    expect(wrapper.text()).toContain('2x')
  })

  it('does not render top errors section when no errors', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [makeStat({ topErrors: [] })],
    })

    const wrapper = mount(ToolStatsTab)
    expect(wrapper.text()).not.toContain('Top Errors')
  })

  it('formats latency correctly for sub-second values', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [makeStat({ avgDurationMs: 45, p95DurationMs: 120 })],
    })

    const wrapper = mount(ToolStatsTab)
    expect(wrapper.text()).toContain('45ms')
    expect(wrapper.text()).toContain('120ms')
  })

  it('formats latency correctly for second-range values', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({
      toolStats: [makeStat({ avgDurationMs: 1200, p95DurationMs: 2500 })],
    })

    const wrapper = mount(ToolStatsTab)
    expect(wrapper.text()).toContain('1.2s')
    expect(wrapper.text()).toContain('2.5s')
  })

  it('has correct ARIA attributes on table', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({ toolStats: [makeStat()] })

    const wrapper = mount(ToolStatsTab)
    const table = wrapper.find('table')
    expect(table.attributes('role')).toBe('table')
    expect(table.attributes('aria-label')).toBe('Tool performance rankings')
  })

  it('has correct ARIA attributes on summary region', () => {
    const store = useToolStatsStore()
    store.updateFromRunMetadata({ toolStats: [makeStat()] })

    const wrapper = mount(ToolStatsTab)
    const region = wrapper.find('[role="region"]')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-label')).toBe('Tool stats summary')
  })
})
