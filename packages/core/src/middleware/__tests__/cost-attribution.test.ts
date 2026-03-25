import { describe, it, expect, beforeEach } from 'vitest'
import { CostAttributionCollector } from '../cost-attribution.js'
import type { CostAttribution } from '../cost-attribution.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CostAttribution> = {}): CostAttribution {
  return {
    agentId: 'agent-1',
    model: 'claude-sonnet-4-6',
    costCents: 10,
    tokens: { input: 100, output: 50, total: 150 },
    timestamp: new Date('2026-03-25T00:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CostAttributionCollector', () => {
  let collector: CostAttributionCollector

  beforeEach(() => {
    collector = new CostAttributionCollector()
  })

  it('record() stores an entry', () => {
    const entry = makeEntry()
    collector.record(entry)
    const report = collector.getReport()
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]!.agentId).toBe('agent-1')
  })

  it('getReport() aggregates by agent', () => {
    collector.record(makeEntry({ agentId: 'agent-a', costCents: 5, tokens: { input: 10, output: 10, total: 20 } }))
    collector.record(makeEntry({ agentId: 'agent-a', costCents: 15, tokens: { input: 30, output: 20, total: 50 } }))
    collector.record(makeEntry({ agentId: 'agent-b', costCents: 7, tokens: { input: 20, output: 10, total: 30 } }))

    const report = collector.getReport()
    expect(report.byAgent['agent-a']).toEqual({ costCents: 20, tokens: 70, calls: 2 })
    expect(report.byAgent['agent-b']).toEqual({ costCents: 7, tokens: 30, calls: 1 })
  })

  it('getReport() aggregates by tool', () => {
    collector.record(makeEntry({ toolName: 'git_status', costCents: 3, tokens: { input: 5, output: 5, total: 10 } }))
    collector.record(makeEntry({ toolName: 'git_status', costCents: 4, tokens: { input: 6, output: 6, total: 12 } }))
    collector.record(makeEntry({ toolName: 'edit_file', costCents: 8, tokens: { input: 20, output: 10, total: 30 } }))
    collector.record(makeEntry()) // no toolName — should not appear in byTool

    const report = collector.getReport()
    expect(report.byTool['git_status']).toEqual({ costCents: 7, tokens: 22, calls: 2 })
    expect(report.byTool['edit_file']).toEqual({ costCents: 8, tokens: 30, calls: 1 })
    expect(Object.keys(report.byTool)).toHaveLength(2)
  })

  it('getReport() aggregates by run', () => {
    collector.record(makeEntry({ runId: 'run-1', costCents: 10, tokens: { input: 50, output: 50, total: 100 } }))
    collector.record(makeEntry({ runId: 'run-1', costCents: 5, tokens: { input: 20, output: 10, total: 30 } }))
    collector.record(makeEntry({ runId: 'run-2', costCents: 20, tokens: { input: 100, output: 100, total: 200 } }))

    const report = collector.getReport()
    expect(report.byRun['run-1']).toEqual({ costCents: 15, tokens: 130, calls: 2 })
    expect(report.byRun['run-2']).toEqual({ costCents: 20, tokens: 200, calls: 1 })
  })

  it('getReport() aggregates by model', () => {
    collector.record(makeEntry({ model: 'claude-sonnet-4-6', costCents: 10, tokens: { input: 50, output: 50, total: 100 } }))
    collector.record(makeEntry({ model: 'claude-haiku-4-5-20251001', costCents: 2, tokens: { input: 80, output: 40, total: 120 } }))
    collector.record(makeEntry({ model: 'claude-sonnet-4-6', costCents: 12, tokens: { input: 60, output: 60, total: 120 } }))

    const report = collector.getReport()
    expect(report.byModel['claude-sonnet-4-6']).toEqual({ costCents: 22, tokens: 220, calls: 2 })
    expect(report.byModel['claude-haiku-4-5-20251001']).toEqual({ costCents: 2, tokens: 120, calls: 1 })
  })

  it('getReport() totals are correct', () => {
    collector.record(makeEntry({ costCents: 10, tokens: { input: 50, output: 50, total: 100 } }))
    collector.record(makeEntry({ costCents: 20, tokens: { input: 100, output: 100, total: 200 } }))
    collector.record(makeEntry({ costCents: 5, tokens: { input: 30, output: 20, total: 50 } }))

    const report = collector.getReport()
    expect(report.totalCostCents).toBe(35)
    expect(report.totalTokens).toBe(350)
    expect(report.entries).toHaveLength(3)
  })

  it('getAgentCost() returns cost for a specific agent', () => {
    collector.record(makeEntry({ agentId: 'planner', costCents: 12 }))
    collector.record(makeEntry({ agentId: 'coder', costCents: 30 }))
    collector.record(makeEntry({ agentId: 'planner', costCents: 8 }))

    expect(collector.getAgentCost('planner')).toBe(20)
    expect(collector.getAgentCost('coder')).toBe(30)
    expect(collector.getAgentCost('unknown-agent')).toBe(0)
  })

  it('getRunCost() returns cost for a specific run', () => {
    collector.record(makeEntry({ runId: 'run-abc', costCents: 15 }))
    collector.record(makeEntry({ runId: 'run-def', costCents: 25 }))
    collector.record(makeEntry({ runId: 'run-abc', costCents: 5 }))

    expect(collector.getRunCost('run-abc')).toBe(20)
    expect(collector.getRunCost('run-def')).toBe(25)
    expect(collector.getRunCost('run-nonexistent')).toBe(0)
  })

  it('reset() clears all data', () => {
    collector.record(makeEntry())
    collector.record(makeEntry())
    expect(collector.getReport().entries).toHaveLength(2)

    collector.reset()

    const report = collector.getReport()
    expect(report.entries).toHaveLength(0)
    expect(report.totalCostCents).toBe(0)
    expect(report.totalTokens).toBe(0)
    expect(Object.keys(report.byAgent)).toHaveLength(0)
  })

  it('setContext() affects subsequent records via auto-tagging', () => {
    collector.setContext({ agentId: 'ctx-agent', runId: 'ctx-run', toolName: 'ctx-tool' })

    // Record an entry without explicit agentId — should use context
    collector.record({
      agentId: '', // falsy, so context kicks in
      model: 'gpt-5-mini',
      costCents: 3,
      tokens: { input: 10, output: 5, total: 15 },
      timestamp: new Date(),
    })

    const report = collector.getReport()
    const entry = report.entries[0]!
    expect(entry.agentId).toBe('ctx-agent')
    expect(entry.runId).toBe('ctx-run')
    expect(entry.toolName).toBe('ctx-tool')
  })

  it('setContext() does not override explicit entry values', () => {
    collector.setContext({ agentId: 'ctx-agent', runId: 'ctx-run' })

    collector.record(makeEntry({ agentId: 'explicit-agent', runId: 'explicit-run' }))

    const report = collector.getReport()
    const entry = report.entries[0]!
    expect(entry.agentId).toBe('explicit-agent')
    expect(entry.runId).toBe('explicit-run')
  })

  it('tracks multiple agents, tools, and runs simultaneously', () => {
    collector.record(makeEntry({ agentId: 'a1', toolName: 't1', runId: 'r1', costCents: 10, tokens: { input: 50, output: 50, total: 100 } }))
    collector.record(makeEntry({ agentId: 'a2', toolName: 't2', runId: 'r1', costCents: 20, tokens: { input: 80, output: 80, total: 160 } }))
    collector.record(makeEntry({ agentId: 'a1', toolName: 't2', runId: 'r2', costCents: 15, tokens: { input: 60, output: 40, total: 100 } }))
    collector.record(makeEntry({ agentId: 'a2', toolName: 't1', runId: 'r2', costCents: 5, tokens: { input: 20, output: 10, total: 30 } }))

    const report = collector.getReport()

    // Totals
    expect(report.totalCostCents).toBe(50)
    expect(report.totalTokens).toBe(390)

    // By agent
    expect(report.byAgent['a1']!.costCents).toBe(25)
    expect(report.byAgent['a2']!.costCents).toBe(25)
    expect(report.byAgent['a1']!.calls).toBe(2)
    expect(report.byAgent['a2']!.calls).toBe(2)

    // By tool
    expect(report.byTool['t1']!.costCents).toBe(15)
    expect(report.byTool['t2']!.costCents).toBe(35)

    // By run
    expect(report.byRun['r1']!.costCents).toBe(30)
    expect(report.byRun['r2']!.costCents).toBe(20)
  })

  it('constructor config sets initial context', () => {
    const configured = new CostAttributionCollector({ agentId: 'init-agent', runId: 'init-run' })

    configured.record({
      agentId: '', // falsy — context applies
      model: 'claude-sonnet-4-6',
      costCents: 1,
      tokens: { input: 1, output: 1, total: 2 },
      timestamp: new Date(),
    })

    const entry = configured.getReport().entries[0]!
    expect(entry.agentId).toBe('init-agent')
    expect(entry.runId).toBe('init-run')
  })

  it('entries without runId or toolName are excluded from those buckets', () => {
    collector.record(makeEntry({ agentId: 'a1', costCents: 10, tokens: { input: 50, output: 50, total: 100 } }))

    const report = collector.getReport()
    expect(Object.keys(report.byRun)).toHaveLength(0)
    expect(Object.keys(report.byTool)).toHaveLength(0)
    expect(Object.keys(report.byAgent)).toHaveLength(1)
    expect(Object.keys(report.byModel)).toHaveLength(1)
  })
})
