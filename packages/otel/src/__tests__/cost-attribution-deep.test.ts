/**
 * Wave 21 deep coverage for CostAttributor.
 *
 * Gap analysis targets (not covered by cost-attribution.test.ts or
 * cost-attribution-extended.test.ts):
 *  - Multi-agent cost aggregation semantics
 *  - Per-session / per-run breakdown via phase grouping
 *  - Budget threshold callback ordering and edge ratios
 *  - Zero-cost operations do not skew totals
 *  - Distinct input vs output token cost application
 *  - Small-amount currency precision (no fp rounding errors)
 *  - Reset semantics preserving threshold re-fire
 *  - Provider-specific rate application
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { CostAttributor } from '../cost-attribution.js'

describe('CostAttributor — deep (W21-B1)', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  // ----- Multi-agent cost aggregation ----------------------------------

  describe('multi-agent cost aggregation', () => {
    it('cost for agent A + agent B equals total cost', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'A', costCents: 25, tokens: 250, timestamp: new Date() })
      cost.record({ agentId: 'B', costCents: 75, tokens: 750, timestamp: new Date() })

      const report = cost.getCostReport()
      const sumAgents =
        report.byAgent['A']!.costCents + report.byAgent['B']!.costCents
      expect(sumAgents).toBe(report.totalCostCents)
      expect(report.totalCostCents).toBe(100)
    })

    it('maintains independent token buckets per agent', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'A', costCents: 0, tokens: 1_000, timestamp: new Date() })
      cost.record({ agentId: 'A', costCents: 0, tokens: 500, timestamp: new Date() })
      cost.record({ agentId: 'B', costCents: 0, tokens: 200, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byAgent['A']!.tokens).toBe(1_500)
      expect(report.byAgent['B']!.tokens).toBe(200)
    })

    it('aggregates correctly across 10 agents', () => {
      const cost = new CostAttributor()
      for (let i = 0; i < 10; i++) {
        cost.record({ agentId: `agent-${i}`, costCents: 10, tokens: 100, timestamp: new Date() })
      }

      const report = cost.getCostReport()
      expect(Object.keys(report.byAgent)).toHaveLength(10)
      expect(report.totalCostCents).toBe(100)
      expect(report.totalTokens).toBe(1_000)
    })
  })

  // ----- Per-session / per-run breakdown --------------------------------

  describe('per-session / per-run breakdown via phase', () => {
    it('phases act as session/run partitions', () => {
      const cost = new CostAttributor()
      // Two sessions represented by distinct phase prefixes
      cost.record({ agentId: 'a1', phase: 'session-1/plan', costCents: 5, tokens: 50, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'session-1/exec', costCents: 10, tokens: 100, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'session-2/plan', costCents: 7, tokens: 70, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byPhase['session-1/plan']!.costCents).toBe(5)
      expect(report.byPhase['session-1/exec']!.costCents).toBe(10)
      expect(report.byPhase['session-2/plan']!.costCents).toBe(7)
    })

    it('run-level aggregation via entries timestamp order', () => {
      const cost = new CostAttributor()
      const t0 = new Date('2025-01-01T00:00:00Z')
      const t1 = new Date('2025-01-01T00:00:01Z')
      const t2 = new Date('2025-01-01T00:00:02Z')

      cost.record({ agentId: 'a1', costCents: 1, tokens: 10, timestamp: t0 })
      cost.record({ agentId: 'a1', costCents: 2, tokens: 20, timestamp: t1 })
      cost.record({ agentId: 'a1', costCents: 3, tokens: 30, timestamp: t2 })

      const report = cost.getCostReport()
      expect(report.entries.map((e) => e.timestamp)).toEqual([t0, t1, t2])
      expect(report.totalCostCents).toBe(6)
    })
  })

  // ----- Budget threshold callbacks ------------------------------------

  describe('budget threshold callback edges', () => {
    it('fires exceeded exactly at ratio = 1.0', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })
      expect(exceeded).toHaveLength(1)
    })

    it('warning fires at exactly warningRatio (default 0.8)', () => {
      const warnings: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 80, tokens: 0, timestamp: new Date() })
      expect(warnings).toHaveLength(1)
    })

    it('exceeded is emitted at most once across many over-budget records', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 50 },
        eventBus: bus,
      })

      for (let i = 0; i < 5; i++) {
        cost.record({ agentId: 'a1', costCents: 100, tokens: 0, timestamp: new Date() })
      }
      expect(exceeded).toHaveLength(1)
    })
  })

  // ----- Zero-cost operations ------------------------------------------

  describe('zero-cost operations', () => {
    it('records a zero-cost entry without affecting totals', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 0, tokens: 0, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(0)
      expect(report.totalTokens).toBe(0)
      expect(report.entries).toHaveLength(1)
    })

    it('zero-cost operations are still attributed to agents', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 0, tokens: 0, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byAgent['a1']).toEqual({ costCents: 0, tokens: 0 })
    })

    it('mixing zero-cost and non-zero operations yields correct totals', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 0, tokens: 0, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 42, tokens: 420, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 0, tokens: 0, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(42)
      expect(report.totalTokens).toBe(420)
      expect(report.entries).toHaveLength(3)
    })
  })

  // ----- Input vs output token cost rates ------------------------------

  describe('input vs output token cost application', () => {
    it('accepts separate cost entries for input and output tokens', () => {
      const cost = new CostAttributor()
      // Caller applies rate per direction; attributor tracks totals
      cost.record({ agentId: 'a1', phase: 'input', costCents: 3, tokens: 1000, timestamp: new Date() })
      cost.record({ agentId: 'a1', phase: 'output', costCents: 15, tokens: 1000, timestamp: new Date() })

      const report = cost.getCostReport()
      // Output tokens are 5x more expensive in this example
      expect(report.byPhase['input']!.costCents).toBe(3)
      expect(report.byPhase['output']!.costCents).toBe(15)
      expect(report.byPhase['output']!.costCents / report.byPhase['input']!.costCents).toBe(5)
    })
  })

  // ----- Currency precision --------------------------------------------

  describe('currency precision', () => {
    it('accumulates many small costs without floating-point drift', () => {
      const cost = new CostAttributor()
      // Use integer cents — should be exact
      for (let i = 0; i < 100; i++) {
        cost.record({ agentId: 'a1', costCents: 1, tokens: 1, timestamp: new Date() })
      }
      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(100)
      expect(report.totalTokens).toBe(100)
    })

    it('handles fractional cost values (if provided) precisely for small sums', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 0.1, tokens: 1, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: 0.2, tokens: 1, timestamp: new Date() })
      // 0.1 + 0.2 = 0.3 in IEEE754 — verify that the sum is tolerably close
      const report = cost.getCostReport()
      expect(report.totalCostCents).toBeCloseTo(0.3, 10)
    })

    it('large cost totals above 2^31 tracked without overflow', () => {
      const cost = new CostAttributor()
      const big = 3_000_000_000
      cost.record({ agentId: 'a1', costCents: big, tokens: 0, timestamp: new Date() })
      cost.record({ agentId: 'a1', costCents: big, tokens: 0, timestamp: new Date() })
      expect(cost.getCostReport().totalCostCents).toBe(big * 2)
    })
  })

  // ----- Reset semantics -----------------------------------------------

  describe('reset semantics', () => {
    it('reset leaves collector ready for a fresh session', () => {
      const cost = new CostAttributor()
      cost.record({ agentId: 'a1', costCents: 50, tokens: 500, timestamp: new Date() })
      cost.reset()

      cost.record({ agentId: 'a1', costCents: 7, tokens: 70, timestamp: new Date() })
      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(7)
      expect(report.entries).toHaveLength(1)
    })

    it('reset clears exceeded-emitted flag so it can fire again', () => {
      const exceeded: unknown[] = []
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      const cost = new CostAttributor({
        thresholds: { maxCostCents: 100 },
        eventBus: bus,
      })

      cost.record({ agentId: 'a1', costCents: 150, tokens: 0, timestamp: new Date() })
      expect(exceeded).toHaveLength(1)

      cost.reset()

      cost.record({ agentId: 'a1', costCents: 150, tokens: 0, timestamp: new Date() })
      expect(exceeded).toHaveLength(2)
    })

    it('reset clears currentPhase tracking', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'pipeline:phase_changed', phase: 'plan', previousPhase: undefined })
      cost.reset()

      bus.emit({ type: 'tool:result', toolName: 'read_file', durationMs: 10 })
      const report = cost.getCostReport()
      // After reset, currentPhase is undefined — the tool:result event records with no phase
      expect(report.entries).toHaveLength(1)
      expect(report.entries[0]!.phase).toBeUndefined()
    })
  })

  // ----- Provider-specific rate application ----------------------------

  describe('provider-specific rates', () => {
    it('attributes different costs to different provider agent ids', () => {
      const cost = new CostAttributor()
      // Anthropic Haiku: 0.25 USD per 1M input, 1.25 per 1M output
      // OpenAI GPT-4o: 2.50 per 1M input, 10 per 1M output
      // caller resolves rate; attributor just stores the derived cents
      cost.record({ agentId: 'anthropic:haiku', costCents: 25, tokens: 100_000, timestamp: new Date() })
      cost.record({ agentId: 'openai:gpt-4o', costCents: 250, tokens: 100_000, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.byAgent['anthropic:haiku']!.costCents).toBe(25)
      expect(report.byAgent['openai:gpt-4o']!.costCents).toBe(250)
      // Per-token cost ratio implies 10x difference
      const ratio =
        report.byAgent['openai:gpt-4o']!.costCents / report.byAgent['anthropic:haiku']!.costCents
      expect(ratio).toBe(10)
    })
  })
})
