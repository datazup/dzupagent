import { describe, it, expect } from 'vitest'
import { InMemoryRunStore } from '../persistence/in-memory-run-store.js'
import type { RunRecord } from '../persistence/run-store.js'

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    providerId: 'claude',
    status: 'running',
    prompt: 'test prompt',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('InMemoryRunStore', () => {
  it('creates and retrieves a run', async () => {
    const store = new InMemoryRunStore()
    const run = makeRun()
    await store.createRun(run)
    const retrieved = await store.getRun(run.id)
    expect(retrieved?.prompt).toBe('test prompt')
  })

  it('updates a run', async () => {
    const store = new InMemoryRunStore()
    const run = makeRun()
    await store.createRun(run)
    await store.updateRun(run.id, { status: 'completed', result: 'done' })
    const updated = await store.getRun(run.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.result).toBe('done')
  })

  it('lists runs with filters', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'a', status: 'completed', providerId: 'claude', createdAt: 100 }))
    await store.createRun(makeRun({ id: 'b', status: 'failed', providerId: 'codex', createdAt: 200 }))
    await store.createRun(makeRun({ id: 'c', status: 'completed', providerId: 'claude', createdAt: 300 }))

    const completed = await store.listRuns({ status: 'completed' })
    expect(completed).toHaveLength(2)

    const claude = await store.listRuns({ providerId: 'claude' })
    expect(claude).toHaveLength(2)

    const limited = await store.listRuns({ limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('stores and retrieves events', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'run-1' }))
    await store.storeEvent('run-1', { id: 'e1', runId: 'run-1', type: 'started', data: {}, timestamp: 1 })
    await store.storeEvent('run-1', { id: 'e2', runId: 'run-1', type: 'completed', data: {}, timestamp: 2 })

    const events = await store.getEvents('run-1')
    expect(events).toHaveLength(2)

    const limited = await store.getEvents('run-1', { limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('deletes a run and its events', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'run-1' }))
    await store.storeEvent('run-1', { id: 'e1', runId: 'run-1', type: 'x', data: {}, timestamp: 1 })

    expect(await store.deleteRun('run-1')).toBe(true)
    expect(await store.getRun('run-1')).toBeUndefined()
    expect(await store.getEvents('run-1')).toEqual([])
    expect(await store.deleteRun('nonexistent')).toBe(false)
  })

  it('filters by time range', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'a', createdAt: 100 }))
    await store.createRun(makeRun({ id: 'b', createdAt: 200 }))
    await store.createRun(makeRun({ id: 'c', createdAt: 300 }))

    const result = await store.listRuns({ since: 150, until: 250 })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('b')
  })

  it('filters by tags', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'a', tags: ['code', 'review'] }))
    await store.createRun(makeRun({ id: 'b', tags: ['research'] }))

    const result = await store.listRuns({ tags: ['code'] })
    expect(result).toHaveLength(1)
  })

  it('filters by correlationId', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'a', correlationId: 'req-123' }))
    await store.createRun(makeRun({ id: 'b', correlationId: 'req-456' }))

    const result = await store.listRuns({ correlationId: 'req-123' })
    expect(result).toHaveLength(1)
  })

  it('sorts by createdAt descending', async () => {
    const store = new InMemoryRunStore()
    await store.createRun(makeRun({ id: 'old', createdAt: 100 }))
    await store.createRun(makeRun({ id: 'new', createdAt: 300 }))
    await store.createRun(makeRun({ id: 'mid', createdAt: 200 }))

    const runs = await store.listRuns()
    expect(runs.map(r => r.id)).toEqual(['new', 'mid', 'old'])
  })
})
