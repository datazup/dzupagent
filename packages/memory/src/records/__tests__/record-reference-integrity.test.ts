import { test, expect } from 'vitest'
import { makeCapturedRecord } from '../../lifecycle/__tests__/fixtures.js'
import { decodeMemoryRecordV1, validateInlineContent } from '../../records/decoder.js'
import { digestSafeJson, snapshotSafeJson } from '../../records/safe-json.js'
import { activeFixture } from '../../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1, diffMemoryProjections } from '../../projections/index.js'

const projectionRequest = activeFixture().request

const projection = projectMemoryRecordV1(projectionRequest)

test('record boundaries reject contradictory references, temporal ranges and unsafe inline payloads', () => {
  const record = makeCapturedRecord()
  const contentRef = { schema: 'datazup.memory.content-ref/v1', owner: 'fixture', id: 'content', digest: record.contentDigest, mediaType: 'text/plain', byteLength: 10 }
  const referenceOnly = { ...record, kind: 'document-ref', content: undefined, contentRef, searchTextRef: contentRef }
  // Undefined is excluded by the serialized boundary rather than relied on.
  const referenceInput = JSON.parse(JSON.stringify(referenceOnly))
  expect(decodeMemoryRecordV1(referenceInput)).toMatchObject({ kind: 'document-ref', contentRef, searchTextRef: contentRef })
  const invalid = [
    { ...referenceInput, contentRef: { ...contentRef, schema: 'foreign' } },
    { ...referenceInput, contentRef: { ...contentRef, mediaType: 'invalid' } },
    { ...referenceInput, contentRef: { ...contentRef, digest: `sha256:${'f'.repeat(64)}` } },
    { ...record, contentRef },
    { ...record, kind: 'document-ref' },
    { ...record, lifecycle: { ...record.lifecycle, status: 'purged' } },
    { ...record, tags: Array.from({ length: 33 }, (_, i) => `tag${i}`) },
    { ...record, tags: ['duplicate', 'duplicate'] },
    { ...record, provenance: { ...record.provenance, evidenceRefs: Array.from({ length: 33 }, () => record.provenance.evidenceRefs[0]) } },
    { ...record, provenance: { ...record.provenance, evidenceRefs: [{ ...record.provenance.evidenceRefs[0], schema: 'foreign' }] } },
    ...['priorVersionId', 'supersedesVersionId', 'supersededByVersionId', 'revokesVersionId'].map(key => ({ ...record, lifecycle: { ...record.lifecycle, [key]: record.versionId } })),
    ...[{ validFrom: '2030-01-01T00:00:00.000Z', validTo: '2020-01-01T00:00:00.000Z' }, { lastVerifiedAt: '2020-01-01T00:00:00.000Z' }, { lastVerifiedAt: '2030-01-01T00:00:00.000Z' }, { expiresAt: '2020-01-01T00:00:00.000Z' }, { sourceEventTime: '2030-01-01T00:00:00.000Z' }].map(change => ({ ...record, temporal: { ...record.temporal, ...change } })),
  ]
  for (const input of invalid) expect(() => decodeMemoryRecordV1(input)).toThrow()
  for (const content of [{ data: '/private/path' }, { data: 'C:\\private\\path' }, { data: '\\\\server\\share' }, { data: 'file:private' }, { authorityGranted: true }, { permissionGrant: true }, { data: ['safe', { cookie: 'fixture' }] }]) expect(() => validateInlineContent(snapshotSafeJson(content), [])).toThrow()
  const oversizedContent = { data: 'a'.repeat(17 * 1024) }
  expect(() => decodeMemoryRecordV1({ ...record, content: oversizedContent, contentDigest: digestSafeJson(snapshotSafeJson(oversizedContent)) })).toThrow()
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
