import { describe, expect, it } from 'vitest'

import {
  canonicalizeMemoryRecordV1,
  cloneMemoryRecordV1,
  decodeMemoryRecordV1,
  digestMemoryRecordV1,
  freezeMemoryRecordV1,
  MemoryRecordDecodeError,
} from '../index.js'
import { makeRecord, T0, T1, T2 } from './fixtures.js'

describe('MemoryRecordV1', () => {
  it('decodes a direct value and serialized round trip deterministically', () => {
    const input = makeRecord()
    const decoded = decodeMemoryRecordV1(input)
    const serialized = canonicalizeMemoryRecordV1(decoded)
    const roundTrip = decodeMemoryRecordV1(JSON.parse(serialized))

    expect(roundTrip).toEqual(decoded)
    expect(canonicalizeMemoryRecordV1(roundTrip)).toBe(serialized)
    expect(digestMemoryRecordV1(roundTrip)).toBe(digestMemoryRecordV1(decoded))
  })

  it('canonicalizes object property insertion order', () => {
    const first = makeRecord()
    const second = Object.fromEntries(Object.entries(first).reverse())
    second['scope'] = Object.fromEntries(Object.entries(first['scope'] as object).reverse())
    second['content'] = Object.fromEntries(Object.entries(first['content'] as object).reverse())

    expect(canonicalizeMemoryRecordV1(second)).toBe(canonicalizeMemoryRecordV1(first))
    expect(digestMemoryRecordV1(second)).toBe(digestMemoryRecordV1(first))
  })

  it('returns detached and deeply frozen records from every object helper', () => {
    const input = makeRecord()
    const decoded = decodeMemoryRecordV1(input)
    const cloned = cloneMemoryRecordV1(decoded)
    const frozen = freezeMemoryRecordV1(input)

    ;(input['scope'] as Record<string, unknown>)['tenantId'] = 'changed'
    expect(decoded.scope.tenantId).toBe('tenant-001')
    expect(cloned).not.toBe(decoded)
    expect(cloned.scope).not.toBe(decoded.scope)
    for (const value of [decoded, decoded.scope, decoded.provenance.evidenceRefs, frozen.quality]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it('offers a value-free safe failure result', () => {
    const result = decodeMemoryRecordV1({ schema: 'unknown' }, { safe: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MemoryRecordDecodeError)
      expect(result.error.code).toBe('invalid-schema')
      expect(result.error.message).not.toContain('unknown')
    }
  })

  it('accepts a minimal purged tombstone without retrievable payload', () => {
    const record = makeRecord({
      lifecycle: {
        status: 'purged',
        reasonCode: 'retention-complete',
        transitionSequence: 3,
        lastTransitionAt: T2,
      },
      temporal: { observedAt: T0, recordedAt: T1, updatedAt: T2 },
      content: undefined,
    })
    delete record['content']

    expect(decodeMemoryRecordV1(record).lifecycle.status).toBe('purged')
  })
})
