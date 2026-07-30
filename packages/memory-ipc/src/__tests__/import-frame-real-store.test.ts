/**
 * Real-store coverage for the `replace` import strategy.
 *
 * The mocked MemoryService in memory-service-ext.test.ts synthesizes `key`
 * and `id` onto every record its `get()` returns. Real records carry neither,
 * so `replace` threw against any genuine MemoryService while the mock-backed
 * tests passed. Drive a real service here so the strategy is exercised
 * against the record shape production actually produces.
 */
import { describe, expect, it } from 'vitest'
import { InMemoryStore } from '@langchain/langgraph'
import { MemoryService } from '@dzupagent/memory'
import { extendMemoryServiceWithArrow } from '../memory-service-ext.js'
import { FrameBuilder } from '../frame-builder.js'

const NS = 'ns'
const SCOPE = { tenantId: 't1' }

function makeService(): MemoryService {
  return new MemoryService(new InMemoryStore(), [
    { name: NS, scopeKeys: ['tenantId'], searchable: false },
  ])
}

describe('importFrame replace (real store)', () => {
  it('replaces existing records instead of throwing on missing keys', async () => {
    const svc = makeService()
    await svc.put(NS, SCOPE, 'k1', { text: 'old' })

    const ext = extendMemoryServiceWithArrow(svc as never)
    const builder = new FrameBuilder()
    builder.add({ text: 'new' }, { id: 'i2', namespace: NS, key: 'k2' })

    const result = await ext.importFrame(NS, SCOPE, builder.build(), 'replace')

    expect(result.imported).toBe(1)
    const after = await svc.getKeyed(NS, SCOPE)
    // The prior record is gone and only the imported one remains.
    expect(after.map(r => r.key)).toEqual(['k2'])
  })
})
