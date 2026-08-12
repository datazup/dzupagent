import { decodeMemoryRecordV1, digestMemoryRecordV1 } from '../../records/index.js'
import { contentDigest, makeRecord } from '../../records/__tests__/fixtures.js'
import type { MemoryRecordV1 } from '../../records/types.js'
import type { MemoryCommandV1, MemoryLifecycleStateV1 } from '../types.js'

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

export function time(offset: number): string {
  return new Date(Date.UTC(2026, 7, 11, 10, 0, offset)).toISOString()
}

export function makeCapturedRecord(options: {
  readonly versionId?: string
  readonly expiresAt?: string
  readonly legalHold?: boolean
  readonly contentText?: string
} = {}): MemoryRecordV1 {
  const content = { summary: options.contentText ?? 'A bounded lifecycle fixture.' }
  return decodeMemoryRecordV1(makeRecord({
    versionId: options.versionId ?? 'version-001',
    lifecycle: {
      status: 'captured',
      reasonCode: 'explicit-remember',
      transitionSequence: 1,
      lastTransitionAt: time(1),
    },
    temporal: {
      observedAt: time(0),
      recordedAt: time(1),
      updatedAt: time(1),
      validFrom: time(0),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
    governance: {
      sensitivity: 'internal',
      retentionPolicyId: 'working-memory',
      retentionPolicyVersion: 'v1',
      accessPolicyRef: 'access-001',
      writePolicyRef: 'write-001',
      legalHold: options.legalHold ?? false,
      exportable: false,
      userVisible: true,
    },
    content,
    contentDigest: contentDigest(content),
  }))
}

export function makeReplacement(
  prior: MemoryRecordV1,
  versionId: string,
  transitionAt: string,
  transitionSequence: number,
  contentText = 'A corrected bounded lifecycle fixture.',
): MemoryRecordV1 {
  const content = { summary: contentText }
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
    contentDigest: contentDigest(content),
  })
}

export function makeCaptureCommand(
  record: MemoryRecordV1 = makeCapturedRecord(),
  overrides: Record<string, unknown> = {},
): MemoryCommandV1 {
  return {
    schema: 'datazup.memory.command/v1',
    type: 'capture',
    commandId: 'command-001',
    eventId: 'event-001',
    receiptId: 'receipt-001',
    idempotencyKey: 'idempotency-001',
    memoryId: record.memoryId,
    generation: 1,
    expectedSequence: 0,
    transitionAt: record.lifecycle.lastTransitionAt,
    actorRef: 'forge://sample/memory-writer',
    decisionRef: 'decision-001',
    reasonCode: 'explicit-remember',
    evidenceRefs: record.provenance.evidenceRefs,
    record,
    ...overrides,
  } as MemoryCommandV1
}

export function makeCommand(
  type: Exclude<MemoryCommandV1['type'], 'capture'>,
  state: MemoryLifecycleStateV1,
  record: MemoryRecordV1,
  overrides: Record<string, unknown> = {},
): MemoryCommandV1 {
  const sequence = state.sequence + 1
  return {
    schema: 'datazup.memory.command/v1',
    type,
    commandId: `command-${sequence.toString().padStart(3, '0')}`,
    eventId: `event-${sequence.toString().padStart(3, '0')}`,
    receiptId: `receipt-${sequence.toString().padStart(3, '0')}`,
    idempotencyKey: `idempotency-${sequence.toString().padStart(3, '0')}`,
    memoryId: record.memoryId,
    generation: state.generation,
    expectedSequence: state.sequence,
    transitionAt: time(sequence),
    actorRef: 'forge://sample/memory-writer',
    decisionRef: `decision-${sequence.toString().padStart(3, '0')}`,
    reasonCode: REASONS[type],
    evidenceRefs: record.provenance.evidenceRefs,
    record,
    expectedVersionId: record.versionId,
    expectedRecordDigest: digestMemoryRecordV1(record),
    ...overrides,
  } as MemoryCommandV1
}

export const ARCHIVE_RECEIPT_REF = {
  owner: 'archive-custodian',
  id: 'archive-receipt-001',
  digest: `sha256:${'4'.repeat(64)}` as const,
}

export const PURGE_TARGET_REFS = [{
  owner: 'memory-store',
  id: 'target-001',
  digest: `sha256:${'5'.repeat(64)}` as const,
}, {
  owner: 'memory-index',
  id: 'target-002',
  digest: `sha256:${'6'.repeat(64)}` as const,
}]
