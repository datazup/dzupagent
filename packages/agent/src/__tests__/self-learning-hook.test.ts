import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SelfLearningPipelineHook } from '../self-correction/self-learning-hook.js'
import type { PipelineRuntimeEvent } from '../pipeline/pipeline-runtime-types.js'
import type { SelfLearningHookConfig } from '../self-correction/self-learning-hook.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireEvent(handler: (event: PipelineRuntimeEvent) => void, event: PipelineRuntimeEvent): void {
  handler(event)
}

/** Wait a tick so fire-and-forget promises settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 10))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfLearningPipelineHook', () => {
  let config: SelfLearningHookConfig

  beforeEach(() => {
    config = {}
  })

  // -----------------------------------------------------------------------
  // Event dispatching
  // -----------------------------------------------------------------------

  describe('event dispatching', () => {
    it('dispatches pipeline:node_started to onBeforeNode', async () => {
      config.onBeforeNode = vi.fn().mockResolvedValue('enrichment')
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'n1', nodeType: 'standard' })
      await tick()

      expect(config.onBeforeNode).toHaveBeenCalledWith('n1', 'standard')
    })

    it('dispatches pipeline:node_completed to onNodeCompleted', async () => {
      config.onNodeCompleted = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_completed', nodeId: 'n1', durationMs: 500 })
      await tick()

      expect(config.onNodeCompleted).toHaveBeenCalledWith('n1', 500, undefined)
    })

    it('dispatches pipeline:node_failed to onNodeFailed', async () => {
      config.onNodeFailed = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_failed', nodeId: 'n1', error: 'boom' })
      await tick()

      expect(config.onNodeFailed).toHaveBeenCalledWith('n1', 'boom')
    })

    it('dispatches pipeline:completed to onPipelineCompleted', async () => {
      config.onPipelineCompleted = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:completed', runId: 'r1', totalDurationMs: 1000 })
      await tick()

      expect(config.onPipelineCompleted).toHaveBeenCalledWith('r1', 1000)
    })

    it('dispatches pipeline:failed to onPipelineFailed', async () => {
      config.onPipelineFailed = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:failed', runId: 'r1', error: 'fatal' })
      await tick()

      expect(config.onPipelineFailed).toHaveBeenCalledWith('r1', 'fatal')
    })

    it('dispatches pipeline:stuck_detected to onStuckDetected', async () => {
      config.onStuckDetected = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:stuck_detected',
        nodeId: 'n1',
        reason: 'repeated output',
        suggestedAction: 'switch_strategy',
      })
      await tick()

      expect(config.onStuckDetected).toHaveBeenCalledWith('n1', 'repeated output')
    })

    it('dispatches pipeline:recovery_succeeded to onRecovery with success=true', async () => {
      config.onRecovery = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:recovery_succeeded',
        nodeId: 'n1',
        attempt: 1,
        summary: 'fixed it',
      })
      await tick()

      expect(config.onRecovery).toHaveBeenCalledWith('n1', 1, true, 'fixed it')
    })

    it('dispatches pipeline:recovery_failed to onRecovery with success=false', async () => {
      config.onRecovery = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:recovery_failed',
        nodeId: 'n1',
        attempt: 2,
        error: 'still broken',
      })
      await tick()

      expect(config.onRecovery).toHaveBeenCalledWith('n1', 2, false, 'still broken')
    })
  })

  // -----------------------------------------------------------------------
  // Metrics tracking
  // -----------------------------------------------------------------------

  describe('metrics tracking', () => {
    it('tracks nodesStarted', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'b', nodeType: 'loop' })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(2)
    })

    it('tracks nodesCompleted', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_completed', nodeId: 'a', durationMs: 100 })
      await tick()

      expect(hook.getMetrics().nodesCompleted).toBe(1)
    })

    it('tracks nodesFailed', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_failed', nodeId: 'a', error: 'err' })
      await tick()

      expect(hook.getMetrics().nodesFailed).toBe(1)
    })

    it('tracks enrichmentsApplied when onBeforeNode returns a value', async () => {
      config.onBeforeNode = vi.fn().mockResolvedValue('hint')
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      await tick()

      expect(hook.getMetrics().enrichmentsApplied).toBe(1)
    })

    it('does not count enrichment when onBeforeNode returns undefined', async () => {
      config.onBeforeNode = vi.fn().mockResolvedValue(undefined)
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      await tick()

      expect(hook.getMetrics().enrichmentsApplied).toBe(0)
    })

    it('tracks stuckDetections', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:stuck_detected',
        nodeId: 'a',
        reason: 'loops',
        suggestedAction: 'abort',
      })
      await tick()

      expect(hook.getMetrics().stuckDetections).toBe(1)
    })

    it('tracks recoveriesAttempted', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:recovery_attempted',
        nodeId: 'a',
        attempt: 1,
        maxAttempts: 3,
        error: 'err',
      })
      await tick()

      expect(hook.getMetrics().recoveriesAttempted).toBe(1)
    })

    it('tracks recoveriesSucceeded', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:recovery_succeeded',
        nodeId: 'a',
        attempt: 1,
        summary: 'ok',
      })
      await tick()

      expect(hook.getMetrics().recoveriesSucceeded).toBe(1)
    })

    it('tracks totalDurationMs from pipeline:completed', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:completed', runId: 'r1', totalDurationMs: 5000 })
      await tick()

      expect(hook.getMetrics().totalDurationMs).toBe(5000)
    })
  })

  // -----------------------------------------------------------------------
  // Error safety
  // -----------------------------------------------------------------------

  describe('error safety', () => {
    it('callback errors do not propagate', async () => {
      config.onNodeCompleted = vi.fn().mockRejectedValue(new Error('callback crash'))
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      // Should not throw
      fireEvent(handler, { type: 'pipeline:node_completed', nodeId: 'a', durationMs: 100 })
      await tick()

      // Metric still counted despite callback error
      expect(hook.getMetrics().nodesCompleted).toBe(1)
    })

    it('onBeforeNode errors do not propagate', async () => {
      config.onBeforeNode = vi.fn().mockRejectedValue(new Error('enrichment crash'))
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      await tick()

      // nodesStarted still incremented before the callback
      expect(hook.getMetrics().nodesStarted).toBe(1)
    })

    it('onPipelineFailed errors do not propagate', async () => {
      config.onPipelineFailed = vi.fn().mockRejectedValue(new Error('fail handler crash'))
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:failed', runId: 'r1', error: 'fatal' })
      await tick()

      // No exception thrown
      expect(true).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('clears all metrics', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      fireEvent(handler, { type: 'pipeline:node_completed', nodeId: 'a', durationMs: 100 })
      fireEvent(handler, { type: 'pipeline:node_failed', nodeId: 'b', error: 'err' })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(1)

      hook.reset()

      const m = hook.getMetrics()
      expect(m.nodesStarted).toBe(0)
      expect(m.nodesCompleted).toBe(0)
      expect(m.nodesFailed).toBe(0)
      expect(m.enrichmentsApplied).toBe(0)
      expect(m.stuckDetections).toBe(0)
      expect(m.recoveriesAttempted).toBe(0)
      expect(m.recoveriesSucceeded).toBe(0)
      expect(m.totalDurationMs).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // createWithDefaults
  // -----------------------------------------------------------------------

  describe('createWithDefaults', () => {
    it('creates a hook with enricher callback', async () => {
      const enricher = {
        enrich: vi.fn().mockResolvedValue({ content: 'enriched prompt' }),
      }
      const hook = SelfLearningPipelineHook.createWithDefaults({ enricher })
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'n1', nodeType: 'standard' })
      await tick()

      expect(enricher.enrich).toHaveBeenCalledWith({ nodeId: 'n1' })
      expect(hook.getMetrics().enrichmentsApplied).toBe(1)
    })

    it('creates a hook with onCompleted callback', async () => {
      const onCompleted = vi.fn().mockResolvedValue(undefined)
      const hook = SelfLearningPipelineHook.createWithDefaults({ onCompleted })
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:completed', runId: 'r1', totalDurationMs: 2000 })
      await tick()

      expect(onCompleted).toHaveBeenCalledWith('r1')
    })

    it('creates a hook with no callbacks when given empty config', () => {
      const hook = SelfLearningPipelineHook.createWithDefaults({})
      expect(hook.getMetrics().nodesStarted).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Unhandled event types
  // -----------------------------------------------------------------------

  describe('unhandled event types', () => {
    it('silently ignores pipeline:started', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:started', pipelineId: 'p1', runId: 'r1' })
      await tick()

      // No crash, metrics unchanged
      const m = hook.getMetrics()
      expect(m.nodesStarted).toBe(0)
    })

    it('silently ignores pipeline:suspended', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:suspended', nodeId: 'n1' })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(0)
    })

    it('silently ignores pipeline:checkpoint_saved', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:checkpoint_saved', runId: 'r1', version: 1 })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(0)
    })

    it('silently ignores pipeline:loop_iteration', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:loop_iteration', nodeId: 'n1', iteration: 1, maxIterations: 5 })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(0)
    })

    it('silently ignores pipeline:node_retry', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, {
        type: 'pipeline:node_retry',
        nodeId: 'n1',
        attempt: 1,
        maxAttempts: 3,
        error: 'err',
        backoffMs: 1000,
      })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(0)
    })

    it('silently ignores pipeline:node_output_recorded', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_output_recorded', nodeId: 'n1', outputHash: 'abc' })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Optional callbacks (missing callbacks are no-ops)
  // -----------------------------------------------------------------------

  describe('optional callbacks', () => {
    it('handles node_started with no onBeforeNode callback', async () => {
      const hook = new SelfLearningPipelineHook({})
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'n1', nodeType: 'standard' })
      await tick()

      expect(hook.getMetrics().nodesStarted).toBe(1)
      expect(hook.getMetrics().enrichmentsApplied).toBe(0)
    })

    it('handles node_completed with no onNodeCompleted callback', async () => {
      const hook = new SelfLearningPipelineHook({})
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_completed', nodeId: 'n1', durationMs: 100 })
      await tick()

      expect(hook.getMetrics().nodesCompleted).toBe(1)
    })

    it('handles node_failed with no onNodeFailed callback', async () => {
      const hook = new SelfLearningPipelineHook({})
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_failed', nodeId: 'n1', error: 'err' })
      await tick()

      expect(hook.getMetrics().nodesFailed).toBe(1)
    })

    it('handles recovery events with no onRecovery callback', async () => {
      const hook = new SelfLearningPipelineHook({})
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:recovery_succeeded', nodeId: 'n1', attempt: 1, summary: 'ok' })
      await tick()

      expect(hook.getMetrics().recoveriesSucceeded).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    it('logs events when enableLogging is true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const hook = new SelfLearningPipelineHook({ enableLogging: true })
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'n1', nodeType: 'standard' })
      await tick()

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[SelfLearning]'),
      )
      consoleSpy.mockRestore()
    })

    it('does not log when enableLogging is false', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const hook = new SelfLearningPipelineHook({ enableLogging: false })
      const handler = hook.createEventHandler()

      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'n1', nodeType: 'standard' })
      await tick()

      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // -----------------------------------------------------------------------
  // getMetrics returns a copy
  // -----------------------------------------------------------------------

  describe('getMetrics immutability', () => {
    it('returns a copy, not a reference', async () => {
      const hook = new SelfLearningPipelineHook(config)
      const handler = hook.createEventHandler()

      const before = hook.getMetrics()
      fireEvent(handler, { type: 'pipeline:node_started', nodeId: 'a', nodeType: 'standard' })
      await tick()

      const after = hook.getMetrics()
      expect(before.nodesStarted).toBe(0)
      expect(after.nodesStarted).toBe(1)
    })
  })
})
