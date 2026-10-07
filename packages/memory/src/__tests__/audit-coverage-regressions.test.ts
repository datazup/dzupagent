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
import { logError } from '../error-log.js'
import { createInMemoryMemoryOutbox } from '../workers/in-memory-outbox.js'
import { claimInput, prepareInput, T0, T2, T20 } from '../workers/__tests__/fixtures.js'
import { makeCapturedRecord } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import { activeFixture } from '../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1, diffMemoryProjections } from '../projections/index.js'
import { makeCaptureCommand } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryCommandV1 } from '../lifecycle/validation.js'
import { decodeMemoryEventV1, decodeMemoryTransitionReceiptV1 } from '../lifecycle/ledger.js'
import { capturedRecord, captureInput } from '../service/__tests__/fixtures.js'
import { decodeLifecycleWriteInputV1 } from '../service/validation.js'
import { InMemoryMemoryClient } from '../in-memory-client.js'
import { asJsonObject, decodeReference } from '../lifecycle/validation.js'
import { isMemoryTransitionError } from '../service/history-reducer.js'
import { MemoryTransitionError } from '../lifecycle/errors.js'
import { storeOutcomeFailure } from '../service/service-runtime.js'

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
