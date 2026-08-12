import { describe, expect, it } from 'vitest'

import type { MemoryProjectionRequestV1, MemoryProjectionV1 } from '../types.js'
import { diffMemoryProjections, projectMemoryRecordV1 } from '../index.js'
import { activeFixture } from './fixtures.js'

describe('memory projection hostile boundaries', () => {
  it('rejects accessors and proxies without invoking getters', () => {
    const fixture = activeFixture()
    let invoked = false
    const accessor = { ...fixture.request } as Record<string, unknown>
    Object.defineProperty(accessor, 'scope', {
      enumerable: true,
      get() {
        invoked = true
        return fixture.request.scope
      },
    })

    expect(() => projectMemoryRecordV1(accessor as unknown as MemoryProjectionRequestV1))
      .toThrow(/invalid-input/)
    expect(invoked).toBe(false)
    expect(() => projectMemoryRecordV1(
      new Proxy(fixture.request, {}) as MemoryProjectionRequestV1,
    )).toThrow(/invalid-input/)
  })

  it('rejects unknown fields, wrong source digests, duplicates, and output overflow', () => {
    const fixture = activeFixture()
    expect(() => projectMemoryRecordV1({
      ...fixture.request,
      unknown: true,
    } as MemoryProjectionRequestV1)).toThrow()
    expect(() => projectMemoryRecordV1({
      ...fixture.request,
      expectedSource: {
        ...fixture.request.expectedSource,
        historyDigest: `sha256:${'f'.repeat(64)}`,
      },
    })).toThrow(/source-mismatch/)
    expect(() => projectMemoryRecordV1({
      ...fixture.request,
      receipts: [...fixture.request.receipts, fixture.request.receipts[0]!],
    })).toThrow()
    expect(() => projectMemoryRecordV1({
      ...fixture.request,
      profile: { ...fixture.request.profile, maxOutputBytes: 1 },
    })).toThrow(/limit-exceeded/)
  })

  it('rejects projection tampering, nested unknown fields, and profile mismatch', () => {
    const fixture = activeFixture()
    const projection = projectMemoryRecordV1(fixture.request)
    const tampered = JSON.parse(JSON.stringify(projection)) as MemoryProjectionV1 & {
      extra?: boolean
    }
    tampered.extra = true
    expect(() => diffMemoryProjections(projection, tampered)).toThrow(/unknown-field/)

    const nested = JSON.parse(JSON.stringify(projection)) as MemoryProjectionV1
    ;(nested.records[0]!.governance as unknown as Record<string, unknown>).permission = true
    expect(() => diffMemoryProjections(projection, nested)).toThrow(/unknown-field/)

    const otherProfile = projectMemoryRecordV1({
      ...fixture.request,
      profile: { ...fixture.request.profile, maxRecords: fixture.request.profile.maxRecords + 1 },
    })
    expect(() => diffMemoryProjections(projection, otherProfile)).toThrow(/profile-mismatch/)
  })
})
