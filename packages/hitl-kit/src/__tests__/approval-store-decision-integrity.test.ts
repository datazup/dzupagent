import { test, expect, vi } from 'vitest'
import { PostgresApprovalStateStore, type SqlClient } from '../postgres-approval-store.js'
import { RuntimeApprovalBridge } from '../runtime-approval-bridge.js'
import { UnknownApprovalError } from '../approval-state-store.js'

test('approval updates cannot report a decision for a deleted or unknown approval', async () => {
  const client: SqlClient = { query: async () => ({ rows: [] }) }
  const store = new PostgresApprovalStateStore(client)
  await expect(store.grant('run', 'missing')).rejects.toBeInstanceOf(UnknownApprovalError)
  await expect(store.reject('run', 'missing', 'fixture')).rejects.toBeInstanceOf(UnknownApprovalError)
  await expect(store.poll('run', 'missing', 1)).rejects.toBeInstanceOf(UnknownApprovalError)
})

test('rejected approvals without an optional reason remain rejected and store errors propagate', async () => {
  const client: SqlClient = { query: vi.fn().mockResolvedValue({ rows: [{ status: 'rejected', response: null, reason: null }] }) }
  const store = new PostgresApprovalStateStore(client)
  expect(await store.poll('run', 'fixture', 1)).toEqual({ decision: 'rejected', reason: undefined })
  const bridge = new RuntimeApprovalBridge({ store })
  expect(await bridge.pollTerminal('run', 'fixture', 1)).toBe('human_rejected')
  client.query = vi.fn().mockRejectedValue(new Error('database unavailable'))
  await expect(bridge.ensurePending('run', 'fixture', {})).rejects.toThrow(/database unavailable/)
  await expect(bridge.pollTerminal('run', 'fixture', 1)).rejects.toThrow(/database unavailable/)
})
