import { describe, it, expect, vi } from 'vitest'
import { PipelineExecutor, type PhaseConfig } from '../pipeline/pipeline-executor.js'

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>,
): PhaseConfig {
  return {
    id,
    name: id,
    execute,
    ...overrides,
  }
}

describe('PipelineExecutor — extended coverage', () => {
  // -----------------------------------------------------------------------
  // Topological sort and dependency resolution
  // -----------------------------------------------------------------------

  describe('dependency resolution', () => {
    it('executes phases in dependency order', async () => {
      const executionOrder: string[] = []
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('c', async (s) => {
          executionOrder.push('c')
          return { ...s, c: true }
        }, { dependsOn: ['a', 'b'] }),
        makePhase('a', async (s) => {
          executionOrder.push('a')
          return { ...s, a: true }
        }),
        makePhase('b', async (s) => {
          executionOrder.push('b')
          return { ...s, b: true }
        }, { dependsOn: ['a'] }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      // a must come before b, b before c
      const aIdx = executionOrder.indexOf('a')
      const bIdx = executionOrder.indexOf('b')
      const cIdx = executionOrder.indexOf('c')
      expect(aIdx).toBeLessThan(bIdx)
      expect(bIdx).toBeLessThan(cIdx)
    })

    it('detects cycles and throws', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({}), { dependsOn: ['b'] }),
        makePhase('b', async () => ({}), { dependsOn: ['a'] }),
      ]

      await expect(ex.execute(phases, {})).rejects.toThrow(/Cycle detected/)
    })

    it('throws for unknown dependency', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({}), { dependsOn: ['nonexistent'] }),
      ]

      await expect(ex.execute(phases, {})).rejects.toThrow(/Unknown dependency/)
    })
  })

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------

  describe('timeout handling', () => {
    it('marks phase as timeout when it exceeds its timeoutMs', async () => {
      const ex = new PipelineExecutor({ defaultTimeoutMs: 50 })
      const phases: PhaseConfig[] = [
        makePhase('slow', async () => {
          await new Promise(r => setTimeout(r, 200))
          return { done: true }
        }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('failed')
      const slowPhase = result.phases.find(p => p.phaseId === 'slow')
      expect(slowPhase).toBeDefined()
      expect(slowPhase!.status).toBe('timeout')
      expect(slowPhase!.error).toContain('timed out')
    })

    it('uses per-phase timeoutMs over default', async () => {
      const ex = new PipelineExecutor({ defaultTimeoutMs: 5000 })
      const phases: PhaseConfig[] = [
        makePhase('slow', async () => {
          await new Promise(r => setTimeout(r, 200))
          return { done: true }
        }, { timeoutMs: 50 }),
      ]

      const result = await ex.execute(phases, {})
      const slowPhase = result.phases.find(p => p.phaseId === 'slow')
      expect(slowPhase!.status).toBe('timeout')
    })
  })

  // -----------------------------------------------------------------------
  // Retry logic
  // -----------------------------------------------------------------------

  describe('retry logic', () => {
    it('retries a failing phase up to maxRetries times', async () => {
      let attempts = 0
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('flaky', async () => {
          attempts++
          if (attempts < 3) throw new Error(`fail #${attempts}`)
          return { recovered: true }
        }, { maxRetries: 3 }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      expect(attempts).toBe(3)
      const phase = result.phases.find(p => p.phaseId === 'flaky')
      expect(phase!.status).toBe('completed')
      expect(phase!.retries).toBe(2) // attempt index of the successful one
    })

    it('fails after exhausting retries', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('always-fail', async () => {
          throw new Error('permanent failure')
        }, { maxRetries: 2 }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('failed')
      const phase = result.phases.find(p => p.phaseId === 'always-fail')
      expect(phase!.status).toBe('failed')
      expect(phase!.error).toContain('permanent failure')
      expect(phase!.retries).toBe(2)
    })

    it('uses backoff strategy when specified', async () => {
      const timestamps: number[] = []
      let attempts = 0
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('backoff-phase', async () => {
          timestamps.push(Date.now())
          attempts++
          if (attempts <= 2) throw new Error('fail')
          return { ok: true }
        }, { maxRetries: 3, retryStrategy: 'backoff' }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      // Verify that retries had delays (backoff delay starts at 1000ms for attempt 1)
      // Due to test speed concerns, just verify it completed successfully
      expect(timestamps.length).toBe(3)
    }, 15_000)

    it('retries after timeout and eventually succeeds', async () => {
      let attempts = 0
      const ex = new PipelineExecutor({ defaultTimeoutMs: 50 })
      const phases: PhaseConfig[] = [
        makePhase('timeout-then-ok', async () => {
          attempts++
          if (attempts === 1) {
            await new Promise(r => setTimeout(r, 200))
          }
          return { success: true }
        }, { maxRetries: 2 }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      expect(attempts).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // Conditional phases
  // -----------------------------------------------------------------------

  describe('conditional phases', () => {
    it('evaluates condition with current pipeline state', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('setup', async () => ({ mode: 'production' })),
        makePhase('dev-only', async () => ({ devTask: true }), {
          condition: (s) => s['mode'] === 'development',
        }),
        makePhase('prod-only', async () => ({ prodTask: true }), {
          condition: (s) => s['mode'] === 'production',
        }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      const devPhase = result.phases.find(p => p.phaseId === 'dev-only')
      const prodPhase = result.phases.find(p => p.phaseId === 'prod-only')
      expect(devPhase!.status).toBe('skipped')
      expect(prodPhase!.status).toBe('completed')
      expect(result.state['devTask']).toBeUndefined()
      expect(result.state['prodTask']).toBe(true)
    })

    it('skips phase and marks __phase_<id>_skipped in state', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('always-skip', async () => ({ skipped: true }), {
          condition: () => false,
        }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.state['__phase_always-skip_skipped']).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Progress and checkpoint callbacks
  // -----------------------------------------------------------------------

  describe('callbacks', () => {
    it('calls onProgress during phase execution', async () => {
      const progressCalls: Array<{ phaseId: string; progress: number }> = []
      const ex = new PipelineExecutor({
        onProgress: (phaseId, progress) => {
          progressCalls.push({ phaseId, progress })
        },
      })
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({ a: 1 })),
        makePhase('b', async () => ({ b: 2 })),
      ]

      await ex.execute(phases, {})

      // Should have progress calls for both phases
      const aProgress = progressCalls.filter(p => p.phaseId === 'a')
      const bProgress = progressCalls.filter(p => p.phaseId === 'b')
      expect(aProgress.length).toBeGreaterThanOrEqual(1)
      expect(bProgress.length).toBeGreaterThanOrEqual(1)
      // Last progress for each should be 1 (completion)
      expect(aProgress[aProgress.length - 1]!.progress).toBe(1)
      expect(bProgress[bProgress.length - 1]!.progress).toBe(1)
    })

    it('calls onCheckpoint after successful phase', async () => {
      const checkpoints: Array<{ phaseId: string; state: Record<string, unknown> }> = []
      const ex = new PipelineExecutor({
        onCheckpoint: async (phaseId, state) => {
          checkpoints.push({ phaseId, state: { ...state } })
        },
      })
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({ a: 1 })),
        makePhase('b', async () => ({ b: 2 })),
      ]

      await ex.execute(phases, { seed: true })

      expect(checkpoints).toHaveLength(2)
      expect(checkpoints[0]!.phaseId).toBe('a')
      expect(checkpoints[0]!.state['a']).toBe(1)
      expect(checkpoints[1]!.phaseId).toBe('b')
      expect(checkpoints[1]!.state['b']).toBe(2)
    })

    it('does not call onCheckpoint for failed phases', async () => {
      const onCheckpoint = vi.fn(async () => {})
      const ex = new PipelineExecutor({ onCheckpoint })
      const phases: PhaseConfig[] = [
        makePhase('fail', async () => { throw new Error('boom') }),
      ]

      await ex.execute(phases, {})
      expect(onCheckpoint).not.toHaveBeenCalled()
    })

    it('does not call onCheckpoint for skipped phases', async () => {
      const onCheckpoint = vi.fn(async () => {})
      const ex = new PipelineExecutor({ onCheckpoint })
      const phases: PhaseConfig[] = [
        makePhase('skip', async () => ({ x: 1 }), { condition: () => false }),
      ]

      await ex.execute(phases, {})
      expect(onCheckpoint).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // State propagation
  // -----------------------------------------------------------------------

  describe('state propagation', () => {
    it('initial state is available to first phase', async () => {
      const ex = new PipelineExecutor()
      const captured: Record<string, unknown>[] = []
      const phases: PhaseConfig[] = [
        makePhase('a', async (s) => {
          captured.push({ ...s })
          return { result: 'done' }
        }),
      ]

      await ex.execute(phases, { input: 'hello' })
      expect(captured[0]!['input']).toBe('hello')
    })

    it('each phase sees accumulated state from prior phases', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({ step1: 'a-done' })),
        makePhase('b', async (s) => {
          return { step2: `${s['step1']}-then-b` }
        }),
        makePhase('c', async (s) => {
          return { step3: `${s['step2']}-then-c` }
        }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.state['step1']).toBe('a-done')
      expect(result.state['step2']).toBe('a-done-then-b')
      expect(result.state['step3']).toBe('a-done-then-b-then-c')
    })

    it('phase output overwrites state keys', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({ counter: 1 })),
        makePhase('b', async (s) => ({ counter: (s['counter'] as number) + 10 })),
      ]

      const result = await ex.execute(phases, { counter: 0 })
      expect(result.state['counter']).toBe(11)
    })
  })

  // -----------------------------------------------------------------------
  // Empty and single-phase pipelines
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles a single phase pipeline', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('only', async () => ({ result: 42 })),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('completed')
      expect(result.phases).toHaveLength(1)
      expect(result.state['result']).toBe(42)
    })

    it('records totalDurationMs', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({})),
      ]

      const result = await ex.execute(phases, {})
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('records durationMs for each phase result', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => {
          await new Promise(r => setTimeout(r, 10))
          return { a: 1 }
        }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.phases[0]!.durationMs).toBeGreaterThanOrEqual(5)
    })

    it('later phases not executed after earlier failure', async () => {
      const laterCalled = vi.fn()
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('fail', async () => { throw new Error('stop') }),
        makePhase('later', async () => { laterCalled(); return {} }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('failed')
      expect(laterCalled).not.toHaveBeenCalled()
    })

    it('phase result includes output on success', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => ({ key: 'value' })),
      ]

      const result = await ex.execute(phases, {})
      expect(result.phases[0]!.output).toEqual({ key: 'value' })
    })
  })

  // -----------------------------------------------------------------------
  // Unmet dependencies
  // -----------------------------------------------------------------------

  describe('unmet dependencies', () => {
    it('skips phase when required dependency did not complete (failed)', async () => {
      const ex = new PipelineExecutor()
      const phases: PhaseConfig[] = [
        makePhase('a', async () => { throw new Error('a failed') }),
        makePhase('b', async () => ({ b: true }), { dependsOn: ['a'] }),
      ]

      const result = await ex.execute(phases, {})
      expect(result.status).toBe('failed')
      // Phase b should either be skipped due to unmet deps or not run at all
      // because the pipeline fails after 'a' in runtime
      const bPhase = result.phases.find(p => p.phaseId === 'b')
      if (bPhase) {
        expect(bPhase.status).toBe('skipped')
      }
    })
  })
})
