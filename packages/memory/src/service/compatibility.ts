import {
  observationCandidateValueDigest,
  type ObservationConfirmationReceipt,
} from '../observation-candidate-store.js'
import { adaptStagedRecordToV1 } from '../records/adapters.js'
import { objectValue, required } from '../records/decoder-primitives.js'
import type { MemoryRecordV1 } from '../records/types.js'
import { applyRecordTransition } from '../lifecycle/record-transitions.js'
import type { MemoryCommandV1 } from '../lifecycle/types.js'
import { transitionFail } from '../lifecycle/errors.js'
import { digestServiceValue, snapshotServiceJson } from './snapshot.js'

export function validateStagedCompatibilityV1(
  compatibility: { readonly stagedRecord: unknown; readonly confirmationReceipt?: unknown } | undefined,
  command: MemoryCommandV1,
): void {
  if (!compatibility) return
  const staged = compatibility.stagedRecord as Parameters<typeof adaptStagedRecordToV1>[0]
  const transition = applyRecordTransition(command, command.expectedSequence + 1)
  const candidates = [command.record, ...transition.records]
  const matched = candidates.some(record => compatibleRecord(staged, record))
  if (!matched) {
    transitionFail('policy-precondition', ['compatibility', 'stagedRecord'])
  }
  if (staged.stage === 'confirmed') {
    const receipt = decodeConfirmationReceipt(compatibility.confirmationReceipt)
    if (receipt.candidateKey !== staged.key
      || receipt.targetNamespace !== staged.namespace
      || receipt.memoryKey !== staged.key
      || receipt.candidateCreatedAt !== staged.createdAt
      || receipt.valueDigest !== observationCandidateValueDigest(staged)
      || digestScope(receipt.scope) !== digestScope(staged.scope)) {
      transitionFail('effect-precondition', ['compatibility', 'confirmationReceipt'])
    }
  } else if (compatibility.confirmationReceipt !== undefined) {
    transitionFail('effect-precondition', ['compatibility', 'confirmationReceipt'])
  }
}

function compatibleRecord(
  staged: Parameters<typeof adaptStagedRecordToV1>[0],
  record: MemoryRecordV1,
): boolean {
  let adapted: MemoryRecordV1
  try {
    adapted = adaptStagedRecordToV1(staged, {
      versionId: record.versionId,
      kind: record.kind,
      scope: record.scope,
      lifecycle: record.lifecycle,
      temporal: {
        observedAt: record.temporal.observedAt,
        ...(record.temporal.validFrom === undefined ? {} : { validFrom: record.temporal.validFrom }),
        ...(record.temporal.validTo === undefined ? {} : { validTo: record.temporal.validTo }),
        ...(record.temporal.lastVerifiedAt === undefined
          ? {}
          : { lastVerifiedAt: record.temporal.lastVerifiedAt }),
        ...(record.temporal.expiresAt === undefined ? {} : { expiresAt: record.temporal.expiresAt }),
        ...(record.temporal.sourceEventTime === undefined
          ? {}
          : { sourceEventTime: record.temporal.sourceEventTime }),
      },
      provenance: record.provenance,
      governance: record.governance,
      quality: {
        sourceTrust: record.quality.sourceTrust,
        ...(record.quality.extractionQuality === undefined
          ? {}
          : { extractionQuality: record.quality.extractionQuality }),
        freshnessState: record.quality.freshnessState,
        contradictionState: record.quality.contradictionState,
        verificationState: record.quality.verificationState,
      },
      ...(record.contentRef === undefined ? {} : { contentRef: record.contentRef }),
      ...(record.searchTextRef === undefined ? {} : { searchTextRef: record.searchTextRef }),
      tags: record.tags,
    })
  } catch {
    return false
  }
  const adaptedBinding = stagedBinding(adapted)
  const recordBinding = stagedBinding(record)
  return adaptedBinding !== undefined
    && recordBinding !== undefined
    && adaptedBinding === recordBinding
}

function stagedBinding(record: MemoryRecordV1): `sha256:${string}` | undefined {
  const content = record.content
  if (!content
    || content['format'] !== 'datazup.memory.staged-content/v1'
    || content['value'] === null
    || typeof content['value'] !== 'object'
    || Array.isArray(content['value'])
    || content['legacyStage'] === null
    || typeof content['legacyStage'] !== 'object'
    || Array.isArray(content['legacyStage'])) {
    return undefined
  }
  const legacyStage = content['legacyStage'] as Readonly<Record<string, unknown>>
  return digestServiceValue({
    schema: record.schema,
    memoryId: record.memoryId,
    versionId: record.versionId,
    kind: record.kind,
    scope: record.scope,
    lifecycle: record.lifecycle,
    temporal: record.temporal,
    provenance: record.provenance,
    governance: record.governance,
    quality: record.quality,
    tags: record.tags,
    stagedValue: content['value'],
    stagedConfidence: legacyStage['confidence'],
    stagedCreatedAt: legacyStage['createdAt'],
  })
}

function decodeConfirmationReceipt(input: unknown): ObservationConfirmationReceipt {
  const root = objectValue(snapshotServiceJson(input), ['compatibility', 'confirmationReceipt'], [
    'schema', 'candidateKey', 'targetNamespace', 'scope', 'memoryKey',
    'candidateCreatedAt', 'valueDigest', 'persistedAt',
  ])
  if (root['schema'] !== 'dzupagent/observation-confirmation-receipt/v1'
    || typeof root['candidateKey'] !== 'string'
    || typeof root['targetNamespace'] !== 'string'
    || typeof root['memoryKey'] !== 'string'
    || typeof root['candidateCreatedAt'] !== 'number'
    || typeof root['persistedAt'] !== 'number'
    || typeof root['valueDigest'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(root['valueDigest'])) {
    transitionFail('effect-precondition', ['compatibility', 'confirmationReceipt'])
  }
  const scope = objectValue(
    required(root, 'scope', ['compatibility', 'confirmationReceipt']),
    ['compatibility', 'confirmationReceipt', 'scope'],
  )
  if (!Object.values(scope).every(value => typeof value === 'string')) {
    transitionFail('effect-precondition', ['compatibility', 'confirmationReceipt', 'scope'])
  }
  return {
    schema: root['schema'],
    candidateKey: root['candidateKey'],
    targetNamespace: root['targetNamespace'],
    scope: scope as Record<string, string>,
    memoryKey: root['memoryKey'],
    candidateCreatedAt: root['candidateCreatedAt'],
    valueDigest: root['valueDigest'],
    persistedAt: root['persistedAt'],
  }
}

function digestScope(scope: Record<string, string>): string {
  return JSON.stringify(Object.entries(scope).sort(([left], [right]) =>
    left.localeCompare(right)))
}
