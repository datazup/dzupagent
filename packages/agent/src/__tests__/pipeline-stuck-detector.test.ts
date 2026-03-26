import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineStuckDetector } from '../self-correction/pipeline-stuck-detector.js'

describe('PipelineStuckDetector', () => {
  let detector: PipelineStuckDetector

  beforeEach(() => {
    detector = new PipelineStuckDetector({
      maxNodeFailures: 3,
      maxIdenticalOutputs: 3,
      maxTotalRetries: 5,
      failureWindowMs: 300_000,
    })
  })

  describe('node failure counting', () => {
    it('does not flag below threshold', () => {
      expect(detector.recordNodeFailure('gen', 'timeout').stuck).toBe(false)
      expect(detector.recordNodeFailure('gen', 'timeout').stuck).toBe(false)
    })

    it('flags when node failures reach threshold', () => {
      detector.recordNodeFailure('gen', 'err 1')
      detector.recordNodeFailure('gen', 'err 2')
      const result = detector.recordNodeFailure('gen', 'err 3')
      expect(result.stuck).toBe(true)
      expect(result.nodeId).toBe('gen')
      expect(result.reason).toContain('gen')
      expect(result.reason).toContain('3 times')
    })

    it('tracks failures independently per node', () => {
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('review', 'err')
      // gen is at 2, review at 1 — neither at threshold
      expect(detector.getNodeFailureCount('gen')).toBe(2)
      expect(detector.getNodeFailureCount('review')).toBe(1)
    })

    it('returns 0 for unknown node', () => {
      expect(detector.getNodeFailureCount('unknown')).toBe(0)
    })
  })

  describe('identical output detection', () => {
    it('does not flag varied outputs', () => {
      expect(detector.recordNodeOutput('gen', 'output A').stuck).toBe(false)
      expect(detector.recordNodeOutput('gen', 'output B').stuck).toBe(false)
      expect(detector.recordNodeOutput('gen', 'output C').stuck).toBe(false)
    })

    it('flags identical outputs from the same node', () => {
      detector.recordNodeOutput('gen', 'same output')
      detector.recordNodeOutput('gen', 'same output')
      const result = detector.recordNodeOutput('gen', 'same output')
      expect(result.stuck).toBe(true)
      expect(result.nodeId).toBe('gen')
      expect(result.reason).toContain('identical outputs')
      expect(result.suggestedAction).toBe('switch_strategy')
    })

    it('does not flag identical outputs from different nodes', () => {
      detector.recordNodeOutput('gen', 'same output')
      detector.recordNodeOutput('review', 'same output')
      expect(detector.recordNodeOutput('test', 'same output').stuck).toBe(false)
    })

    it('resets detection after a different output breaks the streak', () => {
      detector.recordNodeOutput('gen', 'same output')
      detector.recordNodeOutput('gen', 'same output')
      detector.recordNodeOutput('gen', 'different output') // break streak
      // Now need 3 new identical to trigger again
      expect(detector.recordNodeOutput('gen', 'new output').stuck).toBe(false)
      expect(detector.recordNodeOutput('gen', 'new output').stuck).toBe(false)
      const result = detector.recordNodeOutput('gen', 'new output')
      expect(result.stuck).toBe(true)
    })
  })

  describe('total retry limit', () => {
    it('does not flag below limit', () => {
      for (let i = 0; i < 4; i++) {
        expect(detector.recordRetry().stuck).toBe(false)
      }
    })

    it('flags when total retries reach limit', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordRetry()
      }
      const result = detector.recordRetry()
      expect(result.stuck).toBe(true)
      expect(result.reason).toContain('5 total retries')
      expect(result.suggestedAction).toBe('abort')
    })

    it('tracks total retry count', () => {
      detector.recordRetry()
      detector.recordRetry()
      expect(detector.getTotalRetries()).toBe(2)
    })
  })

  describe('escalating suggested actions', () => {
    it('suggests retry_with_hint on first failure', () => {
      const result = detector.recordNodeFailure('gen', 'err')
      // Not stuck yet, but if we force check the escalation logic:
      // 1 failure => not stuck, no action
      expect(result.stuck).toBe(false)
    })

    it('suggests abort at threshold', () => {
      detector.recordNodeFailure('gen', 'err 1')
      detector.recordNodeFailure('gen', 'err 2')
      const result = detector.recordNodeFailure('gen', 'err 3')
      expect(result.stuck).toBe(true)
      expect(result.suggestedAction).toBe('abort')
    })

    it('suggests switch_strategy at 2 failures with lower threshold', () => {
      const d = new PipelineStuckDetector({
        maxNodeFailures: 2,
      })
      d.recordNodeFailure('gen', 'err 1')
      const result = d.recordNodeFailure('gen', 'err 2')
      expect(result.stuck).toBe(true)
      expect(result.suggestedAction).toBe('switch_strategy')
    })

    it('suggests retry_with_hint at 1 failure with threshold of 1', () => {
      const d = new PipelineStuckDetector({
        maxNodeFailures: 1,
      })
      const result = d.recordNodeFailure('gen', 'err 1')
      expect(result.stuck).toBe(true)
      expect(result.suggestedAction).toBe('retry_with_hint')
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeOutput('gen', 'same')
      detector.recordNodeOutput('gen', 'same')
      detector.recordRetry()
      detector.recordRetry()

      detector.reset()

      expect(detector.getNodeFailureCount('gen')).toBe(0)
      expect(detector.getTotalRetries()).toBe(0)

      const summary = detector.getSummary()
      expect(summary.nodeFailures.size).toBe(0)
      expect(summary.totalRetries).toBe(0)
      expect(summary.identicalOutputNodes).toEqual([])
    })

    it('allows re-accumulation after reset', () => {
      // Fill up to near threshold
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('gen', 'err')
      detector.reset()

      // After reset, 2 more failures should not trigger (need 3)
      expect(detector.recordNodeFailure('gen', 'err').stuck).toBe(false)
      expect(detector.recordNodeFailure('gen', 'err').stuck).toBe(false)
    })
  })

  describe('summary reporting', () => {
    it('reports empty summary initially', () => {
      const summary = detector.getSummary()
      expect(summary.nodeFailures.size).toBe(0)
      expect(summary.totalRetries).toBe(0)
      expect(summary.identicalOutputNodes).toEqual([])
    })

    it('reports accurate node failures and retries', () => {
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('gen', 'err')
      detector.recordNodeFailure('review', 'err')
      detector.recordRetry()
      detector.recordRetry()
      detector.recordRetry()

      const summary = detector.getSummary()
      expect(summary.nodeFailures.get('gen')).toBe(2)
      expect(summary.nodeFailures.get('review')).toBe(1)
      expect(summary.totalRetries).toBe(3)
    })

    it('reports nodes with identical outputs', () => {
      detector.recordNodeOutput('gen', 'same')
      detector.recordNodeOutput('gen', 'same')
      detector.recordNodeOutput('gen', 'same')
      detector.recordNodeOutput('review', 'varied 1')
      detector.recordNodeOutput('review', 'varied 2')

      const summary = detector.getSummary()
      expect(summary.identicalOutputNodes).toContain('gen')
      expect(summary.identicalOutputNodes).not.toContain('review')
    })
  })

  describe('default config', () => {
    it('uses sensible defaults', () => {
      const d = new PipelineStuckDetector()
      // Should not flag until 3 failures (default maxNodeFailures)
      d.recordNodeFailure('n', 'e')
      d.recordNodeFailure('n', 'e')
      expect(d.recordNodeFailure('n', 'e').stuck).toBe(true)

      d.reset()

      // Should not flag until 10 retries (default maxTotalRetries)
      for (let i = 0; i < 9; i++) {
        expect(d.recordRetry().stuck).toBe(false)
      }
      expect(d.recordRetry().stuck).toBe(true)
    })
  })
})
