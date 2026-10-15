import { test, expect } from 'vitest'
import { activeFixture } from '../../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1 } from '../../projections/index.js'
import { projectMemoryVersionChainV1 } from '../../lifecycle/projection.js'

const projectionRequest = activeFixture().request

const projection = projectMemoryRecordV1(projectionRequest)

test('ledger replay rejects reordered, duplicated, foreign and contradictory event effects', () => {
  const events = projection.events
  expect(() => projectMemoryVersionChainV1(events)).not.toThrow()
  const secondChanges = [{ memoryId: 'foreign' }, { generation: 2 }, { sequence: 1 }, { sequence: 4 }, { occurredAt: '2020-01-01T00:00:00.000Z' }, { eventId: events[0]!.eventId }, { commandId: events[0]!.commandId }, { idempotencyKey: events[0]!.idempotencyKey }, { currentVersionId: 'foreign' }, { currentRecordDigest: `sha256:${'f'.repeat(64)}` }, { currentStatus: 'archived' }]
  for (const change of secondChanges) {
    const invalid = structuredClone(events)
    Object.assign(invalid[1]!, change)
    expect(() => projectMemoryVersionChainV1(invalid), JSON.stringify(change)).toThrow()
  }
  const captureEffects = [{ priorDigest: `sha256:${'f'.repeat(64)}` }, { statusFrom: 'active' }, { statusTo: 'active' }, { versionId: 'foreign' }]
  for (const change of captureEffects) {
    const invalid = structuredClone(events)
    Object.assign(invalid[0]!.recordEffects[0]!, change)
    expect(() => projectMemoryVersionChainV1(invalid), JSON.stringify(change)).toThrow()
  }
  for (const index of [1, 2]) for (const change of [{ priorDigest: `sha256:${'f'.repeat(64)}` }, { statusFrom: 'archived' }, { statusTo: 'archived' }, { versionId: 'foreign' }]) {
    const invalid = structuredClone(events)
    Object.assign(invalid[index]!.recordEffects[0]!, change)
    expect(() => projectMemoryVersionChainV1(invalid), `${index}:${JSON.stringify(change)}`).toThrow()
  }
})
