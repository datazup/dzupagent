import { describe, it, expect } from 'vitest'
import { FrameBuilder } from '../frame-builder.js'
import type { FrameRecordMeta, FrameRecordValue } from '../frame-builder.js'
import { phaseWeightedSelection } from '../phase-memory-selection.js'

function buildTable(
  records: Array<{
    id: string
    namespace: string
    text?: string
    category?: string | null
    importance?: number | null
    decayStrength?: number | null
    systemCreatedAt?: number
  }>,
) {
  const builder = new FrameBuilder()
  for (const r of records) {
    const value: FrameRecordValue = {
      text: r.text ?? `Record ${r.id}`,
      importance: r.importance ?? 0.5,
      category: r.category ?? null,
      _decay: {
        strength: r.decayStrength ?? 1.0,
      },
      _temporal: {
        systemCreatedAt: r.systemCreatedAt ?? Date.now(),
      },
    }
    const meta: FrameRecordMeta = { id: r.id, namespace: r.namespace, key: r.id }
    builder.add(value, meta)
  }
  return builder.build()
}

describe('phaseWeightedSelection', () => {
  it('debugging phase boosts lessons namespace', () => {
    const now = Date.now()
    // All records have same base importance/decay/recency, differ only by namespace
    const records = [
      { id: 'conv', namespace: 'conventions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'lesson', namespace: 'lessons', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    // Budget fits only one record
    const selected = phaseWeightedSelection(table, 'debugging', 11, { now })

    expect(selected.length).toBe(1)
    // Should prefer 'lessons' (weight 2.5) over 'conventions' (weight 0.8)
    expect(selected[0]?.rowIndex).toBe(1) // 'lesson' is at index 1
  })

  it('planning phase boosts decisions namespace', () => {
    const now = Date.now()
    const records = [
      { id: 'obs', namespace: 'observations', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'dec', namespace: 'decisions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    const selected = phaseWeightedSelection(table, 'planning', 11, { now })

    expect(selected.length).toBe(1)
    // Should prefer 'decisions' (weight 2.0) over 'observations' (weight 0.8)
    expect(selected[0]?.rowIndex).toBe(1)
  })

  it('coding phase boosts conventions namespace', () => {
    const now = Date.now()
    const records = [
      { id: 'obs', namespace: 'observations', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'conv', namespace: 'conventions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    const selected = phaseWeightedSelection(table, 'coding', 11, { now })

    expect(selected.length).toBe(1)
    // Should prefer 'conventions' (weight 2.0) over 'observations' (weight 0.8)
    expect(selected[0]?.rowIndex).toBe(1)
  })

  it('general phase: no boost (equal treatment)', () => {
    const now = Date.now()
    const records = [
      { id: 'r0', namespace: 'decisions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r1', namespace: 'lessons', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r2', namespace: 'conventions', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    // General phase has empty weights, so all records should score equally
    const selected = phaseWeightedSelection(table, 'general', 100000, { now })

    // All records should be selected (budget is large enough)
    expect(selected.length).toBe(3)

    // All scores should be equal since general phase has no multipliers
    const scores = selected.map((s) => s.score)
    expect(scores[0]).toBeCloseTo(scores[1]!, 5)
    expect(scores[1]).toBeCloseTo(scores[2]!, 5)
  })

  it('returns empty for empty table', () => {
    const table = buildTable([])
    const selected = phaseWeightedSelection(table, 'debugging', 5000)
    expect(selected).toEqual([])
  })

  it('returns empty for zero budget', () => {
    const table = buildTable([{ id: 'r0', namespace: 'test' }])
    const selected = phaseWeightedSelection(table, 'coding', 0)
    expect(selected).toEqual([])
  })

  it('respects category weights in debugging phase', () => {
    const now = Date.now()
    const records = [
      { id: 'r0', namespace: 'other', category: 'observation', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
      { id: 'r1', namespace: 'other', category: 'lesson', text: 'x'.repeat(40), importance: 0.5, decayStrength: 1.0, systemCreatedAt: now },
    ]
    const table = buildTable(records)

    // Budget fits only one record
    const selected = phaseWeightedSelection(table, 'debugging', 11, { now })

    expect(selected.length).toBe(1)
    // debugging phase: lesson category weight=2.5, observation=2.0
    // 'r1' (lesson) should be preferred
    expect(selected[0]?.rowIndex).toBe(1)
  })
})
