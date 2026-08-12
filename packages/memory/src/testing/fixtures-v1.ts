import { digestMemoryRecordV1 } from '../records/canonical.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import { digestSafeJson, snapshotSafeJson } from '../records/safe-json.js'
import type {
  MemoryCommandV1,
  MemoryLifecycleStateV1,
} from '../lifecycle/types.js'
import type {
  MemoryKindV1,
  MemoryRecordV1,
  MemoryScopeV1,
  MemorySensitivityClassV1,
  MemoryStatusV1,
} from '../records/types.js'

export const MEMORY_CONFORMANCE_FIXTURE_VERSION = 'mem-p005-invented-v1'
export const MEMORY_CONFORMANCE_CANARY = 'INVENTED_CANARY_ALPHA_7F9D'

export const CONFORMANCE_SCOPE: MemoryScopeV1 = Object.freeze({
  tenantId: 'tenant-conformance-a',
  workspaceId: 'workspace-conformance',
  projectId: 'project-conformance',
  namespace: 'memory-conformance',
})

export const OTHER_CONFORMANCE_SCOPE: MemoryScopeV1 = Object.freeze({
  ...CONFORMANCE_SCOPE,
  tenantId: 'tenant-conformance-b',
})

const REASONS: Record<MemoryCommandV1['type'], string> = {
  capture: 'explicit-remember',
  assess: 'novel',
  'require-review': 'policy-required',
  promote: 'policy-admitted',
  confirm: 'human-confirmed',
  reject: 'review-rejected',
  correct: 'user-correction',
  dispute: 'contradictory-evidence',
  resolve: 'review-resolved',
  revoke: 'user-forgot',
  expire: 'retention-expired',
  archive: 'retention-archive',
  'propose-purge': 'user-purge',
}

export function conformanceInstant(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 11, 12, 0, offsetSeconds)).toISOString()
}

interface FixtureRecordOptions {
  readonly memoryId?: string
  readonly versionId?: string
  readonly kind?: MemoryKindV1
  readonly scope?: MemoryScopeV1
  readonly status?: MemoryStatusV1
  readonly sensitivity?: MemorySensitivityClassV1
  readonly text?: string
  readonly transitionSequence?: number
  readonly updatedAt?: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly expiresAt?: string
  readonly sourceTrust?: number
  readonly legalHold?: boolean
  readonly tags?: readonly string[]
}

export function createConformanceRecord(
  options: FixtureRecordOptions = {},
): MemoryRecordV1 {
  const memoryId = options.memoryId ?? 'memory-conformance-001'
  const versionId = options.versionId ?? 'version-conformance-001'
  const updatedAt = options.updatedAt ?? conformanceInstant(2)
  const content = {
    summary: options.text ?? 'An original provider-free memory conformance fixture.',
  }
  return decodeMemoryRecordV1({
    schema: 'datazup.memory.record/v1',
    memoryId,
    versionId,
    kind: options.kind ?? 'fact',
    scope: options.scope ?? CONFORMANCE_SCOPE,
    lifecycle: {
      status: options.status ?? 'active',
      reasonCode: options.status === 'captured' ? 'explicit-remember' : 'review-admitted',
      transitionSequence: options.transitionSequence ?? 3,
      lastTransitionAt: updatedAt,
    },
    temporal: {
      observedAt: conformanceInstant(0),
      recordedAt: conformanceInstant(1),
      updatedAt,
      validFrom: options.validFrom ?? conformanceInstant(0),
      ...(options.validTo === undefined ? {} : { validTo: options.validTo }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      lastVerifiedAt: updatedAt,
    },
    provenance: {
      sourceKind: 'application',
      sourceId: `source-${memoryId}-${versionId}`,
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      evidenceRefs: [{
        schema: 'datazup.memory.evidence-ref/v1',
        kind: 'application-event',
        owner: 'invented-conformance-host',
        id: `evidence-${memoryId}`,
        digest: `sha256:${'2'.repeat(64)}`,
        observedAt: conformanceInstant(0),
        sensitivity: options.sensitivity ?? 'internal',
      }],
      createdByRef: 'forge://invented/conformance-writer',
    },
    governance: {
      sensitivity: options.sensitivity ?? 'internal',
      retentionPolicyId: 'provider-free-conformance',
      retentionPolicyVersion: 'v1',
      accessPolicyRef: 'access-conformance-v1',
      writePolicyRef: 'write-conformance-v1',
      legalHold: options.legalHold ?? false,
      exportable: false,
      userVisible: true,
    },
    quality: {
      confidence: 0.8,
      sourceTrust: options.sourceTrust ?? 0.9,
      extractionQuality: 0.8,
      freshnessState: 'current',
      contradictionState: 'none',
      verificationState: 'human-reviewed',
    },
    contentDigest: digestSafeJson(snapshotSafeJson(content)),
    content,
    tags: options.tags ?? ['invented', 'conformance'],
  })
}

export function createCapturedConformanceRecord(
  options: Omit<FixtureRecordOptions, 'status' | 'transitionSequence'> = {},
): MemoryRecordV1 {
  return createConformanceRecord({
    ...options,
    status: 'captured',
    transitionSequence: 1,
    updatedAt: options.updatedAt ?? conformanceInstant(1),
  })
}

export function createReplacementConformanceRecord(
  prior: MemoryRecordV1,
  versionId: string,
  transitionAt: string,
  transitionSequence: number,
  text = 'An invented corrected memory conformance fixture.',
): MemoryRecordV1 {
  const content = { summary: text }
  return decodeMemoryRecordV1({
    ...prior,
    versionId,
    lifecycle: {
      status: 'active',
      priorVersionId: prior.versionId,
      supersedesVersionId: prior.versionId,
      reasonCode: 'user-correction',
      transitionSequence,
      lastTransitionAt: transitionAt,
    },
    temporal: {
      ...prior.temporal,
      observedAt: transitionAt,
      recordedAt: transitionAt,
      updatedAt: transitionAt,
      validFrom: transitionAt,
      lastVerifiedAt: transitionAt,
    },
    provenance: {
      ...prior.provenance,
      sourceId: `source-${versionId}`,
      sourceDigest: `sha256:${'3'.repeat(64)}`,
    },
    content,
    contentDigest: digestSafeJson(snapshotSafeJson(content)),
  })
}

export function createCaptureCommand(
  record: MemoryRecordV1,
  overrides: Record<string, unknown> = {},
): MemoryCommandV1 {
  return {
    schema: 'datazup.memory.command/v1',
    type: 'capture',
    commandId: `capture-command-${record.memoryId}`,
    eventId: `capture-event-${record.memoryId}`,
    receiptId: `capture-receipt-${record.memoryId}`,
    idempotencyKey: `capture-idempotency-${record.memoryId}`,
    memoryId: record.memoryId,
    generation: 1,
    expectedSequence: 0,
    transitionAt: record.lifecycle.lastTransitionAt,
    actorRef: 'forge://invented/conformance-writer',
    decisionRef: 'decision-conformance-capture',
    reasonCode: 'explicit-remember',
    evidenceRefs: record.provenance.evidenceRefs,
    record,
    ...overrides,
  } as MemoryCommandV1
}

export function createTransitionCommand(
  type: Exclude<MemoryCommandV1['type'], 'capture'>,
  state: Pick<MemoryLifecycleStateV1, 'generation' | 'sequence'>,
  record: MemoryRecordV1,
  overrides: Record<string, unknown> = {},
): MemoryCommandV1 {
  const next = state.sequence + 1
  const identity = `${state.generation}-${next}-${type}`
  return {
    schema: 'datazup.memory.command/v1',
    type,
    commandId: `command-${identity}`,
    eventId: `event-${identity}`,
    receiptId: `receipt-${identity}`,
    idempotencyKey: `idempotency-${identity}`,
    memoryId: record.memoryId,
    generation: state.generation,
    expectedSequence: state.sequence,
    transitionAt: conformanceInstant(next),
    actorRef: 'forge://invented/conformance-writer',
    decisionRef: `decision-${identity}`,
    reasonCode: REASONS[type],
    evidenceRefs: record.provenance.evidenceRefs,
    record,
    expectedVersionId: record.versionId,
    expectedRecordDigest: digestMemoryRecordV1(record),
    ...overrides,
  } as MemoryCommandV1
}

export function currentRecordForDigest(
  records: readonly MemoryRecordV1[],
  digest: string,
): MemoryRecordV1 {
  const record = records.find(entry => digestMemoryRecordV1(entry) === digest)
  if (!record) throw new Error('current record missing')
  return record
}
