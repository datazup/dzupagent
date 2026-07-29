/**
 * Real-store coverage for SessionSearch key resolution.
 *
 * `index()` previously read via `get()`, which returns bare values, then
 * `search()` recovered the key from `value['key']` — a field real records do
 * not carry — so every SearchResult had `key: ''`. Mock stores that seed a
 * `key` field into their values cannot observe this.
 */
import { describe, expect, it } from 'vitest'
import { InMemoryStore } from '@langchain/langgraph'
import { MemoryService } from '../memory-service.js'
import { SessionSearch } from '../session-search.js'

const NS = 'notes'
const SCOPE = { tenantId: 't1' }

describe('SessionSearch (real store)', () => {
  it('reports the real store key for a match', async () => {
    const svc = new MemoryService(new InMemoryStore(), [
      { name: NS, scopeKeys: ['tenantId'], searchable: false },
    ])
    await svc.put(NS, SCOPE, 'note-42', { text: 'postgres migration plan' })

    const search = new SessionSearch(svc)
    await search.index(NS, SCOPE)
    const results = await search.search({ text: 'postgres' })

    expect(results).toHaveLength(1)
    expect(results[0]!.key).toBe('note-42')
  })
})
