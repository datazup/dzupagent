/**
 * Regression tests for DZUPAGENT-AGENT-C-07.
 *
 * `CostAttributor.attach()` used to hard-code `costCents: 0` / `tokens: 0` on
 * every event handler, so `getCostReport()` was structurally zero and the
 * `budget:warning` / `budget:exceeded` threshold checks could never fire from
 * observed bus traffic. These tests pin the corrected behaviour:
 *
 *  - `agent:completed` carrying `usage` attributes real cost/tokens
 *  - `llm:invoked` (the native run engine's usage-bearing event) is attributed
 *  - budget alerts fire from bus traffic alone, with no manual `record()` call
 *  - `tool:result` remains explicitly zero-cost (no usage on that event)
 *  - the entry log is bounded, while totals stay complete
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { CostAttributor, DEFAULT_MAX_COST_ENTRIES } from '../cost-attribution.js'

describe('CostAttributor — usage-bearing events (C-07)', () => {
  let bus: DzupEventBus

  beforeEach(() => {
    bus = createEventBus()
  })

  describe('agent:completed', () => {
    it('attributes costCents and tokens from event usage', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({
        type: 'agent:completed',
        agentId: 'code-gen',
        runId: 'r1',
        durationMs: 1000,
        usage: { inputTokens: 1200, outputTokens: 300, costCents: 42, model: 'claude-sonnet-4' },
      })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(42)
      expect(report.totalTokens).toBe(1500)
      expect(report.byAgent['code-gen']).toEqual({ costCents: 42, tokens: 1500 })
      expect(report.entries[0]!.costCents).toBe(42)
    })

    it('accumulates across multiple agents and attributes the active phase', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'pipeline:phase_changed', phase: 'gen_backend', previousPhase: 'plan' })
      bus.emit({
        type: 'agent:completed',
        agentId: 'a1',
        runId: 'r1',
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 50, costCents: 5 },
      })
      bus.emit({
        type: 'agent:completed',
        agentId: 'a2',
        runId: 'r2',
        durationMs: 10,
        usage: { inputTokens: 200, outputTokens: 100, costCents: 11 },
      })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(16)
      expect(report.totalTokens).toBe(450)
      expect(report.byAgent['a1']).toEqual({ costCents: 5, tokens: 150 })
      expect(report.byAgent['a2']).toEqual({ costCents: 11, tokens: 300 })
      expect(report.byPhase['gen_backend']).toEqual({ costCents: 16, tokens: 450 })
    })

    it('excludes cachedInputTokens from the token total (subset of inputTokens)', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({
        type: 'agent:completed',
        agentId: 'a1',
        runId: 'r1',
        durationMs: 10,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, costCents: 3 },
      })

      expect(cost.getCostReport().totalTokens).toBe(120)
    })

    it('falls back to zero — deliberately — when the producer omits usage', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'agent:completed', agentId: 'a1', runId: 'r1', durationMs: 10 })

      const report = cost.getCostReport()
      // The completion is still recorded (entry/agent bookkeeping), but with no
      // fabricated cost: there is genuinely no usage data on the event.
      expect(report.entries).toHaveLength(1)
      expect(report.totalCostCents).toBe(0)
      expect(report.totalTokens).toBe(0)
    })

    it('tolerates partial usage payloads', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({
        type: 'agent:completed',
        agentId: 'a1',
        runId: 'r1',
        durationMs: 10,
        usage: { costCents: 7 },
      })
      bus.emit({
        type: 'agent:completed',
        agentId: 'a2',
        runId: 'r2',
        durationMs: 10,
        usage: { inputTokens: 40 },
      })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(7)
      expect(report.totalTokens).toBe(40)
    })
  })

  describe('llm:invoked', () => {
    it('attributes per-call cost and tokens from the native run engine event', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({
        type: 'llm:invoked',
        agentId: 'planner',
        model: 'claude-sonnet-4',
        inputTokens: 900,
        outputTokens: 100,
        costCents: 12,
        timestamp: Date.now(),
      })
      bus.emit({
        type: 'llm:invoked',
        agentId: 'planner',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 50,
        costCents: 3,
        timestamp: Date.now(),
      })

      const report = cost.getCostReport()
      expect(report.totalCostCents).toBe(15)
      expect(report.totalTokens).toBe(1150)
      expect(report.byAgent['planner']).toEqual({ costCents: 15, tokens: 1150 })
    })

    it('ignores cache tiers in the token total (tracked separately by M-27)', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({
        type: 'llm:invoked',
        agentId: 'planner',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5000,
        cacheWriteTokens: 2000,
        costCents: 2,
        timestamp: Date.now(),
      })

      expect(cost.getCostReport().totalTokens).toBe(110)
    })

    it('stops attributing after detach', () => {
      const cost = new CostAttributor({ eventBus: bus })
      cost.detach()

      bus.emit({
        type: 'llm:invoked',
        agentId: 'planner',
        model: 'm',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 9,
        timestamp: Date.now(),
      })

      expect(cost.getCostReport().totalCostCents).toBe(0)
    })
  })

  describe('budget alerting from bus traffic alone', () => {
    it('emits budget:warning then budget:exceeded without any manual record()', () => {
      const warnings: unknown[] = []
      const exceeded: unknown[] = []
      bus.on('budget:warning', (e) => warnings.push(e))
      bus.on('budget:exceeded', (e) => exceeded.push(e))

      new CostAttributor({ eventBus: bus, thresholds: { maxCostCents: 100 } })

      bus.emit({
        type: 'agent:completed',
        agentId: 'a1',
        runId: 'r1',
        durationMs: 10,
        usage: { inputTokens: 10, outputTokens: 10, costCents: 85 },
      })
      expect(warnings).toHaveLength(1)
      expect(exceeded).toHaveLength(0)

      bus.emit({
        type: 'llm:invoked',
        agentId: 'a1',
        model: 'm',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 20,
        timestamp: Date.now(),
      })
      expect(exceeded).toHaveLength(1)
    })

    it('emits budget:exceeded on the token threshold from bus traffic', () => {
      const exceeded: Array<{ reason?: string }> = []
      bus.on('budget:exceeded', (e) => exceeded.push(e as { reason?: string }))

      new CostAttributor({ eventBus: bus, thresholds: { maxTokens: 1000 } })

      bus.emit({
        type: 'llm:invoked',
        agentId: 'a1',
        model: 'm',
        inputTokens: 900,
        outputTokens: 200,
        costCents: 0,
        timestamp: Date.now(),
      })

      expect(exceeded).toHaveLength(1)
      expect(exceeded[0]!.reason).toBe('tokens')
    })
  })

  describe('tool:result', () => {
    it('records a zero-cost entry — the event carries no usage data', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'tool:result', toolName: 'write_file', durationMs: 50 })

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(1)
      expect(report.byTool['write_file']).toEqual({ costCents: 0, tokens: 0 })
      expect(report.totalCostCents).toBe(0)
    })

    it('does not dilute costs attributed by usage-bearing events', () => {
      const cost = new CostAttributor({ eventBus: bus })

      bus.emit({ type: 'tool:result', toolName: 'read_file', durationMs: 5 })
      bus.emit({
        type: 'llm:invoked',
        agentId: 'a1',
        model: 'm',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 4,
        timestamp: Date.now(),
      })

      expect(cost.getCostReport().totalCostCents).toBe(4)
    })
  })

  describe('entry log is bounded', () => {
    it('retains only the most recent maxEntries while keeping totals complete', () => {
      const cost = new CostAttributor({ eventBus: bus, maxEntries: 10 })

      for (let i = 0; i < 100; i += 1) {
        bus.emit({
          type: 'llm:invoked',
          agentId: 'a1',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costCents: 1,
          timestamp: Date.now(),
        })
      }

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(10)
      expect(report.entriesTruncated).toBe(true)
      expect(report.recordedEntryCount).toBe(100)
      // Totals are accumulated, not derived from `entries` — eviction must not
      // lose spend.
      expect(report.totalCostCents).toBe(100)
      expect(report.totalTokens).toBe(200)
      expect(report.byAgent['a1']).toEqual({ costCents: 100, tokens: 200 })
    })

    it('maxEntries: 0 keeps totals with no retained entries', () => {
      const cost = new CostAttributor({ maxEntries: 0 })

      cost.record({ agentId: 'a1', costCents: 5, tokens: 10, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(0)
      expect(report.entriesTruncated).toBe(true)
      expect(report.recordedEntryCount).toBe(1)
      expect(report.totalCostCents).toBe(5)
    })

    it('defaults to DEFAULT_MAX_COST_ENTRIES and reports untruncated below the cap', () => {
      expect(DEFAULT_MAX_COST_ENTRIES).toBeGreaterThan(0)
      const cost = new CostAttributor()

      cost.record({ agentId: 'a1', costCents: 1, tokens: 1, timestamp: new Date() })

      const report = cost.getCostReport()
      expect(report.entriesTruncated).toBe(false)
      expect(report.recordedEntryCount).toBe(1)
    })

    it('reset() clears the retention bookkeeping', () => {
      const cost = new CostAttributor({ maxEntries: 2 })
      for (let i = 0; i < 5; i += 1) {
        cost.record({ agentId: 'a1', costCents: 1, tokens: 1, timestamp: new Date() })
      }
      expect(cost.getCostReport().entriesTruncated).toBe(true)

      cost.reset()

      const report = cost.getCostReport()
      expect(report.entries).toHaveLength(0)
      expect(report.entriesTruncated).toBe(false)
      expect(report.recordedEntryCount).toBe(0)
      expect(report.totalCostCents).toBe(0)
    })
  })
})
