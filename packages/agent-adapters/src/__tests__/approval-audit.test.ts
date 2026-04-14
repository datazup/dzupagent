import { describe, it, expect } from 'vitest'
import { InMemoryApprovalAuditStore } from '../approval/approval-audit.js'
import type { ApprovalAuditEntry } from '../approval/approval-audit.js'

describe('InMemoryApprovalAuditStore', () => {
  it('records and queries entries', () => {
    const store = new InMemoryApprovalAuditStore()
    const entry: ApprovalAuditEntry = {
      requestId: 'req-1',
      providerId: 'claude',
      action: 'granted',
      timestamp: Date.now(),
      actor: 'admin',
      mode: 'required',
    }
    store.record(entry)
    expect(store.query()).toHaveLength(1)
    expect(store.query()[0]).toEqual(entry)
  })

  it('filters by requestId', () => {
    const store = new InMemoryApprovalAuditStore()
    store.record({ requestId: 'a', providerId: 'claude', action: 'granted', timestamp: 1, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'b', providerId: 'codex', action: 'rejected', timestamp: 2, actor: 'y', mode: 'required' })
    expect(store.query({ requestId: 'a' })).toHaveLength(1)
  })

  it('filters by action', () => {
    const store = new InMemoryApprovalAuditStore()
    store.record({ requestId: 'a', providerId: 'claude', action: 'granted', timestamp: 1, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'b', providerId: 'claude', action: 'rejected', timestamp: 2, actor: 'x', mode: 'auto' })
    expect(store.query({ action: 'rejected' })).toHaveLength(1)
  })

  it('filters by time range', () => {
    const store = new InMemoryApprovalAuditStore()
    store.record({ requestId: 'a', providerId: 'claude', action: 'granted', timestamp: 100, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'b', providerId: 'claude', action: 'granted', timestamp: 200, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'c', providerId: 'claude', action: 'granted', timestamp: 300, actor: 'x', mode: 'auto' })
    expect(store.query({ since: 150, until: 250 })).toHaveLength(1)
  })

  it('respects limit', () => {
    const store = new InMemoryApprovalAuditStore()
    for (let i = 0; i < 10; i++) {
      store.record({ requestId: `r${i}`, providerId: 'claude', action: 'granted', timestamp: i, actor: 'x', mode: 'auto' })
    }
    expect(store.query({ limit: 3 })).toHaveLength(3)
  })

  it('evicts oldest when at capacity', () => {
    const store = new InMemoryApprovalAuditStore(3)
    store.record({ requestId: 'a', providerId: 'claude', action: 'granted', timestamp: 1, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'b', providerId: 'claude', action: 'granted', timestamp: 2, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'c', providerId: 'claude', action: 'granted', timestamp: 3, actor: 'x', mode: 'auto' })
    store.record({ requestId: 'd', providerId: 'claude', action: 'granted', timestamp: 4, actor: 'x', mode: 'auto' })
    const all = store.query()
    expect(all).toHaveLength(3)
    expect(all[0]!.requestId).toBe('b') // 'a' evicted
  })

  it('clear() removes all entries', () => {
    const store = new InMemoryApprovalAuditStore()
    store.record({ requestId: 'a', providerId: 'claude', action: 'granted', timestamp: 1, actor: 'x', mode: 'auto' })
    store.clear()
    expect(store.query()).toHaveLength(0)
  })
})
