import { describe, it, expect, beforeEach } from 'vitest'
import { ConcreteRunHandle } from '../agent/run-handle.js'
import {
  InvalidRunStateError,
  CheckpointExpiredError,
  ForkLimitExceededError,
} from '../agent/run-handle-types.js'
import { InMemoryRunJournal } from '@dzupagent/core'

describe('ConcreteRunHandle', () => {
  let journal: InMemoryRunJournal

  beforeEach(() => {
    journal = new InMemoryRunJournal()
  })

  // ── pause ──────────────────────────────────────────────────────────────────

  it('pause on running run transitions status to paused', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    await handle.pause()
    expect(handle.currentStatus).toBe('paused')
    expect(await handle.status()).toBe('paused')
  })

  it('pause on already-paused run is a no-op', async () => {
    const handle = new ConcreteRunHandle('run-1', 'paused', journal)
    await handle.pause() // should not throw
    expect(handle.currentStatus).toBe('paused')
  })

  it('pause on terminal run throws InvalidRunStateError', async () => {
    const handle = new ConcreteRunHandle('run-1', 'completed', journal)
    await expect(handle.pause()).rejects.toThrow(InvalidRunStateError)
  })

  it('pause emits run_paused event to subscribers', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    const events: string[] = []
    handle.subscribe('run_paused', (entry) => {
      events.push(entry.type)
    })
    await handle.pause()
    expect(events).toEqual(['run_paused'])
  })

  // ── resume ─────────────────────────────────────────────────────────────────

  it('resume on paused run transitions status to running', async () => {
    const handle = new ConcreteRunHandle('run-1', 'paused', journal)
    await handle.resume(undefined, 'token-1')
    expect(handle.currentStatus).toBe('running')
  })

  it('resume on suspended run transitions status to running', async () => {
    const handle = new ConcreteRunHandle('run-1', 'suspended', journal)
    await handle.resume({ data: 'approval' }, 'token-2')
    expect(handle.currentStatus).toBe('running')
  })

  it('resume with duplicate token is a silent no-op', async () => {
    const handle = new ConcreteRunHandle('run-1', 'paused', journal)
    await handle.resume(undefined, 'dup-token')
    // Manually set back to paused to test idempotency
    handle._updateStatus('paused')
    await handle.resume(undefined, 'dup-token')
    // Should still be paused because the second resume was a no-op
    expect(handle.currentStatus).toBe('paused')
  })

  it('resume on non-paused run throws InvalidRunStateError', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    await expect(handle.resume()).rejects.toThrow(InvalidRunStateError)
  })

  it('resume on completed run throws InvalidRunStateError', async () => {
    const handle = new ConcreteRunHandle('run-1', 'completed', journal)
    await expect(handle.resume()).rejects.toThrow(InvalidRunStateError)
  })

  // ── cancel ─────────────────────────────────────────────────────────────────

  it('cancel transitions to cancelled and resolves result()', async () => {
    const handle = new ConcreteRunHandle<string>('run-1', 'running', journal)
    const resultPromise = handle.result()
    await handle.cancel('user requested')
    const result = await resultPromise
    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('user requested')
    expect(handle.currentStatus).toBe('cancelled')
  })

  it('cancel on already-terminal run is a no-op', async () => {
    const handle = new ConcreteRunHandle('run-1', 'completed', journal)
    await handle.cancel() // should not throw
    expect(handle.currentStatus).toBe('completed') // unchanged
  })

  // ── result ─────────────────────────────────────────────────────────────────

  it('result resolves when _complete is called', async () => {
    const handle = new ConcreteRunHandle<string>('run-1', 'running', journal)
    const resultPromise = handle.result()
    handle._complete('done', { durationMs: 100 })
    const result = await resultPromise
    expect(result.status).toBe('completed')
    expect(result.output).toBe('done')
    expect(result.durationMs).toBe(100)
  })

  it('result resolves when _fail is called', async () => {
    const handle = new ConcreteRunHandle<string>('run-1', 'running', journal)
    const resultPromise = handle.result()
    handle._fail('boom')
    const result = await resultPromise
    expect(result.status).toBe('failed')
    expect(result.error).toBe('boom')
  })

  it('result resolves immediately if already in terminal state', async () => {
    const handle = new ConcreteRunHandle('run-1', 'completed', journal)
    const result = await handle.result()
    expect(result.status).toBe('completed')
  })

  // ── subscribe ──────────────────────────────────────────────────────────────

  it('wildcard subscriber receives all events', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    const events: string[] = []
    handle.subscribe('*', (entry) => {
      events.push(entry.type)
    })
    await handle.pause()
    await handle.resume(undefined, 'tok-1')
    expect(events).toEqual(['run_paused', 'run_resumed'])
  })

  it('unsubscribe stops receiving events', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    const events: string[] = []
    const unsub = handle.subscribe('*', (entry) => {
      events.push(entry.type)
    })
    await handle.pause()
    unsub()
    await handle.resume(undefined, 'tok-1')
    expect(events).toEqual(['run_paused']) // only first event
  })

  // ── _updateStatus ──────────────────────────────────────────────────────────

  it('_updateStatus changes currentStatus', () => {
    const handle = new ConcreteRunHandle('run-1', 'pending', journal)
    handle._updateStatus('running')
    expect(handle.currentStatus).toBe('running')
  })

  // ── fork ───────────────────────────────────────────────────────────────────

  it('fork creates a new handle from checkpoint', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)

    // Simulate a step completion in the journal
    await journal.append('run-1', {
      type: 'step_completed',
      data: { stepId: 'step-A', toolName: 'test-tool', durationMs: 50 },
    })

    const forked = await handle.fork('step-A')
    expect(forked.runId).not.toBe('run-1')
    expect(forked.currentStatus).toBe('paused')

    // Forked journal should have entries (copied + run_started)
    const forkedEntries = await journal.getAll(forked.runId)
    expect(forkedEntries.length).toBeGreaterThan(0)
  })

  it('fork throws ForkLimitExceededError when limit is reached', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal, {
      maxForks: 1,
    })

    await journal.append('run-1', {
      type: 'step_completed',
      data: { stepId: 'step-A', toolName: 'test-tool' },
    })

    await handle.fork('step-A') // first fork OK
    await expect(handle.fork('step-A')).rejects.toThrow(ForkLimitExceededError)
  })

  it('fork throws CheckpointExpiredError when step not found', async () => {
    const handle = new ConcreteRunHandle('run-1', 'running', journal)
    await expect(handle.fork('nonexistent-step')).rejects.toThrow(CheckpointExpiredError)
  })

  // ── fromRunId ──────────────────────────────────────────────────────────────

  it('fromRunId reconstructs handle from journal', async () => {
    await journal.append('run-2', {
      type: 'run_started',
      data: { input: 'hello', agentId: 'agent-1' },
    })
    await journal.append('run-2', {
      type: 'run_paused',
      data: { reason: 'user_request' },
    })

    const handle = await ConcreteRunHandle.fromRunId('run-2', journal)
    expect(handle.runId).toBe('run-2')
    expect(handle.currentStatus).toBe('paused')
  })

  it('fromRunId throws InvalidRunStateError when run not found', async () => {
    await expect(
      ConcreteRunHandle.fromRunId('nonexistent', journal),
    ).rejects.toThrow(InvalidRunStateError)
  })

  it('fromRunId derives completed status from journal', async () => {
    await journal.append('run-3', {
      type: 'run_started',
      data: { input: null, agentId: 'a' },
    })
    await journal.append('run-3', {
      type: 'run_completed',
      data: { output: 'result' },
    })

    const handle = await ConcreteRunHandle.fromRunId('run-3', journal)
    expect(handle.currentStatus).toBe('completed')
  })

  // ── resumeFromStep ──────────────────────────────────────────────────────────

  describe('resumeFromStep', () => {
    it('happy path: creates checkpoint, resumes from it, returns new handle', async () => {
      const handle = new ConcreteRunHandle<string>('run-1', 'paused', journal)

      // Populate journal with a completed step
      await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 'step-X', toolName: 'my-tool', durationMs: 42 },
      })

      const resumed = await handle.resumeFromStep('step-X', { extra: 'data' })

      // Should return a new handle with a different runId
      expect(resumed.runId).not.toBe('run-1')
      // The new handle should be in running state
      expect(resumed.currentStatus).toBe('running')

      // The forked journal should contain copied entries + run_started + run_resumed
      const forkedEntries = await journal.getAll(resumed.runId)
      const types = forkedEntries.map((e) => e.type)
      expect(types).toContain('step_completed')
      expect(types).toContain('run_started')
      expect(types).toContain('run_resumed')

      // The run_resumed entry should have resumeFromStep metadata
      const resumeEntry = forkedEntries.find((e) => e.type === 'run_resumed')
      const resumeData = resumeEntry!.data as { input: { resumeFromStep: string; resumeInput: unknown } }
      expect(resumeData.input.resumeFromStep).toBe('step-X')
      expect(resumeData.input.resumeInput).toEqual({ extra: 'data' })
    })

    it('throws CheckpointExpiredError if stepId not found in journal', async () => {
      const handle = new ConcreteRunHandle('run-1', 'paused', journal)

      // Journal has no step_completed entries
      await expect(handle.resumeFromStep('nonexistent-step')).rejects.toThrow(
        CheckpointExpiredError,
      )
    })

    it('throws InvalidRunStateError if run is currently running', async () => {
      const handle = new ConcreteRunHandle('run-1', 'running', journal)

      await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 'step-A', toolName: 'tool-a' },
      })

      await expect(handle.resumeFromStep('step-A')).rejects.toThrow(
        InvalidRunStateError,
      )
    })
  })

  // ── getCheckpoints ────────────────────────────────────────────────────────

  describe('getCheckpoints', () => {
    it('returns empty array when no step_completed entries exist', async () => {
      const handle = new ConcreteRunHandle('run-1', 'running', journal)

      // Journal has no entries at all
      const checkpoints = await handle.getCheckpoints()
      expect(checkpoints).toEqual([])
    })

    it('returns list of CheckpointInfo for all step_completed journal entries', async () => {
      const handle = new ConcreteRunHandle('run-1', 'running', journal)

      await journal.append('run-1', {
        type: 'run_started',
        data: { input: null, agentId: 'a1' },
      })
      await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 'step-1', toolName: 'tool-alpha' },
      })
      await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 'step-2', toolName: 'tool-beta' },
      })
      await journal.append('run-1', {
        type: 'run_paused',
        data: { reason: 'user_request' },
      })

      const checkpoints = await handle.getCheckpoints()

      // Should only return the 2 step_completed entries, not the other types
      expect(checkpoints).toHaveLength(2)
      expect(checkpoints[0]!.stepId).toBe('step-1')
      expect(checkpoints[1]!.stepId).toBe('step-2')
    })

    it('returns correct stepId, stepName, completedAt, and entrySeq fields', async () => {
      const handle = new ConcreteRunHandle('run-1', 'running', journal)

      const seq = await journal.append('run-1', {
        type: 'step_completed',
        data: { stepId: 'step-abc', toolName: 'fancy-tool' },
      })

      const checkpoints = await handle.getCheckpoints()
      expect(checkpoints).toHaveLength(1)

      const cp = checkpoints[0]!
      expect(cp.stepId).toBe('step-abc')
      expect(cp.stepName).toBe('fancy-tool')
      expect(cp.completedAt).toBeInstanceOf(Date)
      expect(cp.entrySeq).toBe(seq)

      // completedAt should be a recent date (within the last second)
      const now = Date.now()
      expect(cp.completedAt.getTime()).toBeGreaterThan(now - 1000)
      expect(cp.completedAt.getTime()).toBeLessThanOrEqual(now + 100)
    })
  })
})
