/**
 * Branch-coverage tests for ConcreteRunHandle - specifically terminal-state
 * branches in result() (failed, cancelled) and helper behaviors.
 */
import { describe, it, expect } from 'vitest'
import { ConcreteRunHandle } from '../agent/run-handle.js'
import { InMemoryRunJournal } from '@dzupagent/core'

describe('ConcreteRunHandle — terminal state branches', () => {
  it('result resolves immediately when initial status is "failed"', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('run-f', 'failed', journal)
    const result = await handle.result()
    expect(result.status).toBe('failed')
    expect(result.runId).toBe('run-f')
  })

  it('result resolves immediately when initial status is "cancelled"', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('run-c', 'cancelled', journal)
    const result = await handle.result()
    expect(result.status).toBe('cancelled')
  })

  it('result resolves immediately when initial status is "completed"', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('run-x', 'completed', journal)
    const result = await handle.result()
    expect(result.status).toBe('completed')
  })

  it('result returns same resolved value on subsequent calls', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('run-1', 'completed', journal)
    const r1 = await handle.result()
    const r2 = await handle.result()
    expect(r1).toBe(r2)
  })

  it('pause throws InvalidRunStateError when status is "completed"', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('r', 'completed', journal)
    await expect(handle.pause()).rejects.toThrow(/expected 'running'/i)
  })

  it('pause is a no-op when already paused', async () => {
    const journal = new InMemoryRunJournal()
    const handle = new ConcreteRunHandle('r', 'paused', journal)
    await expect(handle.pause()).resolves.toBeUndefined()
  })
})
