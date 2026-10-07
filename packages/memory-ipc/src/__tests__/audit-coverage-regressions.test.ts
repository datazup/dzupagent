import { expect, test, vi } from 'vitest'
import { IpcMemoryClient, IpcNotConfiguredError } from '../ipc-client.js'
import type { MemoryServiceLike } from '../memory-service-ext.js'

test('in-process IPC preserves scope, record identity, metadata, and pagination through CRUD', async () => {
  const svc: MemoryServiceLike = {
    get: vi.fn(async () => [{ id: 'first', text: 'a', createdAt: 10, updatedAt: 20 }, { key: 'second', content: 'b', score: 1 }, { extra: true }]),
    getKeyed: vi.fn(async () => []),
    search: vi.fn(async () => [{ id: 'found', text: 'matched' }]),
    put: vi.fn(async () => {}), delete: vi.fn(async () => false),
  }
  const scope = { tenantId: 'tenant', workspaceId: 'workspace', projectId: 'project', taskId: 'task' }
  const client = new IpcMemoryClient({ backingService: svc })
  const records = await client.get('notes', scope)
  expect(records[0]).toEqual({ id: 'first', namespace: 'notes', scope, content: 'a', createdAt: 10, updatedAt: 20 })
  expect(records[1]).toMatchObject({ id: 'second', content: 'b', metadata: { score: 1 } })
  expect(records[2]).toMatchObject({ id: 'ipc-2', content: '{"extra":true}' })
  expect(await client.get('notes', scope, { offset: 1, limit: 1 })).toEqual([records[1]])
  expect(await client.get('notes', scope, { search: 'query', limit: 1 })).toHaveLength(1)
  expect(svc.search).toHaveBeenCalledWith('notes', scope, 'query', 1)
  await client.put('notes', scope, records[1]!)
  expect(svc.put).toHaveBeenCalledWith('notes', scope, 'second', { text: 'b', score: 1 })
  expect(await client.delete('notes', scope, 'second')).toBe(false)
  svc.delete = vi.fn(async () => undefined)
  expect(await client.delete('notes', { tenantId: 'tenant' }, 'second')).toBe(true)
  delete svc.delete
  expect(await client.delete('notes', scope, 'second')).toBe(false)
})

test('unimplemented remote IPC fails clearly for every CRUD operation', async () => {
  const client = new IpcMemoryClient({})
  const scope = { tenantId: 'tenant' }
  await expect(client.get('notes', scope)).rejects.toBeInstanceOf(IpcNotConfiguredError)
  await expect(client.put('notes', scope, { id: 'x', namespace: 'notes', scope, content: 'a', createdAt: 1, updatedAt: 1 })).rejects.toThrow('IpcMemoryClient.put')
  await expect(client.delete('notes', scope, 'x')).rejects.toThrow('IpcMemoryClient.delete')
})
