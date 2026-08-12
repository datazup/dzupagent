import {
  canonicalizeMemoryRecordV1,
  cloneMemoryRecordV1,
  decodeMemoryRecordV1,
  digestMemoryRecordV1,
  freezeMemoryRecordV1,
} from '../records/index.js'
import { digestSafeJson, snapshotSafeJson } from '../records/safe-json.js'
import type { MemoryRecordV1 } from '../records/types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  createConformanceRecord,
  MEMORY_CONFORMANCE_FIXTURE_VERSION,
} from './fixtures-v1.js'

/** Build the deterministic canonical-record conformance suite. */
export function createMemoryRecordConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-record-conformance',
    suiteVersion: 'v1',
    domain: 'record',
    fixtureSetId: 'invented-record-contracts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'record.canonical-round-trip',
      capability: 'canonical-digest',
      expected: 'pass',
      run: async () => canonicalRoundTrip(),
    }, {
      id: 'record.hostile-object-boundary',
      capability: 'hostile-decoding',
      expected: 'pass',
      run: async () => hostileObjectBoundary(),
    }, {
      id: 'record.scope-required',
      capability: 'scope-isolation',
      expected: 'pass',
      run: async () => scopeRequired(),
    }, {
      id: 'record.metadata-cannot-grant-authority',
      capability: 'authority-separation',
      expected: 'pass',
      run: async () => metadataCannotGrantAuthority(),
    }, {
      id: 'record.restricted-content-by-reference',
      capability: 'sensitive-content-custody',
      expected: 'pass',
      run: async () => restrictedContentByReference(),
    }],
  })
}

function canonicalRoundTrip() {
  const record = createConformanceRecord()
  const reordered = reorderTopLevel(record)
  const decoded = decodeMemoryRecordV1(reordered)
  const clone = cloneMemoryRecordV1(decoded)
  const frozen = freezeMemoryRecordV1(decoded)
  const stable = digestMemoryRecordV1(record) === digestMemoryRecordV1(decoded)
    && canonicalizeMemoryRecordV1(record) === canonicalizeMemoryRecordV1(decoded)
    && clone !== decoded
    && Object.isFrozen(frozen)
    && Object.isFrozen(frozen.scope)
  return {
    passed: stable,
    reasonCode: stable ? 'canonical-round-trip' : 'canonical-round-trip-mismatch',
    evidenceDigests: [digestMemoryRecordV1(decoded)],
  }
}

function hostileObjectBoundary() {
  let invoked = false
  const withGetter = { ...createConformanceRecord() } as Record<string, unknown>
  Object.defineProperty(withGetter, 'unexpected', {
    enumerable: true,
    get() {
      invoked = true
      return 'must-not-run'
    },
  })
  const getterRejected = rejects(() => decodeMemoryRecordV1(withGetter))
  const proxyRejected = rejects(() => decodeMemoryRecordV1(new Proxy({}, {})))
  const cyclic = { ...createConformanceRecord() } as Record<string, unknown>
  cyclic['cycle'] = cyclic
  const cycleRejected = rejects(() => decodeMemoryRecordV1(cyclic))
  const passed = getterRejected && !invoked && proxyRejected && cycleRejected
  return {
    passed,
    reasonCode: passed ? 'hostile-input-rejected' : 'hostile-input-admitted',
  }
}

function scopeRequired() {
  const record = createConformanceRecord()
  const missingTenant = {
    ...record,
    scope: { namespace: record.scope.namespace },
  }
  const broadened = {
    ...record,
    scope: { tenantId: record.scope.tenantId },
  }
  const passed = rejects(() => decodeMemoryRecordV1(missingTenant))
    && rejects(() => decodeMemoryRecordV1(broadened))
  return {
    passed,
    reasonCode: passed ? 'scope-required' : 'scope-omission-admitted',
  }
}

function metadataCannotGrantAuthority() {
  const record = createConformanceRecord()
  const authorityContent = {
    summary: 'Invented authority-adjacent content.',
    authorityGranted: true,
  }
  const secretContent = {
    summary: 'Invented secret-key content.',
    secret: 'invented-value',
  }
  const authority = {
    ...record,
    content: authorityContent,
    contentDigest: digestSafeJson(snapshotSafeJson(authorityContent)),
  }
  const secret = {
    ...record,
    content: secretContent,
    contentDigest: digestSafeJson(snapshotSafeJson(secretContent)),
  }
  const passed = rejects(() => decodeMemoryRecordV1(authority))
    && rejects(() => decodeMemoryRecordV1(secret))
  return {
    passed,
    reasonCode: passed ? 'authority-and-secret-rejected' : 'unsafe-metadata-admitted',
  }
}

function restrictedContentByReference() {
  const base = createConformanceRecord()
  const record = {
    ...base,
    provenance: {
      ...base.provenance,
      evidenceRefs: base.provenance.evidenceRefs.map(reference => ({
        ...reference,
        sensitivity: 'restricted' as const,
      })),
    },
    governance: {
      ...base.governance,
      sensitivity: 'restricted' as const,
    },
  }
  const { content: _content, ...withoutContent } = record
  const referenceRecord = decodeMemoryRecordV1({
    ...withoutContent,
    contentRef: {
      schema: 'datazup.memory.content-ref/v1',
      owner: 'invented-content-custodian',
      id: 'content-reference-001',
      digest: record.contentDigest,
      mediaType: 'application/json',
      byteLength: 128,
    },
  })
  const inlineRejected = rejects(() => decodeMemoryRecordV1(record))
  const passed = inlineRejected
    && referenceRecord.content === undefined
    && referenceRecord.contentRef?.digest === record.contentDigest
  return {
    passed,
    reasonCode: passed ? 'restricted-reference-only' : 'restricted-inline-admitted',
    evidenceDigests: [digestMemoryRecordV1(referenceRecord)],
  }
}

function reorderTopLevel(record: MemoryRecordV1): Record<string, unknown> {
  return {
    tags: record.tags,
    content: record.content,
    contentDigest: record.contentDigest,
    quality: record.quality,
    governance: record.governance,
    provenance: record.provenance,
    temporal: record.temporal,
    lifecycle: record.lifecycle,
    scope: record.scope,
    kind: record.kind,
    versionId: record.versionId,
    memoryId: record.memoryId,
    schema: record.schema,
  }
}

function rejects(operation: () => unknown): boolean {
  try {
    operation()
    return false
  } catch {
    return true
  }
}
