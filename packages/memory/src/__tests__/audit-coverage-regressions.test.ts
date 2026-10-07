import { test, expect, vi } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, symlink, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withContainedFile } from '../knowledge/contained-file.js'
import { FilesystemKnowledgeStore } from '../knowledge/filesystem-knowledge-store.js'
import { snapshotPath } from '../knowledge/knowledge-paths.js'
import { MemoryService } from '../memory-service.js'
import { createStore } from '../store-factory.js'
import { logError, noopLogger } from '../error-log.js'
import { createInMemoryMemoryOutbox } from '../workers/in-memory-outbox.js'
import { claimInput, prepareInput, runInput, completingPort, ref, T0, T2, T20 } from '../workers/__tests__/fixtures.js'
import { makeCapturedRecord } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import { activeFixture } from '../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1, diffMemoryProjections } from '../projections/index.js'
import { makeCaptureCommand } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryCommandV1 } from '../lifecycle/validation.js'
import { decodeMemoryEventV1, decodeMemoryTransitionReceiptV1 } from '../lifecycle/ledger.js'
import { capturedRecord, captureInput, transitionInput, instant } from '../service/__tests__/fixtures.js'
import { decodeLifecycleWriteInputV1, decodeMemoryInvalidationResultV1 } from '../service/validation.js'
import { InMemoryMemoryClient } from '../in-memory-client.js'
import { asJsonObject, decodeReference, recordDigest } from '../lifecycle/validation.js'
import { isMemoryTransitionError, reduceMemoryHistoryCommandV1 } from '../service/history-reducer.js'
import { MemoryTransitionError } from '../lifecycle/errors.js'
import { storeOutcomeFailure, assertCheckpointInstruction } from '../service/service-runtime.js'
import { InMemoryMemoryLifecycleAdapter } from '../service/in-memory-adapter.js'
import { MemoryLifecycleService } from '../service/memory-lifecycle-service.js'
import { fillGeneration, rolloverInput, loadSnapshot } from '../service/__tests__/checkpoint-fixtures.js'
import { decodeMemoryServiceSnapshotV1 } from '../service/snapshot.js'
import type { InternalMemoryServiceSnapshotV1 } from '../service/types.js'
import { WebSocketSyncTransport } from '../sync/ws-transport.js'
import { ObservationalMemory } from '../observational-memory.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { sealMemoryWorkerLeaseV1 } from '../workers/validation-contracts.js'
import { decodeMemoryConsolidationResultV1, decodeMemoryReconciliationResultV1 } from '../workers/validation-results.js'
import { digestWorkerValue } from '../workers/snapshot.js'
import { PersistentEntityGraph } from '../retrieval/persistent-graph.js'

test('knowledge paths reject ambiguous scopes and pin ancestors of the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-boundary-'))
  try {
    const store = new FilesystemKnowledgeStore({ rootDir: root })
    const read = async (scope: string) => { for await (const entry of store.query({ scope })) void entry }
    for (const scope of ['run:../escape', 'repo:a/b', 'run:a:b', 'global:extra', 'run:']) await expect(read(scope)).rejects.toThrow(/Invalid scope/)
    expect(snapshotPath(root, 'global', 'finding', 'a/b')).not.toBe(snapshotPath(root, 'global', 'finding', 'a_b'))
    expect(() => snapshotPath(root, 'global', '../finding', 'key')).toThrow(/kind/)
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'alias'))
    await expect(withContainedFile(join(root, 'alias', 'nested'), join(root, 'alias', 'nested', 'file'), true, constants.O_CREAT | constants.O_WRONLY, async () => undefined)).rejects.toThrow(/symlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Each case corrupts one schema field in otherwise valid serialized input.
// Arbitrary user content is intentionally left intact: its JSON types are open.
function wrongTypeCases(input: unknown): Array<[string, unknown]> {
  const output: Array<[string, unknown]> = []
  const visit = (value: unknown, path: string[]) => {
    if (value === null || value === undefined || path.includes('content')) return
    if (typeof value !== 'object' || Array.isArray(value)) {
      const copy = structuredClone(input)
      let parent = copy as Record<string, unknown>
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>
      parent[path.at(-1)!] = { wrongType: true }
      output.push([path.join('.'), copy])
    }
    if (typeof value === 'object') for (const [key, nested] of Object.entries(value)) visit(nested, [...path, key])
  }
  if (input && typeof input === 'object') for (const [key, value] of Object.entries(input)) visit(value, [key])
  return output
}
function missingFieldCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).map(([path]) => {
    const copy = structuredClone(input) as Record<string, unknown>
    const parts = path.split('.')
    let parent = copy
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    delete parent[parts.at(-1)!]
    return [path, copy]
  })
}
function emptyStringCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).flatMap(([path]) => {
    const parts = path.split('.')
    const original = parts.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], input)
    if (typeof original !== 'string') return []
    const copy = structuredClone(input) as Record<string, unknown>
    let parent = copy
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    parent[parts.at(-1)!] = ''
    return [[path, copy] as [string, unknown]]
  })
}
test.each(wrongTypeCases(makeCapturedRecord()))('serialized memory record rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})
const optionalRecordFields = new Set(['scope.workspaceId', 'temporal.validFrom', 'quality.extractionQuality'])
test.each(missingFieldCases(makeCapturedRecord()).filter(([path]) => !optionalRecordFields.has(path)))('serialized memory record requires field %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})
test.each(emptyStringCases(makeCapturedRecord()))('serialized memory record rejects empty string at %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})
test.each(wrongTypeCases(makeCaptureCommand()))('lifecycle command rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryCommandV1(input)).toThrow()
})
const projectionRequest = activeFixture().request
test.each(wrongTypeCases(projectionRequest))('projection request rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(projectMemoryRecordV1, undefined, [input])).toThrow()
})
const projection = projectMemoryRecordV1(projectionRequest)
test.each(wrongTypeCases(projection))('retained projection rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})
test.each(missingFieldCases(projection))('retained projection requires field %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})
test.each(wrongTypeCases(projection.events[0]))('retained lifecycle event rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryEventV1(input)).toThrow()
})
test.each(wrongTypeCases(projection.receipts[0]))('retained lifecycle receipt rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryTransitionReceiptV1(input)).toThrow()
})
test.each(emptyStringCases(projection))('retained projection rejects empty string at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})
test.each(wrongTypeCases(captureInput(capturedRecord())))('service write envelope rejects wrong type at %s', (_path, input) => {
  expect(() => decodeLifecycleWriteInputV1(input)).toThrow()
})
test.each(wrongTypeCases(prepareInput()))('outbox envelope rejects wrong type at %s', (_path, input) => {
  expect(() => createInMemoryMemoryOutbox().prepare(input)).toThrow()
})

test('a symlink occupying the historical lock path cannot touch an outside directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-lock-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'knowledge-outside-'))
  try {
    await writeFile(join(outside, 'marker'), 'retained')
    await symlink(outside, join(root, 'global.lock'))
    const before = await stat(outside)
    const store = new FilesystemKnowledgeStore({ rootDir: root })
    const entry = { id: 'entry', runId: 'run', repo: null, kind: 'finding' as const, key: 'key', version: 1, authorWorkerId: null, parentId: null, createdAt: '2026-10-07T00:00:00.000Z', supersededAt: null, payload: { category: 'hotspot' as const, location: 'fixture:1', summary: 'fixture', evidence: [], confidence: 1 }, tags: [] }
    await expect(store.append('global', entry)).rejects.toThrow()
    expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('retained')
    expect((await stat(outside)).mtimeMs).toBe(before.mtimeMs)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
}, 10_000)

test('outbox renewal supersedes old generations and fails closed at expiry or before acquisition', () => {
  const outbox = createInMemoryMemoryOutbox()
  outbox.enqueue(outbox.prepare(prepareInput()))
  const lease = outbox.claim(claimInput()).lease!
  const renew = (renewedAt: string) => outbox.renew({ schema: 'datazup.memory.outbox-renew/v1', lease, renewedAt, extendByMs: 5000 })
  expect(renew(T0).reasonCode).toBe('renewal-precedes-lease')
  const next = renew(T2)
  expect(next.lease!.generation).toBe(lease.generation + 1)
  expect(renew(T2).status).toBe('rejected')
  expect(outbox.renew({ schema: 'datazup.memory.outbox-renew/v1', lease: next.lease, renewedAt: T20, extendByMs: 5000 }).reasonCode).toBe('lease-expired-before-renewal')
})

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

test('checkpoint recovery rejects a different generation, owner, head, receipt or settlement history', async () => {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const full = await fillGeneration(service, 'audit-checkpoint')
  expect((await service.remember(rolloverInput(full.record))).status).toBe('committed')
  const snapshot = await loadSnapshot(adapter, 'audit-checkpoint')
  const checkpoint = snapshot.checkpoints[0]!
  const instruction = { checkpointId: checkpoint.checkpointId, checkpointedAt: checkpoint.checkpointedAt }
  expect(() => assertCheckpointInstruction(snapshot, instruction)).not.toThrow()
  for (const change of [{ checkpointId: 'foreign' }, { checkpointedAt: instant(0) }]) expect(() => assertCheckpointInstruction(snapshot, { ...instruction, ...change })).toThrow()
  expect(() => assertCheckpointInstruction({ ...snapshot, checkpoints: [] }, instruction)).toThrow()
  const changes: Array<Record<string, unknown>> = [{ generation: 3 }, { sequence: 0 }, { revision: 1 }, { records: [] }, { records: [...snapshot.records, snapshot.records[0]] }, { checkpoints: [] }]
  for (const key of ['versionId', 'recordDigest', 'status', 'lastTransitionAt', 'retrievalEligible'] as const) changes.push({ head: { ...snapshot.head, [key]: key === 'retrievalEligible' ? !snapshot.head[key] : key === 'recordDigest' ? `sha256:${'a'.repeat(64)}` : key === 'lastTransitionAt' ? instant(0) : key === 'status' ? 'archived' : 'foreign' } })
  for (const key of ['memoryId', 'fromGeneration', 'toGeneration', 'fromSequence', 'stateDigest', 'chainDigest', 'lastEventDigest', 'lastReceiptDigest', 'checkpointedAt'] as const) changes.push({ checkpoints: [{ ...checkpoint, [key]: typeof checkpoint[key] === 'number' ? 99 : key === 'checkpointedAt' ? instant(0) : key.endsWith('Digest') ? `sha256:${'a'.repeat(64)}` : 'foreign' }] })
  for (const change of changes) expect(() => decodeMemoryServiceSnapshotV1({ ...snapshot, ...change }), Object.keys(change).join()).toThrow()
  const record = snapshot.records.find(item => recordDigest(item) === snapshot.head.recordDigest)!
  const command = transitionInput('dispute', record, snapshot.generation, snapshot.sequence, 35).command
  expect(() => reduceMemoryHistoryCommandV1(snapshot, command)).not.toThrow()
  const invalidCommands = [{ memoryId: 'foreign' }, { generation: 3 }, { expectedSequence: 0 }, { expectedSequence: 99 }, { transitionAt: instant(0) }, { expectedVersionId: 'foreign' }, { expectedRecordDigest: `sha256:${'a'.repeat(64)}` }, { commandId: snapshot.events[0]!.commandId }, { eventId: snapshot.events[0]!.eventId }, { receiptId: snapshot.receipts[0]!.receiptId }]
  for (const change of invalidCommands) expect(() => reduceMemoryHistoryCommandV1(snapshot, { ...command, ...change } as typeof command)).toThrow()
  expect(() => reduceMemoryHistoryCommandV1({ ...snapshot, records: [] } as InternalMemoryServiceSnapshotV1, command)).toThrow()
  const reference = { owner: 'fixture', id: 'receipt', digest: `sha256:${'a'.repeat(64)}` }
  const invalidation = { schema: 'datazup.memory.invalidation-result/v1', status: 'completed', outcomes: [{ target: { ...reference, kind: 'cache' }, status: 'completed', receiptRef: reference }] }
  expect(decodeMemoryInvalidationResultV1(invalidation).status).toBe('completed')
  for (const status of ['partial', 'unsupported', 'retryable']) expect(() => decodeMemoryInvalidationResultV1({ ...invalidation, status })).toThrow()
}, 60_000)

test('WebSocket connection establishment removes both temporary listeners on open and error', async () => {
  let ws!: EventTarget & { readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  class FakeWebSocket extends EventTarget {
    readyState = 1
    send = vi.fn()
    close = vi.fn()
    constructor() { super(); ws = this }
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
  try {
    const connected = WebSocketSyncTransport.fromUrl('ws://fixture.invalid')
    const removed = vi.spyOn(ws, 'removeEventListener')
    ws.dispatchEvent(new Event('open'))
    const transport = await connected
    expect(removed.mock.calls.map(([type]) => type)).toEqual(['open', 'error'])
    await transport.close()
    expect(ws.close).toHaveBeenCalledOnce()
    const failed = WebSocketSyncTransport.fromUrl('ws://fixture.invalid')
    const failedRemoved = vi.spyOn(ws, 'removeEventListener')
    ws.dispatchEvent(new Event('error'))
    await expect(failed).rejects.toThrow(/failed/)
    expect(failedRemoved.mock.calls.map(([type]) => type)).toEqual(['open', 'error'])
  } finally { vi.unstubAllGlobals() }
})

test('manual reflection of an empty observation namespace does not invoke a model', async () => {
  const store = await createStore({ type: 'memory' })
  const service = new MemoryService(store, [{ name: 'observations', scopeKeys: ['tenantId'], searchable: false }])
  const invoke = vi.fn(() => { throw new Error('unexpected model invocation') })
  const memory = new ObservationalMemory({ model: { invoke } as unknown as BaseChatModel, memoryService: service, store, namespace: 'observations', scope: { tenantId: 'tenant' } })
  await expect(memory.forceReflect()).resolves.toMatchObject({ merged: 0 })
  expect(invoke).not.toHaveBeenCalled()
})

test('retained content references must carry their own complete integrity identity', () => {
  const retained = structuredClone(projection)
  Object.assign(retained.records[0]!.content, { contentRef: { schema: 'datazup.memory.content-ref/v1', owner: 'fixture', id: 'content', digest: `sha256:${'a'.repeat(64)}`, mediaType: 'text/plain', byteLength: 1 } })
  expect(() => diffMemoryProjections(projection, retained)).toThrow()
  for (const field of ['owner', 'id', 'digest', 'mediaType', 'byteLength']) {
    const invalid = structuredClone(retained)
    delete (invalid.records[0]!.content.contentRef as unknown as Record<string, unknown>)[field]
    expect(() => diffMemoryProjections(projection, invalid)).toThrow()
  }
})

test('outbox restore rejects stale leases, contradictory terminal states and reordered identities', async () => {
  const outbox = createInMemoryMemoryOutbox()
  outbox.enqueue(outbox.prepare(prepareInput()))
  const pending = outbox.exportState()
  const lease = outbox.claim(claimInput()).lease!
  const leased = outbox.exportState()
  await outbox.runClaimed(runInput(lease), completingPort())
  const completed = outbox.exportState()
  for (const seed of [pending, leased, completed]) {
    expect(createInMemoryMemoryOutbox({ seed }).exportState()).toEqual(seed)
    for (const state of ['executing', 'reconciling', 'ambiguous', 'dead-lettered']) {
      const invalid = structuredClone(seed)
      Object.assign(invalid.entries[0]!, { state })
      expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
    }
    for (const change of [{ attempt: 99 }, { generation: 99 }, { nextAvailableAt: '2026-08-01T00:00:00.000Z' }, { nextAvailableAt: '2027-08-01T00:00:00.000Z' }]) {
      const invalid = structuredClone(seed)
      Object.assign(invalid.entries[0]!, change)
      expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
    }
    expect(() => createInMemoryMemoryOutbox({ seed: { ...seed, entries: [...seed.entries, seed.entries[0]] } })).toThrow()
    expect(() => createInMemoryMemoryOutbox({ seed: { ...seed, revision: seed.revision + 1 } })).toThrow()
  }
  for (const change of [{ envelopeId: 'foreign' }, { envelopeDigest: `sha256:${'a'.repeat(64)}` }, { attempt: 2 }, { generation: 2 }]) {
    const { leaseDigest: _digest, ...base } = lease
    const changed = sealMemoryWorkerLeaseV1({ ...base, ...change } as typeof base)
    const invalid = structuredClone(leased)
    Object.assign(invalid.entries[0]!, { lease: changed })
    expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
  }
  for (const state of ['pending', 'leased', 'ambiguous', 'dead-lettered']) {
    const invalid = structuredClone(completed)
    Object.assign(invalid.entries[0]!, { state })
    expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
  }
})

test('provider and reconciliation results cannot assert an effect that contradicts their terminal status', () => {
  const requestDigest = `sha256:${'a'.repeat(64)}` as const
  const seal = (base: Record<string, unknown>) => ({ ...base, resultDigest: digestWorkerValue(base) })
  for (const status of ['completed', 'partial', 'retryable', 'terminal', 'ambiguous'] as const) {
    const base = { schema: 'datazup.memory.consolidation-result/v1', status, reasonCode: 'fixture', finishedAt: T2, requestDigest, candidateRefs: status === 'completed' || status === 'partial' ? [ref('candidate')] : [], ...(status === 'ambiguous' ? { reconciliationRef: ref('reconcile') } : {}), providerCostMicrousd: 0, effectState: status === 'ambiguous' ? 'unknown' : status === 'completed' || status === 'partial' ? 'applied' : 'not-applied' }
    expect(decodeMemoryConsolidationResultV1(seal(base), requestDigest, 1).status).toBe(status)
    for (const effectState of ['applied', 'not-applied', 'unknown']) if (effectState !== base.effectState) expect(() => decodeMemoryConsolidationResultV1(seal({ ...base, effectState }), requestDigest, 1)).toThrow()
    expect(() => decodeMemoryConsolidationResultV1(seal({ ...base, requestDigest: `sha256:${'b'.repeat(64)}` }), requestDigest, 1)).toThrow()
  }
  for (const status of ['proven-complete', 'proven-not-applied', 'ambiguous'] as const) {
    const base = { schema: 'datazup.memory.reconciliation-result/v1', status, reasonCode: 'fixture', finishedAt: T2, requestDigest, candidateRefs: status === 'proven-complete' ? [ref('candidate')] : [], ...(status === 'ambiguous' ? { reconciliationRef: ref('reconcile') } : {}), providerCostMicrousd: 0, effectState: status === 'ambiguous' ? 'unknown' : status === 'proven-complete' ? 'applied' : 'not-applied' }
    expect(decodeMemoryReconciliationResultV1(seal(base), requestDigest, 1).status).toBe(status)
    for (const effectState of ['applied', 'not-applied', 'unknown']) if (effectState !== base.effectState) expect(() => decodeMemoryReconciliationResultV1(seal({ ...base, effectState }), requestDigest, 1)).toThrow()
    expect(() => decodeMemoryReconciliationResultV1(seal({ ...base, requestDigest: `sha256:${'b'.repeat(64)}` }), requestDigest, 1)).toThrow()
  }
})
test('entity traversal tolerates corrupt or dangling indexes without inventing memory records', async () => {
  const store = await createStore({ type: 'memory' })
  const graph = new PersistentEntityGraph(store, ['notes'])
  const entities = ['notes', '__entities']
  const reverse = ['notes', '__record_entities']
  await store.put(entities, 'alpha', { memoryKeys: ['missing', 'one'] })
  await store.put(['notes'], 'one', { content: 'AlphaBeta uses `alpha`' })
  await store.put(reverse, 'one', { entities: ['alpha', 'dangling', 'malformed'] })
  await store.put(entities, 'malformed', { memoryKeys: 'invalid' })
  expect((await graph.search('`alpha`', 3, 10)).map(item => item.key)).toEqual(['one'])
  expect(await graph.getRelatedEntities('alpha')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dangling' })]))
  expect(await graph.getRelatedEntities('malformed')).toEqual([])
  expect(await graph.getEntities()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'malformed', degree: 0 })]))
  await store.put(reverse, 'one', { entities: 'invalid' })
  expect((await graph.search('`alpha`', 3, 10)).map(item => item.key)).toEqual(['one'])
  await graph.removeRecord('one')
  await store.put(reverse, 'one', { entities: ['malformed', 'dangling'] })
  await graph.removeRecord('one')
  await store.put(['notes'], 'two', { arbitrary: '`beta`' })
  expect((await graph.reindexAll()).recordsProcessed).toBe(2)
  const broken = new PersistentEntityGraph({ ...store, search: async () => { throw new Error('backend unavailable') } } as typeof store, ['notes'])
  expect(await broken.reindexAll()).toEqual({ entitiesIndexed: 0, recordsProcessed: 0 })
})
