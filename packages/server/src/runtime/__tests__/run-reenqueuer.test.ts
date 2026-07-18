/**
 * Unit A — buildRunReEnqueuer.
 *
 * The reclaimer's host-provided `reEnqueueRun` seam. Given a runId, it loads
 * the run, refuses to resurrect a terminal run, and otherwise puts it back on
 * the queue so a live worker resumes it.
 */
import { describe, it, expect, vi } from 'vitest'
import type { RunStatus } from '@dzupagent/core/persistence'

import { buildRunReEnqueuer, isTerminalRunStatus } from '../run-reenqueuer.js'

function makeRun(
  overrides: Partial<{
    id: string
    agentId: string
    status: RunStatus
    input: unknown
    metadata?: Record<string, unknown>
    tenantId?: string | null
  }> = {}
) {
  return {
    id: overrides.id ?? 'run-1',
    agentId: overrides.agentId ?? 'agent-1',
    status: overrides.status ?? ('running' as RunStatus),
    input: overrides.input ?? { foo: 'bar' },
    metadata: overrides.metadata,
    tenantId: overrides.tenantId,
    startedAt: new Date(),
  }
}

describe('buildRunReEnqueuer', () => {
  it('enqueues a non-terminal run with fields drawn from the run', async () => {
    const run = makeRun({
      id: 'run-42',
      agentId: 'agent-7',
      status: 'running',
      input: { task: 'resume me' },
      metadata: { tenant: 't1' },
    })
    const get = vi.fn().mockResolvedValue(run)
    const enqueue = vi.fn().mockResolvedValue(undefined)

    const reEnqueue = buildRunReEnqueuer({
      runStore: { get },
      runQueue: { enqueue },
    })

    await reEnqueue('run-42')

    expect(get).toHaveBeenCalledWith('run-42')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith({
      runId: 'run-42',
      agentId: 'agent-7',
      input: { task: 'resume me' },
      metadata: { tenant: 't1' },
      priority: 0,
    })
  })

  it('preserves queue-level tenant scope when re-enqueuing a stale running run', async () => {
    const run = makeRun({
      id: 'run-tenant',
      agentId: 'agent-tenant',
      status: 'running',
      input: { task: 'resume tenant run' },
      metadata: { tenantId: 'tenant-a' },
      tenantId: 'tenant-a',
    })
    const get = vi.fn().mockResolvedValue(run)
    const enqueue = vi.fn().mockResolvedValue(undefined)

    const reEnqueue = buildRunReEnqueuer({
      runStore: { get },
      runQueue: { enqueue },
    })

    await reEnqueue('run-tenant')

    expect(enqueue).toHaveBeenCalledWith({
      runId: 'run-tenant',
      agentId: 'agent-tenant',
      input: { task: 'resume tenant run' },
      metadata: { tenantId: 'tenant-a' },
      tenantId: 'tenant-a',
      priority: 0,
    })
  })

  it('skips (no enqueue, no throw) when the run is not found', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const onSkip = vi.fn()

    const reEnqueue = buildRunReEnqueuer({
      runStore: { get },
      runQueue: { enqueue },
      onSkip,
    })

    await expect(reEnqueue('missing')).resolves.toBeUndefined()

    expect(enqueue).not.toHaveBeenCalled()
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onSkip).toHaveBeenCalledWith('missing', 'not_found')
  })

  it.each<RunStatus>([
    'completed',
    'failed',
    'cancelled',
    'rejected',
    'halted',
  ])('skips a terminal run (%s) without enqueuing', async (status) => {
    const run = makeRun({ id: 'run-term', status })
    const get = vi.fn().mockResolvedValue(run)
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const onSkip = vi.fn()

    const reEnqueue = buildRunReEnqueuer({
      runStore: { get },
      runQueue: { enqueue },
      onSkip,
    })

    await reEnqueue('run-term')

    expect(enqueue).not.toHaveBeenCalled()
    expect(onSkip).toHaveBeenCalledWith('run-term', 'terminal')
  })

  it('passes a custom priority through to enqueue', async () => {
    const run = makeRun({ id: 'run-p', status: 'queued' })
    const get = vi.fn().mockResolvedValue(run)
    const enqueue = vi.fn().mockResolvedValue(undefined)

    const reEnqueue = buildRunReEnqueuer({
      runStore: { get },
      runQueue: { enqueue },
      priority: 5,
    })

    await reEnqueue('run-p')

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-p', priority: 5 })
    )
  })
})

describe('isTerminalRunStatus', () => {
  it.each<RunStatus>([
    'completed',
    'halted',
    'failed',
    'rejected',
    'cancelled',
  ])('returns true for terminal status %s', (status) => {
    expect(isTerminalRunStatus(status)).toBe(true)
  })

  it.each<RunStatus>(['running', 'queued'])(
    'returns false for non-terminal status %s',
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(false)
    }
  )
})
