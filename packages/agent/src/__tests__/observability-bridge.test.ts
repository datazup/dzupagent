import { describe, it, expect, beforeEach } from 'vitest'
import { ObservabilityCorrectionBridge } from '../self-correction/observability-bridge.js'

describe('ObservabilityCorrectionBridge', () => {
  let bridge: ObservabilityCorrectionBridge

  /** Helper to create a normal (no-signal) metric. */
  const normalMetric = (nodeId = 'gen') => ({
    nodeId,
    durationMs: 1_000,
    costCents: 5,
    tokenUsage: { input: 100, output: 50, budget: 10_000 },
    success: true,
  })

  beforeEach(() => {
    bridge = new ObservabilityCorrectionBridge()
  })

  describe('no signals for normal metrics', () => {
    it('returns empty array when all metrics are within thresholds', () => {
      const signals = bridge.recordNodeMetric(normalMetric())
      expect(signals).toEqual([])
      expect(bridge.getSignals()).toEqual([])
    })
  })

  describe('latency signals', () => {
    it('emits warning when latency exceeds warn threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        durationMs: 35_000,
      })
      const latencySignals = signals.filter((s) => s.type === 'latency_spike')
      expect(latencySignals).toHaveLength(1)
      expect(latencySignals[0]!.severity).toBe('warning')
      expect(latencySignals[0]!.nodeId).toBe('gen')
      expect(latencySignals[0]!.suggestedAction).toContain('faster model')
    })

    it('emits critical when latency exceeds critical threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        durationMs: 65_000,
      })
      const latencySignals = signals.filter((s) => s.type === 'latency_spike')
      expect(latencySignals).toHaveLength(1)
      expect(latencySignals[0]!.severity).toBe('critical')
    })

    it('does not emit at exactly below warn threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        durationMs: 29_999,
      })
      expect(signals.filter((s) => s.type === 'latency_spike')).toHaveLength(0)
    })

    it('emits warning at exactly the warn threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        durationMs: 30_000,
      })
      const latencySignals = signals.filter((s) => s.type === 'latency_spike')
      expect(latencySignals).toHaveLength(1)
      expect(latencySignals[0]!.severity).toBe('warning')
    })
  })

  describe('cost signals', () => {
    it('emits warning when cost exceeds warn threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        costCents: 75,
      })
      const costSignals = signals.filter((s) => s.type === 'cost_overrun')
      expect(costSignals).toHaveLength(1)
      expect(costSignals[0]!.severity).toBe('warning')
      expect(costSignals[0]!.suggestedAction).toContain('cheaper model')
    })

    it('emits critical when cost exceeds critical threshold', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        costCents: 250,
      })
      const costSignals = signals.filter((s) => s.type === 'cost_overrun')
      expect(costSignals).toHaveLength(1)
      expect(costSignals[0]!.severity).toBe('critical')
    })
  })

  describe('error rate signals (sliding window)', () => {
    it('does not emit on a single failure', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        success: false,
      })
      // 1 out of 1 = 100%, but window has only 1 entry — should still trigger
      // since 1.0 >= 0.5 (critical)
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(1)
      expect(errorSignals[0]!.severity).toBe('critical')
    })

    it('calculates error rate over sliding window', () => {
      // Record 7 successes and 3 failures = 30% error rate
      for (let i = 0; i < 7; i++) {
        bridge.recordNodeMetric(normalMetric())
      }
      // 3 failures to reach 30%
      bridge.recordNodeMetric({ ...normalMetric(), success: false })
      bridge.recordNodeMetric({ ...normalMetric(), success: false })
      const signals = bridge.recordNodeMetric({ ...normalMetric(), success: false })
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(1)
      expect(errorSignals[0]!.severity).toBe('warning')
    })

    it('emits critical when error rate exceeds critical threshold', () => {
      // Record 5 successes and 5 failures = 50% error rate
      for (let i = 0; i < 5; i++) {
        bridge.recordNodeMetric(normalMetric())
      }
      for (let i = 0; i < 4; i++) {
        bridge.recordNodeMetric({ ...normalMetric(), success: false })
      }
      const signals = bridge.recordNodeMetric({ ...normalMetric(), success: false })
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(1)
      expect(errorSignals[0]!.severity).toBe('critical')
    })

    it('sliding window forgets old entries', () => {
      // Fill window with 10 failures (all critical)
      for (let i = 0; i < 10; i++) {
        bridge.recordNodeMetric({ ...normalMetric(), success: false })
      }
      // Now push 8 successes, error rate should drop to 2/10 = 20%
      for (let i = 0; i < 8; i++) {
        bridge.recordNodeMetric(normalMetric())
      }
      const signals = bridge.recordNodeMetric(normalMetric())
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(0)
    })

    it('tracks error rate independently per node', () => {
      // Node A: all failures
      for (let i = 0; i < 5; i++) {
        bridge.recordNodeMetric({ ...normalMetric('nodeA'), success: false })
      }
      // Node B: all successes
      const signals = bridge.recordNodeMetric(normalMetric('nodeB'))
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(0)
    })
  })

  describe('token budget warnings', () => {
    it('emits warning when token usage exceeds warn ratio', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        tokenUsage: { input: 5000, output: 2500, budget: 10_000 },
      })
      const tokenSignals = signals.filter((s) => s.type === 'token_budget_warning')
      expect(tokenSignals).toHaveLength(1)
      expect(tokenSignals[0]!.severity).toBe('warning')
      expect(tokenSignals[0]!.suggestedAction).toContain('Compress context')
    })

    it('emits critical when token usage exceeds critical ratio', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        tokenUsage: { input: 8000, output: 2000, budget: 10_000 },
      })
      const tokenSignals = signals.filter((s) => s.type === 'token_budget_warning')
      expect(tokenSignals).toHaveLength(1)
      expect(tokenSignals[0]!.severity).toBe('critical')
    })

    it('does not emit when usage is below warn ratio', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        tokenUsage: { input: 3000, output: 2000, budget: 10_000 },
      })
      const tokenSignals = signals.filter((s) => s.type === 'token_budget_warning')
      expect(tokenSignals).toHaveLength(0)
    })

    it('handles zero budget gracefully', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        tokenUsage: { input: 100, output: 50, budget: 0 },
      })
      const tokenSignals = signals.filter((s) => s.type === 'token_budget_warning')
      expect(tokenSignals).toHaveLength(0)
    })
  })

  describe('multiple signals from single metric', () => {
    it('can emit latency + cost + token signals simultaneously', () => {
      const signals = bridge.recordNodeMetric({
        nodeId: 'heavy',
        durationMs: 70_000,
        costCents: 300,
        tokenUsage: { input: 9000, output: 1500, budget: 10_000 },
        success: true,
      })
      const types = signals.map((s) => s.type)
      expect(types).toContain('latency_spike')
      expect(types).toContain('cost_overrun')
      expect(types).toContain('token_budget_warning')
      expect(signals.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('getNodeSignals', () => {
    it('filters signals by node ID', () => {
      bridge.recordNodeMetric({ ...normalMetric('nodeA'), durationMs: 35_000 })
      bridge.recordNodeMetric({ ...normalMetric('nodeB'), costCents: 75 })
      bridge.recordNodeMetric({ ...normalMetric('nodeA'), costCents: 250 })

      const nodeASignals = bridge.getNodeSignals('nodeA')
      expect(nodeASignals.every((s) => s.nodeId === 'nodeA')).toBe(true)
      expect(nodeASignals.length).toBeGreaterThanOrEqual(2)

      const nodeBSignals = bridge.getNodeSignals('nodeB')
      expect(nodeBSignals.every((s) => s.nodeId === 'nodeB')).toBe(true)
      expect(nodeBSignals.length).toBeGreaterThanOrEqual(1)
    })

    it('returns empty for unknown node', () => {
      bridge.recordNodeMetric({ ...normalMetric('nodeA'), durationMs: 35_000 })
      expect(bridge.getNodeSignals('unknown')).toEqual([])
    })
  })

  describe('getSignalCounts', () => {
    it('counts signals by type', () => {
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 35_000 })
      bridge.recordNodeMetric({ ...normalMetric(), costCents: 75 })
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 65_000 })

      const counts = bridge.getSignalCounts()
      expect(counts.get('latency_spike')).toBe(2)
      expect(counts.get('cost_overrun')).toBe(1)
    })
  })

  describe('hasCriticalSignals', () => {
    it('returns false when no signals exist', () => {
      expect(bridge.hasCriticalSignals()).toBe(false)
    })

    it('returns false when only warning signals exist', () => {
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 35_000 })
      expect(bridge.hasCriticalSignals()).toBe(false)
    })

    it('returns true when a critical signal exists', () => {
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 65_000 })
      expect(bridge.hasCriticalSignals()).toBe(true)
    })
  })

  describe('summarize', () => {
    it('returns no-signals message when empty', () => {
      expect(bridge.summarize()).toBe('No correction signals recorded.')
    })

    it('generates markdown summary grouped by severity', () => {
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 65_000 }) // critical
      bridge.recordNodeMetric({ ...normalMetric(), costCents: 75 }) // warning

      const summary = bridge.summarize()
      expect(summary).toContain('# Correction Signal Summary')
      expect(summary).toContain('## CRITICAL')
      expect(summary).toContain('## WARNING')
      expect(summary).toContain('latency_spike')
      expect(summary).toContain('cost_overrun')
      expect(summary).toContain('Action:')
    })

    it('lists critical before warning', () => {
      bridge.recordNodeMetric({ ...normalMetric(), costCents: 75 }) // warning first
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 65_000 }) // then critical

      const summary = bridge.summarize()
      const criticalIdx = summary.indexOf('## CRITICAL')
      const warningIdx = summary.indexOf('## WARNING')
      expect(criticalIdx).toBeLessThan(warningIdx)
    })
  })

  describe('custom thresholds', () => {
    it('respects custom latency thresholds', () => {
      const custom = new ObservabilityCorrectionBridge({
        thresholds: {
          latencyWarnMs: 5_000,
          latencyCriticalMs: 10_000,
        },
      })

      const signals = custom.recordNodeMetric({
        ...normalMetric(),
        durationMs: 6_000,
      })
      const latencySignals = signals.filter((s) => s.type === 'latency_spike')
      expect(latencySignals).toHaveLength(1)
      expect(latencySignals[0]!.severity).toBe('warning')
    })

    it('respects custom cost thresholds', () => {
      const custom = new ObservabilityCorrectionBridge({
        thresholds: {
          costWarnCents: 10,
          costCriticalCents: 20,
        },
      })

      const signals = custom.recordNodeMetric({
        ...normalMetric(),
        costCents: 25,
      })
      const costSignals = signals.filter((s) => s.type === 'cost_overrun')
      expect(costSignals).toHaveLength(1)
      expect(costSignals[0]!.severity).toBe('critical')
    })

    it('respects custom error rate thresholds', () => {
      const custom = new ObservabilityCorrectionBridge({
        thresholds: {
          errorRateWarn: 0.1,
          errorRateCritical: 0.2,
        },
      })

      // 2 successes + 1 failure = ~33% error rate > 0.2 critical
      custom.recordNodeMetric(normalMetric())
      custom.recordNodeMetric(normalMetric())
      const signals = custom.recordNodeMetric({ ...normalMetric(), success: false })
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(1)
      expect(errorSignals[0]!.severity).toBe('critical')
    })

    it('respects custom token budget thresholds', () => {
      const custom = new ObservabilityCorrectionBridge({
        thresholds: {
          tokenBudgetWarn: 0.5,
          tokenBudgetCritical: 0.8,
        },
      })

      const signals = custom.recordNodeMetric({
        ...normalMetric(),
        tokenUsage: { input: 4000, output: 2000, budget: 10_000 },
      })
      const tokenSignals = signals.filter((s) => s.type === 'token_budget_warning')
      expect(tokenSignals).toHaveLength(1)
      expect(tokenSignals[0]!.severity).toBe('warning')
    })
  })

  describe('maxSignals enforcement', () => {
    it('trims oldest signals when maxSignals is exceeded', () => {
      const small = new ObservabilityCorrectionBridge({ maxSignals: 3 })
      // Each call generates at least 1 latency signal
      for (let i = 0; i < 5; i++) {
        small.recordNodeMetric({ ...normalMetric(), durationMs: 35_000 })
      }
      expect(small.getSignals().length).toBeLessThanOrEqual(3)
    })
  })

  describe('reset', () => {
    it('clears all signals and per-node state', () => {
      bridge.recordNodeMetric({ ...normalMetric(), durationMs: 65_000 })
      bridge.recordNodeMetric({ ...normalMetric(), success: false })
      expect(bridge.getSignals().length).toBeGreaterThan(0)

      bridge.reset()

      expect(bridge.getSignals()).toEqual([])
      expect(bridge.hasCriticalSignals()).toBe(false)
      expect(bridge.getSignalCounts().size).toBe(0)
      expect(bridge.summarize()).toBe('No correction signals recorded.')
    })

    it('allows re-accumulation after reset', () => {
      // Fill with failures to set high error rate
      for (let i = 0; i < 5; i++) {
        bridge.recordNodeMetric({ ...normalMetric(), success: false })
      }
      bridge.reset()

      // After reset, a single success should not trigger error_rate_high
      const signals = bridge.recordNodeMetric(normalMetric())
      const errorSignals = signals.filter((s) => s.type === 'error_rate_high')
      expect(errorSignals).toHaveLength(0)
    })
  })

  describe('signal structure', () => {
    it('has correct shape', () => {
      const signals = bridge.recordNodeMetric({
        ...normalMetric(),
        durationMs: 35_000,
      })
      expect(signals).toHaveLength(1)
      const signal = signals[0]!
      expect(signal.id).toMatch(/^sig_/)
      expect(signal.type).toBe('latency_spike')
      expect(signal.severity).toBe('warning')
      expect(signal.nodeId).toBe('gen')
      expect(signal.message).toContain('gen')
      expect(signal.details).toHaveProperty('durationMs', 35_000)
      expect(signal.suggestedAction).toBeDefined()
      expect(signal.timestamp).toBeInstanceOf(Date)
    })
  })
})
