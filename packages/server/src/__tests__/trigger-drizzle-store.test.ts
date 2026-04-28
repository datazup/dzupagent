import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DrizzleTriggerStore } from '../triggers/trigger-store.js'
import type { TriggerConfigRecord } from '../triggers/trigger-store.js'

type StoredTrigger = {
  id: string
  type: string
  agentId: string
  schedule: string | null
  webhookSecret: string | null
  afterAgentId: string | null
  enabled: boolean
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

function makeRow(data: Partial<StoredTrigger> & { id: string }): StoredTrigger {
  const now = new Date('2026-04-16T12:00:00.000Z')
  return {
    id: data.id,
    type: data.type ?? 'cron',
    agentId: data.agentId ?? 'agent-1',
    schedule: data.schedule ?? null,
    webhookSecret: data.webhookSecret ?? null,
    afterAgentId: data.afterAgentId ?? null,
    enabled: data.enabled ?? true,
    metadata: data.metadata ?? null,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  }
}

function createMockDb() {
  let storage: Record<string, StoredTrigger> = {}

  function chainable() {
    let values: Partial<StoredTrigger> | null = null
    let patch: Partial<StoredTrigger> | null = null
    let whereId: string | null = null
    let conditions: Array<{ field: keyof StoredTrigger; value: unknown }> = []
    let limitN: number | null = null
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'

    const chain = {
      from(_table: unknown) {
        return chain
      },
      values(input: Partial<StoredTrigger>) {
        values = input
        return chain
      },
      set(input: Partial<StoredTrigger>) {
        patch = input
        return chain
      },
      where(condition: unknown) {
        if (
          condition &&
          typeof condition === 'object' &&
          '_mockConditions' in condition
        ) {
          conditions = (condition as {
            _mockConditions: Array<{ field: keyof StoredTrigger; value: unknown }>
          })._mockConditions
        } else if (
          condition &&
          typeof condition === 'object' &&
          '_mockField' in condition
        ) {
          const c = condition as { _mockField: keyof StoredTrigger; _mockValue: unknown }
          conditions = [{ field: c._mockField, value: c._mockValue }]
        }
        whereId = (conditions.find((c) => c.field === 'id')?.value as string | undefined) ?? null
        return chain
      },
      limit(input: number) {
        limitN = input
        return chain
      },
      async returning() {
        if (mode === 'insert' && values?.id) {
          const row = makeRow(values as Partial<StoredTrigger> & { id: string })
          storage[row.id] = row
          return [row]
        }
        if (mode === 'update' && patch && whereId && storage[whereId]) {
          storage[whereId] = { ...storage[whereId], ...patch }
          return [storage[whereId]]
        }
        if (mode === 'delete' && whereId && storage[whereId]) {
          const row = storage[whereId]
          delete storage[whereId]
          return [row]
        }
        return []
      },
      then(resolve: (rows: StoredTrigger[]) => void, reject?: (error: unknown) => void) {
        try {
          let rows = Object.values(storage)
          for (const condition of conditions) {
            rows = rows.filter((row) => row[condition.field] === condition.value)
          }
          if (limitN !== null) rows = rows.slice(0, limitN)
          resolve(rows)
        } catch (error) {
          reject?.(error)
        }
      },
    }

    return {
      chain,
      setMode(nextMode: typeof mode) {
        mode = nextMode
      },
    }
  }

  const db = {
    select() {
      const { chain, setMode } = chainable()
      setMode('select')
      return chain
    },
    insert(_table: unknown) {
      const { chain, setMode } = chainable()
      setMode('insert')
      return chain
    },
    update(_table: unknown) {
      const { chain, setMode } = chainable()
      setMode('update')
      return chain
    },
    delete(_table: unknown) {
      const { chain, setMode } = chainable()
      setMode('delete')
      return chain
    },
    seed(id: string, row: Partial<StoredTrigger>) {
      storage[id] = makeRow({ id, ...row })
    },
  }

  return db
}

vi.mock('drizzle-orm', () => ({
  eq: (column: { name: keyof StoredTrigger }, value: unknown) => ({
    _mockField: column.name,
    _mockValue: value,
  }),
  and: (...conditions: Array<{ _mockField: keyof StoredTrigger; _mockValue: unknown }>) => ({
    _mockConditions: conditions.map((condition) => ({
      field: condition._mockField,
      value: condition._mockValue,
    })),
  }),
}))

vi.mock('../persistence/drizzle-schema.js', () => ({
  triggerConfigs: {
    id: { name: 'id' },
    type: { name: 'type' },
    agentId: { name: 'agentId' },
    schedule: { name: 'schedule' },
    webhookSecret: { name: 'webhookSecret' },
    afterAgentId: { name: 'afterAgentId' },
    enabled: { name: 'enabled' },
    metadata: { name: 'metadata' },
    createdAt: { name: 'createdAt' },
    updatedAt: { name: 'updatedAt' },
  },
}))

describe('DrizzleTriggerStore', () => {
  let db: ReturnType<typeof createMockDb>
  let store: DrizzleTriggerStore

  beforeEach(() => {
    db = createMockDb()
    store = new DrizzleTriggerStore(db)
  })

  it('saves and reads a trigger record with explicit row mapping', async () => {
    const saved = await store.save({
      id: 'trigger-1',
      type: 'webhook',
      agentId: 'agent-1',
      webhookSecret: 'secret',
      enabled: true,
      metadata: { source: 'test' },
    })

    expect(saved).toMatchObject({
      id: 'trigger-1',
      type: 'webhook',
      agentId: 'agent-1',
      webhookSecret: 'secret',
      metadata: { source: 'test' },
    } satisfies Partial<TriggerConfigRecord>)
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const read = await store.get('trigger-1')
    expect(read).toEqual(saved)
  })

  it('filters list results by agent and enabled state', async () => {
    db.seed('t1', { agentId: 'agent-a', enabled: true })
    db.seed('t2', { agentId: 'agent-a', enabled: false })
    db.seed('t3', { agentId: 'agent-b', enabled: true })

    const results = await store.list({ agentId: 'agent-a', enabled: true })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: 't1', agentId: 'agent-a', enabled: true })
  })
})
