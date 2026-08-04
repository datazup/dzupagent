import { describe, it, expect } from 'vitest'
import { MemoryService } from '@dzupagent/memory'
import { InMemoryStore } from '@langchain/langgraph'

describe('probe', () => {
  it('namespace axis vs forced scope', async () => {
    const store = new InMemoryStore()
    const svc = new MemoryService(store as never, [
      { name: 'lessons', scopeKeys: ['tenantId', 'lessons'], searchable: true },
      { name: 'secrets', scopeKeys: ['tenantId', 'secrets'], searchable: true },
    ] as never)
    // tenant-a writes into BOTH namespaces under its own forced scope
    await svc.put('lessons', { tenantId: 'a' }, 'k1', { text: 'a-lesson' })
    await svc.put('secrets', { tenantId: 'a' }, 'k2', { text: 'a-secret' })
    // caller authenticated as tenant a, scope forced to a, but picks namespace 'secrets'
    const cross = await svc.getKeyed('secrets', { tenantId: 'a' })
    console.log('SAME-TENANT-OTHER-NS:', JSON.stringify(cross))
    // now tenant b forced scope reading namespace secrets
    const b = await svc.getKeyed('secrets', { tenantId: 'b' })
    console.log('OTHER-TENANT:', JSON.stringify(b))
    expect(true).toBe(true)
  })
})
