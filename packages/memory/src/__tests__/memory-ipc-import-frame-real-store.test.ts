/**
 * Real-store coverage for memory-ipc's `replace` import strategy.
 *
 * This integration belongs in `@dzupagent/memory`: memory already depends on
 * memory-ipc, while putting it in memory-ipc creates an undeclared reverse
 * dependency and makes clean-checkout typechecking depend on stale artifacts.
 */
import { InMemoryStore } from '@langchain/langgraph'
import { extendMemoryServiceWithArrow, FrameBuilder } from '@dzupagent/memory-ipc'
import { describe, expect, it } from 'vitest'

import { MemoryService } from '../memory-service.js'

const NS = 'ns'
const SCOPE = { tenantId: 't1' }

function makeService(): MemoryService {
  return new MemoryService(new InMemoryStore(), [
    { name: NS, scopeKeys: ['tenantId'], searchable: false },
  ])
}

describe('memory-ipc importFrame replace (real store)', () => {
  it('replaces existing records instead of throwing on missing keys', async () => {
    const svc = makeService()
    await svc.put(NS, SCOPE, 'k1', { text: 'old' })

    const ext = extendMemoryServiceWithArrow(svc as never)
    const builder = new FrameBuilder()
    builder.add({ text: 'new' }, { id: 'i2', namespace: NS, key: 'k2' })

    const result = await ext.importFrame(NS, SCOPE, builder.build(), 'replace')

    expect(result.imported).toBe(1)
    const after = await svc.getKeyed(NS, SCOPE)
    expect(after.map((record) => record.key)).toEqual(['k2'])
  })
})
