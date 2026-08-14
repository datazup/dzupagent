import { describe, expect, it } from 'vitest'

import { diffMemoryProjections, projectMemoryRecordV1 } from '../index.js'
import { activeFixture, correctedFixture } from './fixtures.js'

describe('memory projection semantic diff', () => {
  it('classifies correction, supersession, lifecycle, and receipt changes', () => {
    const fixture = correctedFixture()
    const diff = diffMemoryProjections(
      projectMemoryRecordV1(fixture.base.request),
      projectMemoryRecordV1(fixture.request),
    )

    expect(diff.empty).toBe(false)
    expect(diff.authority).toBe('none')
    expect(diff.changes.some(change => change.kind === 'added'
      && change.identity === 'version:version-002')).toBe(true)
    expect(diff.changes.some(change => change.kind === 'superseded'
      && change.identity === 'version:version-001')).toBe(true)
    expect(diff.changes.some(change => change.kind === 'lifecycle-only')).toBe(true)
    expect(diff.changes.some(change => change.kind === 'receipt')).toBe(true)
  })

  it('is empty for the same semantic source despite a different caller time', () => {
    const fixture = activeFixture()
    const base = projectMemoryRecordV1(fixture.request)
    const target = projectMemoryRecordV1({
      ...fixture.request,
      generatedAt: '2026-08-11T10:00:21.000Z',
    })
    const diff = diffMemoryProjections(base, target)

    expect(base.projectionDigest).not.toBe(target.projectionDigest)
    expect(diff.empty).toBe(true)
    expect(diff.changes).toEqual([])
  })

  it('rejects a target that predates the exact base revision', () => {
    const fixture = correctedFixture()
    expect(() => diffMemoryProjections(
      projectMemoryRecordV1(fixture.request),
      projectMemoryRecordV1(fixture.base.request),
    )).toThrow(/stale-base/)
  })
})
