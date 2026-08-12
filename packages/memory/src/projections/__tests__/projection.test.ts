import { describe, expect, it } from 'vitest'

import {
  projectMemoryRecordToJson,
  projectMemoryRecordToMarkdown,
  projectMemoryRecordV1,
} from '../index.js'
import { activeFixture, inlineFixture, purgeFixture } from './fixtures.js'

describe('deterministic memory projections', () => {
  it('normalizes irrelevant input order and produces byte-identical JSON', () => {
    const fixture = activeFixture()
    const reordered = {
      ...fixture.request,
      events: [...fixture.request.events].reverse(),
      receipts: [...fixture.request.receipts].reverse(),
    }
    const first = projectMemoryRecordV1(fixture.request)
    const second = projectMemoryRecordV1(reordered)

    expect(second).toEqual(first)
    expect(projectMemoryRecordToJson(reordered)).toBe(projectMemoryRecordToJson(fixture.request))
    expect(projectMemoryRecordToJson(fixture.request).endsWith('\n')).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.records[0])).toBe(true)
  })

  it('keeps non-exportable content reference-only and marks all authority absent', () => {
    const projection = projectMemoryRecordV1(activeFixture().request)

    expect(projection.authority).toBe('none')
    expect(projection.records[0]?.content).toMatchObject({
      mode: 'reference-only',
      reason: 'profile-reference-only',
    })
    expect(projection.records[0]?.content).not.toHaveProperty('value')
    expect(projection.summary.statuses.active).toBe(1)
  })

  it('escapes inline untrusted content in Markdown and retains the non-authority warning', () => {
    const fixture = inlineFixture()
    const projection = projectMemoryRecordV1(fixture.request)
    const markdown = projectMemoryRecordToMarkdown(fixture.request)

    expect(projection.records[0]?.content.mode).toBe('inline')
    expect(markdown).not.toContain('<script>')
    expect(markdown).toContain('&lt;script&gt;')
    expect(markdown).toContain('grants no permission')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('reports purge proposals as incomplete rather than physical completion', () => {
    const projection = projectMemoryRecordV1(purgeFixture())

    expect(projection.summary.purgeState).toBe('proposed-incomplete')
    expect(projection.chain.purgeProposals).toHaveLength(1)
    expect(projection.authority).toBe('none')
  })
})
