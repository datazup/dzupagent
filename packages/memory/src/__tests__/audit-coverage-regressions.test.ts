import { test, expect, vi } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, symlink, mkdir, rm } from 'node:fs/promises'
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
test.each(wrongTypeCases(makeCapturedRecord()))('serialized memory record rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})
const projectionRequest = activeFixture().request
test.each(wrongTypeCases(projectionRequest))('projection request rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(projectMemoryRecordV1, undefined, [input])).toThrow()
})
const projection = projectMemoryRecordV1(projectionRequest)
test.each(wrongTypeCases(projection))('retained projection rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})
test.each(wrongTypeCases(prepareInput()))('outbox envelope rejects wrong type at %s', (_path, input) => {
  expect(() => createInMemoryMemoryOutbox().prepare(input)).toThrow()
})

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
