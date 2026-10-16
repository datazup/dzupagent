import { test, expect } from 'vitest'
import { activeFixture } from '../../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1 } from '../../projections/index.js'

test('projection admission rejects profiles outside their bounds and conflicting identities', () => {
  const request = activeFixture().request
  const invalid = [
    { ...request, schema: 'foreign' },
    ...[{ schema: 'foreign' }, { formatVersion: 'foreign' }, { contentMode: 'foreign' }, { inlineSensitivities: ['foreign'] }, { inlineSensitivities: ['public', 'public'] }].map(change => ({ ...request, profile: { ...request.profile, ...change } })),
    ...['maxRecords', 'maxEvents', 'maxReceipts', 'maxInlineContentBytes', 'maxOutputBytes'].flatMap(key => [0, 1_000_000_000].map(value => ({ ...request, profile: { ...request.profile, [key]: value } }))),
    { ...request, records: [] },
    { ...request, records: [request.records[0], request.records[0]] },
    { ...request, scope: { ...request.scope, tenantId: 'foreign' } },
  ]
  for (const input of invalid) expect(() => Reflect.apply(projectMemoryRecordV1, undefined, [input])).toThrow()
})
