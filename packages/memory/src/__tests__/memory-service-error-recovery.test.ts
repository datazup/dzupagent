import { test, expect, vi } from 'vitest'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import { logError, noopLogger } from '../error-log.js'
import { InMemoryMemoryClient } from '../in-memory-client.js'
import { asJsonObject, decodeReference } from '../lifecycle/validation.js'
import { isMemoryTransitionError } from '../service/history-reducer.js'
import { MemoryTransitionError } from '../lifecycle/errors.js'
import { storeOutcomeFailure } from '../service/service-runtime.js'

test('memory service reports read status and structured error correlation without letting a logger break recovery', async () => {
  const store = await createStore({ type: 'memory' })
  const service = new MemoryService(store, [{ name: 'notes', scopeKeys: ['tenantId'], searchable: false }, { name: 'searchable', scopeKeys: ['tenantId'], searchable: true }])
  expect(service.getStore()).toBe(store)
  await service.put('notes', { tenantId: 'tenant' }, 'key', { text: 'fixture' })
  expect((await service.searchWithStatus('notes', { tenantId: 'tenant' }, 'fixture')).searchFailed).toBe(false)
  expect((await service.searchWithStatus('searchable', { tenantId: 'tenant' }, 'fixture')).results).toEqual([])
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(() => { throw new Error('sink unavailable') }) }
  expect(logError({ component: 'fixture', operation: 'read', error: 'failed', errorId: 'correlation', logger })).toBe('correlation')
  expect(logger.error).toHaveBeenCalledOnce()
  expect(logError({ component: 'fixture', operation: 'read', error: new Error('PRIVATE_FIXTURE_TEXT'), errorId: 'opaque', logger: noopLogger })).toBe('opaque')
})

test('service failures preserve typed recovery results and in-memory teardown removes retained records', async () => {
  expect(asJsonObject({ fixture: true }, [])).toEqual({ fixture: true })
  expect(() => asJsonObject([], [])).toThrow()
  expect(decodeReference({ owner: 'fixture', id: 'reference', digest: `sha256:${'a'.repeat(64)}` }, [])).toHaveProperty('owner', 'fixture')
  expect(isMemoryTransitionError(new MemoryTransitionError('invalid-state', []))).toBe(true)
  expect(isMemoryTransitionError(new Error('fixture'))).toBe(false)
  for (const [status, reason, expected] of [['conflict', 'cas-conflict', 'conflict'], ['unsupported', 'unsupported-capability', 'unsupported'], ['ambiguous', 'ambiguous-outcome', 'retryable'], ['rejected', 'capacity-exceeded', 'rejected']] as const) {
    expect(storeOutcomeFailure({ schema: 'datazup.memory.store-outcome/v1', status, reason })).toMatchObject({ status: expected, reason, records: [] })
  }
  const client = new InMemoryMemoryClient()
  await client.put('notes', { tenantId: 'tenant' }, { id: 'fixture', namespace: 'notes', scope: { tenantId: 'tenant' }, content: 'fixture', metadata: {}, createdAt: 0, updatedAt: 0 })
  client.clear()
  expect(await client.get('notes', { tenantId: 'tenant' })).toEqual([])
  const store = await createStore({ type: 'memory' })
  await store.put(['fixture'], 'key', { fixture: true })
  ;(store as unknown as { clear(): void }).clear()
  expect(await store.get(['fixture'], 'key')).toBeUndefined()
})
