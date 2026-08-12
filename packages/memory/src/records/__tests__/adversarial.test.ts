import { describe, expect, it } from 'vitest'

import { decodeMemoryRecordV1, MemoryRecordDecodeError } from '../index.js'
import { contentDigest, makeRecord, T0, T1, T2 } from './fixtures.js'

function expectCode(input: unknown, code: MemoryRecordDecodeError['code']): void {
  try {
    decodeMemoryRecordV1(input)
    expect.fail('expected decoding to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryRecordDecodeError)
    expect((error as MemoryRecordDecodeError).code).toBe(code)
  }
}

describe('MemoryRecordV1 adversarial decoding', () => {
  it('rejects unknown fields and schema versions', () => {
    expectCode(makeRecord({ unexpected: true }), 'unknown-field')
    expectCode(makeRecord({ schema: 'datazup.memory.record/v2' }), 'invalid-schema')
  })

  it('rejects omitted scope and unknown nested scope fields', () => {
    const missing = makeRecord()
    delete missing['scope']
    expectCode(missing, 'invalid-value')
    expectCode(makeRecord({
      scope: { tenantId: 'tenant-001', namespace: 'lessons', broad: true },
    }), 'unknown-field')
  })

  it('does not execute getters', () => {
    let calls = 0
    const input = makeRecord()
    Object.defineProperty(input, 'memoryId', {
      enumerable: true,
      get() {
        calls += 1
        return 'memory-001'
      },
    })

    expectCode(input, 'accessor-property')
    expect(calls).toBe(0)
  })

  it('rejects custom prototypes, symbols, cycles, and sparse arrays', () => {
    expectCode(Object.assign(Object.create({ inherited: true }), makeRecord()), 'unsafe-object')
    const symbol = makeRecord()
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
    expectCode(symbol, 'unsafe-object')
    const cyclic = makeRecord()
    ;(cyclic['content'] as Record<string, unknown>)['cycle'] = cyclic
    expectCode(cyclic, 'cyclic-value')
    const sparse = makeRecord({ tags: new Array(2) })
    expectCode(sparse, 'unsafe-object')
  })

  it('rejects proxies before invoking their object traps', () => {
    let calls = 0
    const proxy = new Proxy(makeRecord(), {
      getPrototypeOf(target) {
        calls += 1
        return Reflect.getPrototypeOf(target)
      },
    })
    expectCode(proxy, 'unsafe-object')
    expect(calls).toBe(0)
  })

  it('rejects excessive depth, width, and bytes', () => {
    let deep: Record<string, unknown> = { end: true }
    for (let index = 0; index < 15; index += 1) deep = { nested: deep }
    expectCode(makeRecord({ content: deep }), 'limit-exceeded')

    const wide = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index]))
    expectCode(makeRecord({ content: wide }), 'limit-exceeded')
    expectCode(makeRecord({ content: { text: 'x'.repeat(65 * 1024) } }), 'limit-exceeded')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0])(
    'rejects unsupported numeric value %s',
    value => expectCode(makeRecord({
      quality: {
        confidence: value,
        sourceTrust: 0.8,
        freshnessState: 'unknown',
        contradictionState: 'none',
        verificationState: 'unverified',
      },
    }), 'unsupported-value'),
  )

  it('rejects invalid time order and non-canonical timestamps', () => {
    expectCode(makeRecord({
      temporal: { observedAt: T2, recordedAt: T1, updatedAt: T2 },
    }), 'invalid-time-order')
    expectCode(makeRecord({
      temporal: { observedAt: '2026-08-11T10:00:00Z', recordedAt: T1, updatedAt: T2 },
    }), 'invalid-value')
    expectCode(makeRecord({
      temporal: { observedAt: T0, recordedAt: T1, updatedAt: T2, validFrom: T2, validTo: T1 },
    }), 'invalid-time-order')
  })

  it('checks inline and referenced content digests', () => {
    expectCode(makeRecord({ contentDigest: `sha256:${'0'.repeat(64)}` }), 'invalid-content-digest')
    const contentRef = {
      schema: 'datazup.memory.content-ref/v1',
      owner: 'blob-store',
      id: 'content-001',
      digest: `sha256:${'3'.repeat(64)}`,
      mediaType: 'application/json',
      byteLength: 128,
    }
    const referenced = makeRecord({
      content: undefined,
      contentRef,
      contentDigest: contentRef.digest,
    })
    delete referenced['content']
    expect(decodeMemoryRecordV1(referenced).contentRef).toEqual(contentRef)
    expectCode({ ...referenced, contentDigest: `sha256:${'4'.repeat(64)}` }, 'invalid-content-digest')
  })

  it('requires references for restricted, document, and oversized content', () => {
    const restricted = makeRecord({
      governance: {
        sensitivity: 'restricted',
        retentionPolicyId: 'restricted-memory',
        retentionPolicyVersion: 'v1',
        accessPolicyRef: 'access-001',
        writePolicyRef: 'write-001',
        legalHold: false,
        exportable: false,
        userVisible: false,
      },
    })
    expectCode(restricted, 'invalid-value')
    expectCode(makeRecord({ kind: 'document-ref' }), 'invalid-value')
    const large = { text: 'x'.repeat(17 * 1024) }
    expectCode(makeRecord({ content: large, contentDigest: contentDigest(large) }), 'limit-exceeded')
  })

  it('rejects sensitive metadata keys, raw paths, authority flags, and duplicate tags', () => {
    for (const content of [
      { password: 'invented-value' },
      { rawPrompt: 'invented prompt' },
      { operationalReceipt: 'receipt-001' },
      { authorityGranted: true },
      { location: '/invented/private/path' },
    ]) {
      expectCode(makeRecord({ content, contentDigest: contentDigest(content) }), 'invalid-value')
    }
    expectCode(makeRecord({ tags: ['same', 'same'] }), 'invalid-value')
  })
})
