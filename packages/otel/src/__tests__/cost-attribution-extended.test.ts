import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { CostAttributor } from '../cost-attribution.js'

describe('CostAttributor extended', () => {
  let bus: ForgeEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  describe('per-model cost calculation', () => {
    it('tracks costs from multiple models via different agent IDs', () => {
      const cost = new CostAttributor()

      // Simulate different model costs
      cost.record({ agentId: 'claude-haiku', costCents: 1, tokens: 1000, timestamp: new Date() })
      cost.record({ agentId: 'claude-sonnet', costCents: 15, tokens: 1000, timestamp: new Date() })
      cost.record({ agentId: 'claude-haiku', costCents: 2, tokens: 2000, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byAgent['claude-haiku']).toEqual({ costCents: 3, tokens: 3000 })
      expect(report.byAgent['claude-sonnet']).toEqual({ costCents: 15, tokens: 1000 })
      expect(report.totalCostCents).toBe(18)
      expect(report.totalTokens).toBe(4000)
    })
  })

  describe('per-run cost aggregation', () => {
    it('aggregates costs across phases within a run', () => {
      const cost = new CostAttributor()

      cost.record({ agentId: 'a1', phase: 'plan', costCents: 5, tokens: 500, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'gen_backend', costCents: 20, tokens: 2000, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'gen_frontend', costCents: 15, tokens: 1500, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'gen_backend', costCents: 10, tokens: 1000, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byPhase['plan']).toEqual({ costCents: 5, tokens: 500 })
      expect(report.byPhase['gen_backend']).toEqual({ costCents: 30, tokens: 3000 })
      expect(report.byPhase['gen_frontend']).toEqual({ costCents: 15, tokens: 1500 })
    })
  })

  describe('custom warning ratio', () => {
    it('emits warning at custom ratio', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 100, warningRatio: 0.5 },
        eventBus: bus,
      })

      // 49% -- no warning
      cost.record({ agentId: 'a1', costCents: 49, tokens: 0, timestamp: new Date() })
      expect(warnings).toHaveLength(0)

      // 50% -- triggers warning
      cost.record({ agentId: 'a1', costCents: 1, tokens: 0, timestamp: new Date() })
      expect(warnings).toHaveLength(1)
    })

    it('does not emit warning if exceeded is emitted first', () => {
      const warnings: unknown[] = []
      const exceeded: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      // Jump straight to 100% -- exceeded should fire, not warning
      cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })
      expect(exceeded).toHaveLength(1)
      // Warning should NOT fire since exceeded already fired
      expect(warnings).toHaveLength(0)
    })
  })

  describe('token threshold warnings', () => {
    it('emits warning at 80% of maxTokens', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      const cost = new CostAttributor({
        thresholds: { maxTokens: 10000 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 0, tokens: 8000, timestamp: new Date() })
      expect(warnings).toHaveLength(1)
    })

    it('does not emit warning below 80% of maxTokens', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      const cost = new CostAttributor({
        thresholds: { maxTokens: 10000 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 0, tokens: 7999, timestamp: new Date() })
      expect(warnings).toHaveLength(0)
    })
  })

  describe('threshold checks without event bus', () => {
    it('does not throw when no event bus is attached', () => {
      const cost = new CostAttributor({
        thresholds: { maxCostCents: 10 },
      })

      // Should not throw even at 100%
      expect(() => {
        cost.record({ agentId: 'a1', costCents: 20, tokens: 0, timestamp: new Date() })
      }).not.toThrow()
    })
  })

  describe('entries without phase or tool', () => {
    it('entries without phase do not add to byPhase', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(Object.keys(report.byPhase)).toHaveLength(0)
    })

    it('entries without toolName do not add to byTool', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(Object.keys(report.byTool)).toHaveLength(0)
    })
  })

  describe('event bus integration', () => {
    it('records entries on tool:result events with current phase', () => {
      const cost = new CostAttributor({ eventBus: bus })

      // Set phase via pipeline event
      bus.emit({ type: 'pipeline:phase_changed', phase: 'gen_db', previousPhase: 'plan' })

      // Trigger tool:result
      bus.emit({ type: 'tool:result', toolName: 'write_file', durationMs: 50 })

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(1)
      expect(report.entries[0]!.toolName).toBe('write_file')
    })

    it('records entries on agent:completed events', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'agent:completed', agentId: 'code-gen', runId: 'r1', durationMs: 1000 })

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(1)
      expect(report.byAgent['code-gen']).toBeDefined()
    })
  })

  describe('getCostReport returns copies', () => {
    it('entries array is a copy', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })

      const report1 = cost.getCostReport()
      const report2 = cost.getCostReport()
      expect(report1.entries).not.toBe(report2.entries)
      expect(report1.entries).toEqual(report2.entries)
    })
  })

  describe('_buildUsage output', () => {
    it('includes percent calculation in budget:exceeded event', () => {
      const exceeded: Array<{ usage: { percent: number; tokensUsed: number } }> = []
      bus.on('budget:exceeded', (e) => exceeded.push(e as typeof exceeded[0]))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 50 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 75, tokens: 500, timestamp: new Date() })

      expect(exceeded).toHaveLength(1)
      expect(exceeded[0]!.usage.percent).toBe(150) // 75/50 = 150%
    })

    it('includes token usage in budget:warning event', () => {
      const warnings: Array<{ usage: { tokensUsed: number; tokensLimit: number } }> = []
      bus.on('budget:warning', (e) => warnings.push(e as typeof warnings[0]))

      const cost = new CostAttributor({
        thresholds: { maxTokens: 1000 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 0, tokens: 800, timestamp: new Date() })

      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.usage.tokensUsed).toBe(800)
      expect(warnings[0]!.usage.tokensLimit).toBe(1000)
    })
  })

  describe('zero and negative thresholds', () => {
    it('does not emit events for maxCostCents of 0', () => {
      const events: unknown[] = []
      bus.on('budget:exceeded', (e) => events.push(e))
      bus.on('budget:warning', (e) => events.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 0 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })
      expect(events).toHaveLength(0)
    })

    it('does not emit events for maxTokens of 0', () => {
      const events: unknown[] = []
      bus.on('budget:exceeded', (e) => events.push(e))
      bus.on('budget:warning', (e) => events.push(e))

      const cost = new CostAttributor({
        thresholds: { maxTokens: 0 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 0, tokens: 5000, timestamp: new Date() })
      expect(events).toHaveLength(0)
    })
  })
})
