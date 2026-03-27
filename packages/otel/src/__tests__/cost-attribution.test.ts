import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'
import { CostAttributor } from '../cost-attribution.js'
import type { CostEntry } from '../cost-attribution.js'

describe('CostAttributor', () => {
  let bus: DzipEventBus
  let cost: CostAttributor

  beforeEach(() => {
    bus = createEventBus()
  })

  describe('record()', () => {
    it('adds a cost entry', () => {
      cost = new CostAttributor()
      const entry: CostEntry = {
        agentId: 'agent-1',
        phase: 'plan',
        toolName: 'read_file',
        costCents: 10,
        tokens: 500,
        timestamp: new Date(),
      }

      cost.record(entry)

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(1)
      expect(report.entries[0]).toEqual(entry)
    })

    it('accumulates multiple entries', () => {
      cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 20, tokens: 200, timestamp: new Date() })
      cost.record({ agentId: 'a2', costCents: 5, tokens: 50, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(35)
      expect(report.totalTokens).toBe(350)
      expect(report.entries).toHaveLength(3)
    })
  })

  describe('getCostReport()', () => {
    it('aggregates by agent', () => {
      cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 20, tokens: 200, timestamp: new Date() })
      cost.record({ agentId: 'a2', costCents: 5, tokens: 50, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byAgent['a1']).toEqual({ costCents: 30, tokens: 300 })
      expect(report.byAgent['a2']).toEqual({ costCents: 5, tokens: 50 })
    })

    it('aggregates by phase', () => {
      cost = new CostAttributor()
      cost.record({ agentId: 'a1', phase: 'plan', costCents: 10, tokens: 100, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'plan', costCents: 5, tokens: 50, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'gen', costCents: 20, tokens: 200, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byPhase['plan']).toEqual({ costCents: 15, tokens: 150 })
      expect(report.byPhase['gen']).toEqual({ costCents: 20, tokens: 200 })
    })

    it('aggregates by tool', () => {
      cost = new CostAttributor()
      cost.record({ agentId: 'a1', toolName: 'read_file', costCents: 10, tokens: 100, timestamp: new Date() })
      cost.record({ agentId: 'a1', toolName: 'read_file', costCents: 5, tokens: 50, timestamp: new Date() })
      cost.record({ agentId: 'a1', toolName: 'write_file', costCents: 20, tokens: 200, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byTool['read_file']).toEqual({ costCents: 15, tokens: 150 })
      expect(report.byTool['write_file']).toEqual({ costCents: 20, tokens: 200 })
    })

    it('returns empty report when no entries', () => {
      cost = new CostAttributor()
      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(0)
      expect(report.totalTokens).toBe(0)
      expect(report.entries).toHaveLength(0)
      expect(Object.keys(report.byAgent)).toHaveLength(0)
    })
  })

  describe('threshold warning at 80%', () => {
    it('emits budget:warning when cost reaches 80% of max', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      // Record 80 cents — should trigger warning
      cost.record({ agentId: 'a1', costCents: 80, tokens: 0, timestamp: new Date() })

      expect(warnings).toHaveLength(1)
    })

    it('does not emit warning below 80%', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 79, tokens: 0, timestamp: new Date() })

      expect(warnings).toHaveLength(0)
    })
  })

  describe('threshold exceeded at 100%', () => {
    it('emits budget:exceeded when cost reaches 100% of max', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      // Go straight to 100
      cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })

      expect(exceeded).toHaveLength(1)
    })

    it('emits budget:exceeded for token threshold', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      cost = new CostAttributor({
        thresholds: { maxTokens: 1000 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 0, tokens: 1000, timestamp: new Date() })

      expect(exceeded).toHaveLength(1)
    })

    it('only emits exceeded once', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 50, tokens: 0, timestamp: new Date() })

      expect(exceeded).toHaveLength(1)
    })
  })

  describe('reset()', () => {
    it('clears all data', () => {
      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 50, tokens: 500, timestamp: new Date() })
      cost.reset()

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(0)
      expect(report.totalTokens).toBe(0)
      expect(report.entries).toHaveLength(0)
      expect(Object.keys(report.byAgent)).toHaveLength(0)
    })

    it('allows threshold events to fire again after reset', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 80, tokens: 0, timestamp: new Date() })
      expect(warnings).toHaveLength(1)

      cost.reset()
      cost.record({ agentId: 'a1', costCents: 80, tokens: 0, timestamp: new Date() })
      expect(warnings).toHaveLength(2)
    })
  })

  describe('attach / detach', () => {
    it('listens for pipeline:phase_changed to track current phase', () => {
      cost = new CostAttributor({
        thresholds: {},
        eventBus: bus,
      })

      bus.emit({ type: 'pipeline:phase_changed', phase: 'gen_backend', previousPhase: 'plan' })

      // Record manually — phase should be set from event
      cost.record({ agentId: 'a1', costCents: 10, tokens: 100, timestamp: new Date() })
      const report = cost.getCostReport()
      // The manually recorded entry should not have the auto-tracked phase
      // but entries from event handlers should pick it up
      expect(report.entries).toHaveLength(1)
    })

    it('stops listening after detach', () => {
      cost = new CostAttributor({ eventBus: bus })
      cost.detach()

      // Emit after detach — should not affect cost
      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 1000 })

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(0)
    })

    it('can re-attach to a different bus', () => {
      cost = new CostAttributor()
      const bus2 = createEventBus()

      cost.attach(bus)
      cost.attach(bus2) // should detach from bus, attach to bus2

      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 100 })
      bus2.emit({ type: 'agent:completed', agentId: 'a2', runId: 'r2', durationMs: 200 })

      const report = cost.getCostReport()
      // Only bus2 event should be recorded
      expect(report.entries).toHaveLength(1)
      expect(report.byAgent['a2']).toBeDefined()
      expect(report.byAgent['a1']).toBeUndefined()
    })
  })
})
