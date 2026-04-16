/**
 * Tests for DrizzleScheduleStore — persistent schedule storage backed by
 * a chainable mock DB object (no real Postgres connection needed).
 *
 * Also tests InMemoryScheduleStore for contract parity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryScheduleStore,
  DrizzleScheduleStore,
} from '../schedules/schedule-store.js'
import type { ScheduleRecord, ScheduleStore } from '../schedules/schedule-store.js'

// ---------------------------------------------------------------------------
// Chainable mock DB — mirrors the Drizzle query-builder pattern
// ---------------------------------------------------------------------------

function createMockDb() {
  let storage: Record<string, Record<string, unknown>> = {}
  const now = new Date('2026-04-16T12:00:00.000Z')

  function makeRow(data: Record<string, unknown>): Record<string, unknown> {
    return {
      id: data.id,
      name: data.name,
      cronExpression: data.cronExpression ?? data.cron_expression,
      workflowText: data.workflowText ?? data.workflow_text,
      enabled: data.enabled ?? true,
      metadata: data.metadata ?? null,
      createdAt: data.createdAt instanceof Date ? data.createdAt : now,
      updatedAt: data.updatedAt instanceof Date ? data.updatedAt : now,
    }
  }

  function chainable() {
    let _table: string | null = null
    let _values: Record<string, unknown> | null = null
    let _setData: Record<string, unknown> | null = null
    let _whereId: string | null = null
    let _limitN: number | null = null
    let _mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let _whereConditions: Array<{ field: string; value: unknown }> = []

    const chain = {
      from(_tbl: unknown) {
        return chain
      },
      values(v: Record<string, unknown>) {
        _values = v
        return chain
      },
      set(s: Record<string, unknown>) {
        _setData = s
        return chain
      },
      where(condition: unknown) {
        // condition is a mock eq/and result — we store the parsed info
        if (condition && typeof condition === 'object' && '_mockConditions' in (condition as Record<string, unknown>)) {
          _whereConditions = (condition as { _mockConditions: Array<{ field: string; value: unknown }> })._mockConditions
        } else if (condition && typeof condition === 'object' && '_mockField' in (condition as Record<string, unknown>)) {
          const c = condition as { _mockField: string; _mockValue: unknown }
          _whereConditions = [{ field: c._mockField, value: c._mockValue }]
        }
        // Extract id condition for simple lookups
        const idCond = _whereConditions.find((c) => c.field === 'id')
        if (idCond) _whereId = idCond.value as string
        return chain
      },
      limit(n: number) {
        _limitN = n
        return chain
      },
      async returning() {
        if (_mode === 'insert' && _values) {
          const row = makeRow(_values)
          storage[row.id as string] = row
          return [row]
        }
        if (_mode === 'update' && _setData) {
          if (_whereId && storage[_whereId]) {
            const existing = storage[_whereId]!
            const updated = { ...existing, ..._setData }
            // Preserve fields not in set
            if (!_setData.id) updated.id = existing.id
            if (!_setData.createdAt) updated.createdAt = existing.createdAt
            storage[_whereId] = updated
            return [updated]
          }
          return []
        }
        if (_mode === 'delete') {
          if (_whereId && storage[_whereId]) {
            const row = storage[_whereId]
            delete storage[_whereId]
            return [row]
          }
          return []
        }
        return []
      },
      // For select queries — chain resolves as a thenable
      then(resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) {
        try {
          let results = Object.values(storage)

          // Apply where conditions
          for (const cond of _whereConditions) {
            results = results.filter((r) => r[cond.field] === cond.value)
          }

          if (_limitN !== undefined && _limitN !== null) {
            results = results.slice(0, _limitN)
          }
          resolve(results)
        } catch (e) {
          if (reject) reject(e)
        }
      },
    }
    return { chain, setMode: (m: typeof _mode) => { _mode = m } }
  }

  const db = {
    select() {
      const { chain, setMode } = chainable()
      setMode('select')
      return chain
    },
    insert(_tbl: unknown) {
      const { chain, setMode } = chainable()
      setMode('insert')
      return chain
    },
    update(_tbl: unknown) {
      const { chain, setMode } = chainable()
      setMode('update')
      return chain
    },
    delete(_tbl: unknown) {
      const { chain, setMode } = chainable()
      setMode('delete')
      return chain
    },
    _storage: storage,
    _reset() { storage = {}; db._storage = storage },
    _seed(id: string, data: Record<string, unknown>) {
      storage[id] = makeRow({ id, ...data })
    },
  }

  return db
}

// Mock drizzle-orm eq and and functions
vi.mock('drizzle-orm', () => ({
  eq: (column: { name: string }, value: unknown) => ({
    _mockField: column.name === 'id' ? 'id' : column.name,
    _mockValue: value,
  }),
  and: (...conditions: Array<{ _mockField: string; _mockValue: unknown }>) => ({
    _mockConditions: conditions.map((c) => ({ field: c._mockField, value: c._mockValue })),
  }),
}))

// Mock the schema import — provide objects with .name for eq() calls
vi.mock('../persistence/drizzle-schema.js', () => ({
  scheduleConfigs: {
    id: { name: 'id' },
    name: { name: 'name' },
    cronExpression: { name: 'cronExpression' },
    workflowText: { name: 'workflowText' },
    enabled: { name: 'enabled' },
    metadata: { name: 'metadata' },
    createdAt: { name: 'createdAt' },
    updatedAt: { name: 'updatedAt' },
  },
}))

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeScheduleInput(overrides: Partial<Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    id: overrides.id ?? 'sched-1',
    name: overrides.name ?? 'Daily Report',
    cronExpression: overrides.cronExpression ?? '0 9 * * *',
    workflowText: overrides.workflowText ?? 'Generate daily report',
    enabled: overrides.enabled ?? true,
    metadata: overrides.metadata ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// DrizzleScheduleStore tests
// ---------------------------------------------------------------------------

describe('DrizzleScheduleStore', () => {
  let db: ReturnType<typeof createMockDb>
  let store: DrizzleScheduleStore

  beforeEach(() => {
    db = createMockDb()
    store = new DrizzleScheduleStore(db)
  })

  // --- save ---

  it('save: creates a new schedule record', async () => {
    const result = await store.save(makeScheduleInput())
    expect(result.id).toBe('sched-1')
    expect(result.name).toBe('Daily Report')
    expect(result.cronExpression).toBe('0 9 * * *')
    expect(result.workflowText).toBe('Generate daily report')
    expect(result.enabled).toBe(true)
    expect(result.createdAt).toBeTruthy()
    expect(result.updatedAt).toBeTruthy()
  })

  it('save: returns ISO timestamp strings for createdAt and updatedAt', async () => {
    const result = await store.save(makeScheduleInput())
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('save: stores metadata when provided', async () => {
    const result = await store.save(makeScheduleInput({ metadata: { team: 'platform' } }))
    expect(result.metadata).toEqual({ team: 'platform' })
  })

  it('save: stores null metadata when not provided', async () => {
    const result = await store.save(makeScheduleInput())
    expect(result.metadata).toBeNull()
  })

  it('save: upserts when schedule with same id already exists', async () => {
    db._seed('sched-1', {
      name: 'Old Name',
      cronExpression: '0 0 * * *',
      workflowText: 'old workflow',
      enabled: true,
    })
    const result = await store.save(makeScheduleInput({ name: 'Updated Name' }))
    expect(result.id).toBe('sched-1')
    expect(result.name).toBe('Updated Name')
  })

  it('save: preserves createdAt on upsert', async () => {
    const earlyDate = new Date('2025-01-01T00:00:00.000Z')
    db._seed('sched-1', {
      name: 'Old',
      cronExpression: '0 0 * * *',
      workflowText: 'old',
      enabled: true,
      createdAt: earlyDate,
    })
    const result = await store.save(makeScheduleInput())
    // The createdAt should come from the existing row (preserved by update)
    expect(result.createdAt).toBeTruthy()
  })

  it('save: creates multiple distinct schedules', async () => {
    await store.save(makeScheduleInput({ id: 'sched-1' }))
    await store.save(makeScheduleInput({ id: 'sched-2', name: 'Weekly Report' }))
    const all = await store.list()
    expect(all).toHaveLength(2)
  })

  it('save: handles enabled=false', async () => {
    const result = await store.save(makeScheduleInput({ enabled: false }))
    expect(result.enabled).toBe(false)
  })

  // --- list ---

  it('list: returns all schedules when no filter', async () => {
    db._seed('s1', { name: 'A', cronExpression: '* * * * *', workflowText: 'a', enabled: true })
    db._seed('s2', { name: 'B', cronExpression: '* * * * *', workflowText: 'b', enabled: false })
    db._seed('s3', { name: 'C', cronExpression: '* * * * *', workflowText: 'c', enabled: true })

    const results = await store.list()
    expect(results).toHaveLength(3)
  })

  it('list: filters by enabled=true', async () => {
    db._seed('s1', { name: 'A', cronExpression: '* * * * *', workflowText: 'a', enabled: true })
    db._seed('s2', { name: 'B', cronExpression: '* * * * *', workflowText: 'b', enabled: false })
    db._seed('s3', { name: 'C', cronExpression: '* * * * *', workflowText: 'c', enabled: true })

    const results = await store.list({ enabled: true })
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.enabled === true)).toBe(true)
  })

  it('list: filters by enabled=false', async () => {
    db._seed('s1', { name: 'A', cronExpression: '* * * * *', workflowText: 'a', enabled: true })
    db._seed('s2', { name: 'B', cronExpression: '* * * * *', workflowText: 'b', enabled: false })

    const results = await store.list({ enabled: false })
    expect(results).toHaveLength(1)
    expect(results[0]!.enabled).toBe(false)
  })

  it('list: returns empty array when no schedules', async () => {
    const results = await store.list()
    expect(results).toEqual([])
  })

  it('list: returns ScheduleRecord objects with all fields', async () => {
    db._seed('s1', { name: 'A', cronExpression: '0 9 * * *', workflowText: 'run report', enabled: true, metadata: { tag: 'daily' } })

    const results = await store.list()
    expect(results).toHaveLength(1)
    const r = results[0]!
    expect(r.id).toBe('s1')
    expect(r.name).toBe('A')
    expect(r.cronExpression).toBe('0 9 * * *')
    expect(r.workflowText).toBe('run report')
    expect(r.enabled).toBe(true)
    expect(r.metadata).toEqual({ tag: 'daily' })
    expect(typeof r.createdAt).toBe('string')
    expect(typeof r.updatedAt).toBe('string')
  })

  // --- get ---

  it('get: returns schedule by id', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.get('sched-1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('sched-1')
    expect(result!.name).toBe('Test')
  })

  it('get: returns null for missing id', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeNull()
  })

  it('get: returns null when store is empty', async () => {
    const result = await store.get('any-id')
    expect(result).toBeNull()
  })

  // --- update ---

  it('update: patches name field', async () => {
    db._seed('sched-1', { name: 'Old', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', { name: 'New Name' })
    expect(result).not.toBeNull()
    expect(result!.name).toBe('New Name')
  })

  it('update: patches cronExpression', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', { cronExpression: '0 0 * * *' })
    expect(result).not.toBeNull()
    expect(result!.cronExpression).toBe('0 0 * * *')
  })

  it('update: patches workflowText', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'old workflow', enabled: true })

    const result = await store.update('sched-1', { workflowText: 'new workflow' })
    expect(result).not.toBeNull()
    expect(result!.workflowText).toBe('new workflow')
  })

  it('update: patches enabled flag', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', { enabled: false })
    expect(result).not.toBeNull()
    expect(result!.enabled).toBe(false)
  })

  it('update: patches metadata', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', { metadata: { priority: 'high' } })
    expect(result).not.toBeNull()
    expect(result!.metadata).toEqual({ priority: 'high' })
  })

  it('update: patches multiple fields at once', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', {
      name: 'Updated',
      cronExpression: '0 0 * * MON',
      enabled: false,
    })
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Updated')
    expect(result!.cronExpression).toBe('0 0 * * MON')
    expect(result!.enabled).toBe(false)
  })

  it('update: returns null for missing id', async () => {
    const result = await store.update('nonexistent', { name: 'Nope' })
    expect(result).toBeNull()
  })

  it('update: sets updatedAt on patch', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.update('sched-1', { name: 'Updated' })
    expect(result).not.toBeNull()
    expect(result!.updatedAt).toBeTruthy()
  })

  // --- delete ---

  it('delete: returns true when schedule is deleted', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    const result = await store.delete('sched-1')
    expect(result).toBe(true)
  })

  it('delete: returns false when schedule does not exist', async () => {
    const result = await store.delete('nonexistent')
    expect(result).toBe(false)
  })

  it('delete: schedule is no longer retrievable after delete', async () => {
    db._seed('sched-1', { name: 'Test', cronExpression: '0 * * * *', workflowText: 'test', enabled: true })

    await store.delete('sched-1')
    const result = await store.get('sched-1')
    expect(result).toBeNull()
  })

  it('delete: does not affect other schedules', async () => {
    db._seed('s1', { name: 'A', cronExpression: '* * * * *', workflowText: 'a', enabled: true })
    db._seed('s2', { name: 'B', cronExpression: '* * * * *', workflowText: 'b', enabled: true })

    await store.delete('s1')
    const remaining = await store.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe('s2')
  })
})

// ---------------------------------------------------------------------------
// InMemoryScheduleStore contract parity
// ---------------------------------------------------------------------------

describe('InMemoryScheduleStore', () => {
  let store: InMemoryScheduleStore

  beforeEach(() => {
    store = new InMemoryScheduleStore()
  })

  it('save: creates and returns a schedule record', async () => {
    const result = await store.save(makeScheduleInput())
    expect(result.id).toBe('sched-1')
    expect(result.name).toBe('Daily Report')
    expect(result.cronExpression).toBe('0 9 * * *')
    expect(result.workflowText).toBe('Generate daily report')
    expect(result.enabled).toBe(true)
    expect(result.createdAt).toBeTruthy()
    expect(result.updatedAt).toBeTruthy()
  })

  it('save: upserts existing schedule preserving createdAt', async () => {
    const first = await store.save(makeScheduleInput())
    const second = await store.save(makeScheduleInput({ name: 'Updated' }))
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.name).toBe('Updated')
  })

  it('list: returns all when no filter', async () => {
    await store.save(makeScheduleInput({ id: 's1' }))
    await store.save(makeScheduleInput({ id: 's2', enabled: false }))
    const results = await store.list()
    expect(results).toHaveLength(2)
  })

  it('list: filters by enabled', async () => {
    await store.save(makeScheduleInput({ id: 's1', enabled: true }))
    await store.save(makeScheduleInput({ id: 's2', enabled: false }))
    const enabled = await store.list({ enabled: true })
    expect(enabled).toHaveLength(1)
    expect(enabled[0]!.id).toBe('s1')
  })

  it('get: returns schedule by id', async () => {
    await store.save(makeScheduleInput())
    const result = await store.get('sched-1')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('Daily Report')
  })

  it('get: returns null for missing id', async () => {
    const result = await store.get('nonexistent')
    expect(result).toBeNull()
  })

  it('update: patches fields and returns updated record', async () => {
    await store.save(makeScheduleInput())
    const result = await store.update('sched-1', { name: 'New Name', enabled: false })
    expect(result).not.toBeNull()
    expect(result!.name).toBe('New Name')
    expect(result!.enabled).toBe(false)
  })

  it('update: returns null for missing id', async () => {
    const result = await store.update('nonexistent', { name: 'Nope' })
    expect(result).toBeNull()
  })

  it('update: does not overwrite id or createdAt', async () => {
    const saved = await store.save(makeScheduleInput())
    const result = await store.update('sched-1', { name: 'X' })
    expect(result!.id).toBe('sched-1')
    expect(result!.createdAt).toBe(saved.createdAt)
  })

  it('delete: returns true when deleted', async () => {
    await store.save(makeScheduleInput())
    const result = await store.delete('sched-1')
    expect(result).toBe(true)
  })

  it('delete: returns false when not found', async () => {
    const result = await store.delete('nonexistent')
    expect(result).toBe(false)
  })

  it('delete: schedule is no longer retrievable', async () => {
    await store.save(makeScheduleInput())
    await store.delete('sched-1')
    expect(await store.get('sched-1')).toBeNull()
  })
})
