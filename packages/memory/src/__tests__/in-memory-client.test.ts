/**
 * Tests for `InMemoryMemoryClient` (ADR-0005).
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { InMemoryMemoryClient } from '../in-memory-client.js'
import type {
  MemoryRecord,
  MemoryScope,
  MemoryChangeEvent,
} from '@dzupagent/agent-types'

const TENANT: MemoryScope = { tenantId: 'tenant-a' }
const TENANT_PROJECT: MemoryScope = { tenantId: 'tenant-a', projectId: 'proj-1' }

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now()
  return {
    id: 'rec-1',
    namespace: 'facts',
    scope: TENANT,
    content: 'water boils at 100C',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('InMemoryMemoryClient', () => {
  let client: InMemoryMemoryClient

  beforeEach(() => {
    client = new InMemoryMemoryClient()
  })

  it('round-trips a record through put + get', async () => {
    const record = makeRecord()
    await client.put('facts', TENANT, record)
    const result = await client.get('facts', TENANT)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('rec-1')
    expect(result[0]?.content).toBe('water boils at 100C')
  })

  it('isolates records by namespace', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'fact a' }))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', content: 'event b', namespace: 'episodic' }),
    )
    const facts = await client.get('facts', TENANT)
    const episodic = await client.get('episodic', TENANT)
    expect(facts.map(r => r.id)).toEqual(['a'])
    expect(episodic.map(r => r.id)).toEqual(['b'])
  })

  it('filters by scope fields when present', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'global', content: 'tenant-only' }))
    await client.put(
      'facts',
      TENANT_PROJECT,
      makeRecord({
        id: 'scoped',
        content: 'project-scoped',
        scope: TENANT_PROJECT,
      }),
    )

    // Tenant-only query matches every record under that tenant, regardless
    // of finer-grained scope fields. Order is by `updatedAt` desc.
    const tenantQuery = await client.get('facts', TENANT)
    expect(tenantQuery.map(r => r.id).sort()).toEqual(['global', 'scoped'])

    // Adding `projectId` narrows the result to the project-scoped record only.
    const projectOnly = await client.get('facts', TENANT_PROJECT)
    expect(projectOnly.map(r => r.id)).toEqual(['scoped'])
  })

  it('honours search filter on content', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'apple pie' }))
    await client.put('facts', TENANT, makeRecord({ id: 'b', content: 'banana bread' }))

    const result = await client.get('facts', TENANT, { search: 'banana' })
    expect(result.map(r => r.id)).toEqual(['b'])
  })

  it('honours limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await client.put(
        'facts',
        TENANT,
        makeRecord({ id: `r${i}`, content: `c${i}`, updatedAt: Date.now() + i }),
      )
    }
    const page = await client.get('facts', TENANT, { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
  })

  it('delete removes a record and returns true; missing returns false', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a' }))
    const ok = await client.delete('facts', TENANT, 'a')
    expect(ok).toBe(true)
    expect(await client.get('facts', TENANT)).toHaveLength(0)

    const miss = await client.delete('facts', TENANT, 'never-existed')
    expect(miss).toBe(false)
  })

  it('subscribers receive created / updated / deleted events for matching scope', async () => {
    const events: MemoryChangeEvent[] = []
    const unsubscribe = client.subscribe('facts', TENANT, e => events.push(e))

    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'first' }))
    await client.put('facts', TENANT, makeRecord({ id: 'a', content: 'second' }))
    await client.delete('facts', TENANT, 'a')

    unsubscribe()
    await client.put('facts', TENANT, makeRecord({ id: 'b', content: 'after unsub' }))

    expect(events.map(e => e.type)).toEqual(['created', 'updated', 'deleted'])
  })

  it('subscribers do not receive events on a different namespace', async () => {
    const events: MemoryChangeEvent[] = []
    client.subscribe('facts', TENANT, e => events.push(e))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', namespace: 'episodic' }),
    )
    expect(events).toHaveLength(0)
  })

  it('stats reports record count and unique namespaces', async () => {
    await client.put('facts', TENANT, makeRecord({ id: 'a' }))
    await client.put(
      'episodic',
      TENANT,
      makeRecord({ id: 'b', namespace: 'episodic' }),
    )
    const stats = await client.stats()
    expect(stats.totalRecords).toBe(2)
    expect(stats.namespaces.sort()).toEqual(['episodic', 'facts'])
  })

  it('listener errors do not break subsequent puts', async () => {
    client.subscribe('facts', TENANT, () => {
      throw new Error('listener boom')
    })
    await expect(
      client.put('facts', TENANT, makeRecord({ id: 'safe' })),
    ).resolves.toBeUndefined()
    expect((await client.get('facts', TENANT))[0]?.id).toBe('safe')
  })
})
