import type { MemoryCommandV1 } from '../../lifecycle/types.js'
import { digestMemoryRecordV1 } from '../../records/canonical.js'
import { decodeMemoryRecordV1 } from '../../records/decoder.js'
import { digestSafeJson, snapshotSafeJson } from '../../records/safe-json.js'
import type { MemoryRecordV1, MemoryScopeV1 } from '../../records/types.js'
import type {
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryLifecycleWriteResultV1,
} from '../types.js'

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

export const DEFAULT_SCOPE: MemoryScopeV1 = {
  tenantId: 'tenant-001',
  workspaceId: 'workspace-001',
  projectId: 'project-001',
  namespace: 'lessons',
}

export function instant(offset: number): string {
  return new Date(Date.UTC(2026, 7, 11, 10, 0, offset)).toISOString()
}

export function capturedRecord(options: {
  readonly memoryId?: string
  readonly versionId?: string
  readonly scope?: MemoryScopeV1
  readonly content?: string
  readonly legalHold?: boolean
} = {}): MemoryRecordV1 {
  const memoryId = options.memoryId ?? 'memory-001'
  const versionId = options.versionId ?? 'version-001'
  const scope = options.scope ?? DEFAULT_SCOPE
  const content = { summary: options.content ?? 'A bounded lifecycle service fixture.' }
  return decodeMemoryRecordV1({
    schema: 'datazup.memory.record/v1',
    memoryId,
    versionId,
    kind: 'fact',
    scope,
    lifecycle: {
      status: 'captured',
      reasonCode: 'explicit-remember',
      transitionSequence: 1,
      lastTransitionAt: instant(1),
    },
    temporal: {
      observedAt: instant(0),
      recordedAt: instant(1),
      updatedAt: instant(1),
      validFrom: instant(0),
    },
    provenance: {
      sourceKind: 'application',
      sourceId: `source-${memoryId}`,
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      evidenceRefs: [{
        schema: 'datazup.memory.evidence-ref/v1',
        kind: 'application-event',
        owner: 'sample-app',
        id: `evidence-${memoryId}`,
        digest: `sha256:${'2'.repeat(64)}`,
        observedAt: instant(0),
        sensitivity: 'internal',
      }],
      createdByRef: 'forge://sample/memory-writer',
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
    quality: {
      confidence: 0.8,
      sourceTrust: 0.9,
      freshnessState: 'current',
      contradictionState: 'none',
      verificationState: 'human-reviewed',
    },
    contentDigest: digestSafeJson(snapshotSafeJson(content)),
    content,
    tags: ['service-fixture'],
  })
}

export function replacementRecord(
  prior: MemoryRecordV1,
  versionId: string,
  transitionAt: string,
  transitionSequence: number,
  contentText = 'Corrected lifecycle service fixture.',
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
    contentDigest: digestSafeJson(snapshotSafeJson(content)),
    content,
  })
}

export function captureInput(
  record: MemoryRecordV1,
  overrides: Record<string, unknown> = {},
): InternalMemoryLifecycleWriteInputV1 {
  return {
    scope: record.scope,
    command: {
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
      actorRef: 'forge://sample/memory-writer',
      decisionRef: 'decision-capture',
      reasonCode: 'explicit-remember',
      evidenceRefs: record.provenance.evidenceRefs,
      record,
      ...overrides,
    } as MemoryCommandV1,
  }
}

export function transitionInput(
  type: Exclude<MemoryCommandV1['type'], 'capture'>,
  record: MemoryRecordV1,
  generation: number,
  expectedSequence: number,
  timeOffset: number,
  overrides: Record<string, unknown> = {},
): InternalMemoryLifecycleWriteInputV1 {
  const identity = `${generation}-${expectedSequence + 1}-${type}`
  return {
    scope: record.scope,
    command: {
      schema: 'datazup.memory.command/v1',
      type,
      commandId: `command-${identity}`,
      eventId: `event-${identity}`,
      receiptId: `receipt-${identity}`,
      idempotencyKey: `idempotency-${identity}`,
      memoryId: record.memoryId,
      generation,
      expectedSequence,
      transitionAt: instant(timeOffset),
      actorRef: 'forge://sample/memory-writer',
      decisionRef: `decision-${identity}`,
      reasonCode: REASONS[type],
      evidenceRefs: record.provenance.evidenceRefs,
      record,
      expectedVersionId: record.versionId,
      expectedRecordDigest: digestMemoryRecordV1(record),
      ...overrides,
    } as MemoryCommandV1,
  }
}

export function currentRecord(result: InternalMemoryLifecycleWriteResultV1): MemoryRecordV1 {
  if (!result.event) throw new Error('write result has no event')
  const record = result.records.find(entry =>
    digestMemoryRecordV1(entry) === result.event!.currentRecordDigest)
  if (!record) throw new Error('write result has no current record')
  return record
}

export const INVALIDATION_TARGETS = [{
  kind: 'cache' as const,
  owner: 'memory-cache',
  id: 'cache-entry-001',
  digest: `sha256:${'4'.repeat(64)}` as const,
}, {
  kind: 'index' as const,
  owner: 'memory-index',
  id: 'index-entry-001',
  digest: `sha256:${'5'.repeat(64)}` as const,
}]
