/**
 * Integration tests for the durable approval gate and workflow onError edges.
 *
 * Covers MC-03:
 *   - approval state survives a process restart via the checkpoint store
 *   - resume() emits the appropriate decision event and clears state
 *   - WorkflowBuilder.onError() routes to a recovery sub-graph on match
 */
import { describe, it, expect } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { ApprovalGate } from '../approval/approval-gate.js'
import { ApprovalSuspendedError } from '../approval/approval-errors.js'
import {
  APPROVAL_PENDING_KEY,
  type ApprovalCheckpointStore,
  type ApprovalPendingState,
} from '../approval/approval-types.js'
import { createWorkflow } from '../workflow/workflow-builder.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'

class InMemoryApprovalCheckpointStore implements ApprovalCheckpointStore {
  private readonly map = new Map<string, ApprovalPendingState>()
  private static key(runId: string, key: string): string {
    return `${runId}::${key}`
  }
  async save(runId: string, key: string, state: ApprovalPendingState): Promise<void> {
    this.map.set(InMemoryApprovalCheckpointStore.key(runId, key), state)
  }
  async load(runId: string, key: string): Promise<ApprovalPendingState | null> {
    return this.map.get(InMemoryApprovalCheckpointStore.key(runId, key)) ?? null
  }
  async delete(runId: string, key: string): Promise<void> {
    this.map.delete(InMemoryApprovalCheckpointStore.key(runId, key))
  }
}

describe('durable approval gate', () => {
  it('persists pending state and resumes after a simulated restart', async () => {
    const checkpointStore = new InMemoryApprovalCheckpointStore()
    const bus = createEventBus()
    const granted: unknown[] = []
    bus.on('approval:granted', (e) => granted.push(e))

    const gate = new ApprovalGate(
      { mode: 'required', durableResume: true, checkpointStore },
      bus,
    )

    let resumeToken: string | undefined
    let runId: string | undefined
    try {
      await gate.requestApproval({ runId: 'run-1', plan: 'do X' })
      throw new Error('expected ApprovalSuspendedError')
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalSuspendedError)
      resumeToken = (err as ApprovalSuspendedError).resumeToken
      runId = (err as ApprovalSuspendedError).runId
    }
    expect(resumeToken).toBeDefined()
    expect(runId).toBe('run-1')

    // Pending state was persisted.
    const state = await checkpointStore.load('run-1', APPROVAL_PENDING_KEY)
    expect(state).not.toBeNull()
    expect(state!.resumeToken).toBe(resumeToken)
    expect(state!.runId).toBe('run-1')
    expect(state!.plan).toBe('do X')

    // Simulate restart -- new gate instance, same store.
    const bus2 = createEventBus()
    const granted2: unknown[] = []
    bus2.on('approval:granted', (e) => granted2.push(e))
    const gate2 = new ApprovalGate(
      { mode: 'required', durableResume: true, checkpointStore },
      bus2,
    )

    await gate2.resume('run-1', { decision: 'approved' })
    expect(granted2).toHaveLength(1)
    expect(granted2[0]).toMatchObject({ type: 'approval:granted', runId: 'run-1' })

    // Pending state was cleared.
    const after = await checkpointStore.load('run-1', APPROVAL_PENDING_KEY)
    expect(after).toBeNull()
  })

  it('emits approval:rejected with reason when resumed with rejection', async () => {
    const checkpointStore = new InMemoryApprovalCheckpointStore()
    const bus = createEventBus()
    const rejected: unknown[] = []
    bus.on('approval:rejected', (e) => rejected.push(e))

    const gate = new ApprovalGate(
      { mode: 'required', durableResume: true, checkpointStore },
      bus,
    )

    await expect(
      gate.requestApproval({ runId: 'run-2', plan: 'maybe' }),
    ).rejects.toBeInstanceOf(ApprovalSuspendedError)

    await gate.resume('run-2', { decision: 'rejected', reason: 'too risky' })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      type: 'approval:rejected',
      runId: 'run-2',
      reason: 'too risky',
    })
  })

  it('throws when resuming a runId with no pending approval', async () => {
    const checkpointStore = new InMemoryApprovalCheckpointStore()
    const bus = createEventBus()
    const gate = new ApprovalGate(
      { mode: 'required', durableResume: true, checkpointStore },
      bus,
    )
    await expect(gate.resume('missing', { decision: 'approved' })).rejects.toThrow(
      /No pending approval for runId/,
    )
  })

  it('falls back to the legacy in-process wait without a checkpoint store', async () => {
    const bus = createEventBus()
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, bus)
    // No store + no durableResume = legacy path; should NOT throw.
    const result = await gate.requestApproval({ runId: 'run-3', plan: 'p' })
    // Times out because no resolver.
    expect(result).toBe('timeout')
  })
})

describe('workflow onError', () => {
  function step(
    id: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): WorkflowStep {
    return { id, execute: async (input) => fn(input as Record<string, unknown>) }
  }

  function failingStep(id: string, message: string): WorkflowStep {
    return {
      id,
      execute: async () => {
        throw new Error(message)
      },
    }
  }

  it('routes to a recovery sub-graph on a matching error', async () => {
    const workflow = createWorkflow({ id: 'recover-network' })
      .then(failingStep('fail', 'network error: connection reset'))
      .onError((err) => err.message.includes('network'), [
        step('recover', () => ({ recovered: true })),
      ])
      .build()

    const result = await workflow.run({})
    expect(result['recovered']).toBe(true)
    // The error is exposed as a serializable view in state.
    const errView = result['error'] as { message?: string } | undefined
    expect(errView?.message).toContain('network error')
  })

  it('re-throws when no handler matches', async () => {
    const workflow = createWorkflow({ id: 'no-match' })
      .then(failingStep('fail', 'auth error'))
      .onError((err) => err.message.includes('network'), [
        step('recover', () => ({ recovered: true })),
      ])
      .build()

    await expect(workflow.run({})).rejects.toThrow()
  })

  it('continues subsequent steps after recovery', async () => {
    const workflow = createWorkflow({ id: 'continue-after-recovery' })
      .then(failingStep('fail', 'transient: timeout'))
      .onError((err) => err.message.includes('transient'), [
        step('recover', () => ({ recovered: true })),
      ])
      .then(step('downstream', (s) => ({ downstream: s['recovered'] === true })))
      .build()

    const result = await workflow.run({})
    expect(result['recovered']).toBe(true)
    expect(result['downstream']).toBe(true)
  })
})
