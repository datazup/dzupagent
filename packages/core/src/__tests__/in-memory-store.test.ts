import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryRunStore, InMemoryAgentStore } from '../persistence/in-memory-store.js'

describe('InMemoryRunStore', () => {
  let store: InMemoryRunStore

  beforeEach(() => {
    store = new InMemoryRunStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a run with generated id', async () => {
    const run = await store.create({ agentId: 'agent-1', input: { task: 'test' } })
    expect(run.id).toBeTruthy()
    expect(run.agentId).toBe('agent-1')
    expect(run.status).toBe('queued')
    expect(run.input).toEqual({ task: 'test' })
    expect(run.startedAt).toBeInstanceOf(Date)
  })

  it('gets a run by id', async () => {
    const created = await store.create({ agentId: 'a1', input: 'hi' })
    const found = await store.get(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
  })

  it('returns null for unknown id', async () => {
    const found = await store.get('nonexistent')
    expect(found).toBeNull()
  })

  it('updates run fields', async () => {
    const run = await store.create({ agentId: 'a1', input: 'test' })
    await store.update(run.id, { status: 'running' })
    const updated = await store.get(run.id)
    expect(updated!.status).toBe('running')
  })

  it('lists runs sorted by startedAt descending', async () => {
    const r1 = await store.create({ agentId: 'a1', input: '1' })
    const r2 = await store.create({ agentId: 'a2', input: '2' })
    const r3 = await store.create({ agentId: 'a1', input: '3' })

    // Ensure distinct timestamps for deterministic ordering
    await store.update(r1.id, { startedAt: new Date('2026-01-01T00:00:00Z') })
    await store.update(r2.id, { startedAt: new Date('2026-01-02T00:00:00Z') })
    await store.update(r3.id, { startedAt: new Date('2026-01-03T00:00:00Z') })

    const all = await store.list()
    expect(all).toHaveLength(3)
    // Most recent first
    expect(all[0]!.input).toBe('3')
    expect(all[2]!.input).toBe('1')
  })

  it('filters by agentId', async () => {
    await store.create({ agentId: 'a1', input: '1' })
    await store.create({ agentId: 'a2', input: '2' })
    await store.create({ agentId: 'a1', input: '3' })

    const filtered = await store.list({ agentId: 'a1' })
    expect(filtered).toHaveLength(2)
    expect(filtered.every(r => r.agentId === 'a1')).toBe(true)
  })

  it('filters by status', async () => {
    const run = await store.create({ agentId: 'a1', input: '1' })
    await store.update(run.id, { status: 'completed' })
    await store.create({ agentId: 'a1', input: '2' })

    const completed = await store.list({ status: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]!.status).toBe('completed')
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await store.create({ agentId: 'a1', input: `task-${i}` })
    }
    const page = await store.list({ limit: 3, offset: 2 })
    expect(page).toHaveLength(3)
  })

  it('adds and retrieves logs', async () => {
    const run = await store.create({ agentId: 'a1', input: 'test' })
    await store.addLog(run.id, { level: 'info', message: 'Starting', phase: 'init' })
    await store.addLog(run.id, { level: 'error', message: 'Failed', phase: 'gen' })

    const logs = await store.getLogs(run.id)
    expect(logs).toHaveLength(2)
    expect(logs[0]!.message).toBe('Starting')
    expect(logs[0]!.timestamp).toBeInstanceOf(Date)
    expect(logs[1]!.level).toBe('error')
  })

  it('clear() removes all data', async () => {
    await store.create({ agentId: 'a1', input: 'test' })
    store.clear()
    const all = await store.list()
    expect(all).toHaveLength(0)
  })

  it('enforces maxRuns retention when configured', async () => {
    const limited = new InMemoryRunStore({ maxRuns: 2 })
    const r1 = await limited.create({ agentId: 'a1', input: 'one' })
    const r2 = await limited.create({ agentId: 'a1', input: 'two' })
    const r3 = await limited.create({ agentId: 'a1', input: 'three' })

    expect(await limited.get(r1.id)).toBeNull()
    expect(await limited.get(r2.id)).not.toBeNull()
    expect(await limited.get(r3.id)).not.toBeNull()
  })

  it('enforces maxLogsPerRun retention when configured', async () => {
    const limited = new InMemoryRunStore({ maxLogsPerRun: 2 })
    const run = await limited.create({ agentId: 'a1', input: 'test' })

    await limited.addLog(run.id, { level: 'info', message: 'log-1' })
    await limited.addLog(run.id, { level: 'info', message: 'log-2' })
    await limited.addLog(run.id, { level: 'info', message: 'log-3' })

    const logs = await limited.getLogs(run.id)
    expect(logs).toHaveLength(2)
    expect(logs[0]!.message).toBe('log-2')
    expect(logs[1]!.message).toBe('log-3')
  })

  it('uses finite default retention limits', () => {
    expect(store.getRetentionLimits()).toEqual({
      maxRuns: 10_000,
      maxLogsPerRun: 1_000,
    })
  })

  it('preserves explicit unbounded opt-out and warns once per opt-out field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unbounded = new InMemoryRunStore({
      maxRuns: Number.POSITIVE_INFINITY,
      maxLogsPerRun: Number.POSITIVE_INFINITY,
    })

    const runIds: string[] = []
    for (let index = 0; index < 3; index++) {
      const run = await unbounded.create({ agentId: 'agent', input: `task-${index}` })
      runIds.push(run.id)
    }

    for (let index = 0; index < 3; index++) {
      await unbounded.addLog(runIds[0]!, { level: 'info', message: `log-${index}` })
    }

    expect(unbounded.getRetentionLimits()).toEqual({
      maxRuns: Number.POSITIVE_INFINITY,
      maxLogsPerRun: Number.POSITIVE_INFINITY,
    })
    await expect(Promise.all(runIds.map((id) => unbounded.get(id)))).resolves.toEqual([
      expect.objectContaining({ id: runIds[0] }),
      expect.objectContaining({ id: runIds[1] }),
      expect.objectContaining({ id: runIds[2] }),
    ])
    await expect(unbounded.getLogs(runIds[0]!)).resolves.toHaveLength(3)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('InMemoryAgentStore', () => {
  let store: InMemoryAgentStore

  beforeEach(() => {
    store = new InMemoryAgentStore()
  })

  it('saves and retrieves an agent', async () => {
    await store.save({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'You are a test agent',
      modelTier: 'chat',
    })
    const agent = await store.get('agent-1')
    expect(agent).not.toBeNull()
    expect(agent!.name).toBe('Test Agent')
    expect(agent!.updatedAt).toBeInstanceOf(Date)
  })

  it('returns null for unknown agent', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('lists all agents', async () => {
    await store.save({ id: 'a1', name: 'A1', instructions: 'i1', modelTier: 'chat', active: true })
    await store.save({ id: 'a2', name: 'A2', instructions: 'i2', modelTier: 'codegen', active: false })

    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('filters by active status', async () => {
    await store.save({ id: 'a1', name: 'A1', instructions: 'i1', modelTier: 'chat', active: true })
    await store.save({ id: 'a2', name: 'A2', instructions: 'i2', modelTier: 'codegen', active: false })

    const active = await store.list({ active: true })
    expect(active).toHaveLength(1)
    expect(active[0]!.id).toBe('a1')
  })

  it('deletes an agent', async () => {
    await store.save({ id: 'a1', name: 'A1', instructions: 'i1', modelTier: 'chat' })
    await store.delete('a1')
    expect(await store.get('a1')).toBeNull()
  })
})
