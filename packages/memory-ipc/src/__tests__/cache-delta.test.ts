import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { computeFrameDelta } from '../cache-delta.js'

function buildTable(
  records: Array<{
    id: string
    text?: string
    namespace?: string
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
    }
    const meta: FrameRecordMeta = {
      id: r.id,
      namespace: r.namespace ?? 'test',
      key: r.id,
    }
    builder.add(value, meta)
  }
  return builder.build()
}

describe('computeFrameDelta', () => {
  it('no changes: changeRatio=0, shouldRefreeze=false', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: `Content for record ${i}`,
    }))
    const frozen = buildTable(records)
    const current = buildTable(records)

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(0)
    expect(delta.frozenTotal).toBe(10)
    expect(delta.currentTotal).toBe(10)
    expect(delta.changeRatio).toBe(0)
    expect(delta.shouldRefreeze).toBe(false)
  })

  it('additions: 10 -> 12 records, changeRatio=2/12', () => {
    const frozenRecords = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: `Content ${i}`,
    }))
    const currentRecords = [
      ...frozenRecords,
      { id: 'r10', text: 'New record 10' },
      { id: 'r11', text: 'New record 11' },
    ]

    const frozen = buildTable(frozenRecords)
    const current = buildTable(currentRecords)

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(2)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(0)
    expect(delta.frozenTotal).toBe(10)
    expect(delta.currentTotal).toBe(12)
    // changeRatio = 2 / max(10, 12) = 2/12
    expect(delta.changeRatio).toBeCloseTo(2 / 12, 5)
    // 2/12 = 0.167 > 0.1 threshold
    expect(delta.shouldRefreeze).toBe(true)
  })

  it('removals: 10 -> 8 records detected', () => {
    const frozenRecords = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: `Content ${i}`,
    }))
    const currentRecords = frozenRecords.slice(0, 8)

    const frozen = buildTable(frozenRecords)
    const current = buildTable(currentRecords)

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(2)
    expect(delta.modified).toBe(0)
  })

  it('modifications: 1 text changed, detected', () => {
    const frozenRecords = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: `Original content ${i}`,
    }))
    const currentRecords = frozenRecords.map((r, i) =>
      i === 5 ? { ...r, text: 'Modified content for record 5' } : r,
    )

    const frozen = buildTable(frozenRecords)
    const current = buildTable(currentRecords)

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(1)
    expect(delta.changeRatio).toBeCloseTo(1 / 10, 5)
    expect(delta.shouldRefreeze).toBe(false) // 0.1 is not > 0.1
  })

  it('empty both: changeRatio=0', () => {
    const frozen = buildTable([])
    const current = buildTable([])

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(0)
    expect(delta.removed).toBe(0)
    expect(delta.modified).toBe(0)
    expect(delta.frozenTotal).toBe(0)
    expect(delta.currentTotal).toBe(0)
    expect(delta.changeRatio).toBe(0)
    expect(delta.shouldRefreeze).toBe(false)
  })

  it('custom refreeze threshold', () => {
    const frozenRecords = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      text: `Content ${i}`,
    }))
    const currentRecords = [
      ...frozenRecords,
      { id: 'r20', text: 'New' },
    ]

    const frozen = buildTable(frozenRecords)
    const current = buildTable(currentRecords)

    // changeRatio = 1/21 ~ 0.048
    // With threshold 0.01, should refreeze
    const strictDelta = computeFrameDelta(frozen, current, 0.01)
    expect(strictDelta.shouldRefreeze).toBe(true)

    // With threshold 0.5, should not refreeze
    const lenientDelta = computeFrameDelta(frozen, current, 0.5)
    expect(lenientDelta.shouldRefreeze).toBe(false)
  })

  it('mixed: additions, removals, and modifications combined', () => {
    const frozenRecords = [
      { id: 'r0', text: 'Original 0' },
      { id: 'r1', text: 'Original 1' },
      { id: 'r2', text: 'Original 2' },
      { id: 'r3', text: 'Original 3' },
    ]
    const currentRecords = [
      { id: 'r0', text: 'Modified 0' },  // modified
      { id: 'r1', text: 'Original 1' },  // unchanged
      // r2, r3 removed
      { id: 'r4', text: 'New 4' },       // added
    ]

    const frozen = buildTable(frozenRecords)
    const current = buildTable(currentRecords)

    const delta = computeFrameDelta(frozen, current)

    expect(delta.added).toBe(1)     // r4
    expect(delta.removed).toBe(2)   // r2, r3
    expect(delta.modified).toBe(1)  // r0
    expect(delta.frozenTotal).toBe(4)
    expect(delta.currentTotal).toBe(3)
    // changeRatio = (1+2+1) / max(4,3) = 4/4 = 1.0
    expect(delta.changeRatio).toBe(1.0)
    expect(delta.shouldRefreeze).toBe(true)
  })
})
