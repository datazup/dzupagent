import { decodeMemoryRecordV1 } from '../records/decoder.js'
import type { MemoryRecordV1, MemoryStatusV1 } from '../records/types.js'
import { transitionFail } from './errors.js'
import type { MemoryCommandV1, MemoryEventV1 } from './types.js'
import {
  digestLifecycleValue,
  recordDigest,
  timestampMillis,
} from './validation.js'

interface InternalTransitionResult {
  readonly records: readonly MemoryRecordV1[]
  readonly currentRecord: MemoryRecordV1
  readonly currentRecordDigest: `sha256:${string}`
  readonly currentStatus: MemoryStatusV1
  readonly recordEffects: MemoryEventV1['recordEffects']
  readonly effect: MemoryEventV1['effect']
}

const TERMINAL_STATUSES = new Set<MemoryStatusV1>(['purged'])

export function applyRecordTransition(
  command: MemoryCommandV1,
  nextSequence: number,
): InternalTransitionResult {
  if (command.type === 'capture') return applyCapture(command, nextSequence)
  validateTransitionTime(command.record, command.transitionAt)
  const targetStatus = targetStatusFor(command)
  assertLegalTransition(command.record.lifecycle.status, command.type, targetStatus)

  if (command.type === 'correct') return applyCorrection(command, nextSequence)
  if (command.type === 'propose-purge') return applyPurgeProposal(command)
  if (command.type === 'expire') validateExpiry(command.record, command.transitionAt)

  const supersession = command.type === 'resolve'
    && command.resolutionStatus === 'superseded'
    ? {
        supersededByVersionId: command.supersededByVersionId!,
        supersedingRecordDigest: command.supersedingRecordDigest!,
      }
    : {}
  const updated = transitionRecord(
    command.record,
    targetStatus,
    command.reasonCode,
    command.transitionAt,
    nextSequence,
    supersession.supersededByVersionId,
  )
  const priorDigest = recordDigest(command.record)
  const resultDigest = recordDigest(updated)
  const effect = command.type === 'archive'
    ? { kind: 'archive-recorded' as const, receiptRef: command.archiveReceiptRef }
    : { kind: 'none' as const }
  return {
    records: [updated],
    currentRecord: updated,
    currentRecordDigest: resultDigest,
    currentStatus: targetStatus,
    recordEffects: [{
      versionId: updated.versionId,
      priorDigest,
      resultDigest,
      statusFrom: command.record.lifecycle.status,
      statusTo: targetStatus,
      ...(supersession.supersededByVersionId === undefined ? {} : {
        supersededByVersionId: supersession.supersededByVersionId,
        supersedingRecordDigest: supersession.supersedingRecordDigest,
      }),
    }],
    effect,
  }
}

function applyCapture(
  command: Extract<MemoryCommandV1, { type: 'capture' }>,
  nextSequence: number,
): InternalTransitionResult {
  const { record } = command
  if (nextSequence !== 1
    || record.lifecycle.status !== 'captured'
    || record.lifecycle.transitionSequence !== nextSequence
    || record.lifecycle.lastTransitionAt !== command.transitionAt
    || record.lifecycle.reasonCode !== command.reasonCode
    || record.temporal.updatedAt !== command.transitionAt) {
    transitionFail('invalid-command', ['record', 'lifecycle'])
  }
  const resultDigest = recordDigest(record)
  return {
    records: [record],
    currentRecord: record,
    currentRecordDigest: resultDigest,
    currentStatus: 'captured',
    recordEffects: [{
      versionId: record.versionId,
      resultDigest,
      statusTo: 'captured',
    }],
    effect: { kind: 'none' },
  }
}

function applyCorrection(
  command: Extract<MemoryCommandV1, { type: 'correct' }>,
  nextSequence: number,
): InternalTransitionResult {
  const { record, replacement } = command
  if (replacement.memoryId !== record.memoryId) {
    transitionFail('identity-mismatch', ['replacement', 'memoryId'])
  }
  if (replacement.versionId === record.versionId) {
    transitionFail('stale-version', ['replacement', 'versionId'])
  }
  if (replacement.kind !== record.kind
    || digestLifecycleValue(replacement.scope) !== digestLifecycleValue(record.scope)
    || digestLifecycleValue(replacement.governance) !== digestLifecycleValue(record.governance)) {
    transitionFail('policy-precondition', ['replacement'])
  }
  if (replacement.lifecycle.status !== 'active'
    || replacement.lifecycle.priorVersionId !== record.versionId
    || replacement.lifecycle.supersedesVersionId !== record.versionId
    || replacement.lifecycle.supersededByVersionId !== undefined
    || replacement.lifecycle.revokesVersionId !== undefined
    || replacement.lifecycle.reasonCode !== command.reasonCode
    || replacement.lifecycle.transitionSequence !== nextSequence
    || replacement.lifecycle.lastTransitionAt !== command.transitionAt
    || replacement.temporal.updatedAt !== command.transitionAt) {
    transitionFail('invalid-command', ['replacement', 'lifecycle'])
  }
  validateTransitionTime(replacement, command.transitionAt)

  const successorDigest = recordDigest(replacement)
  const priorDigest = recordDigest(record)
  const superseded = transitionRecord(
    record,
    'superseded',
    command.reasonCode,
    command.transitionAt,
    nextSequence,
    replacement.versionId,
  )
  const supersededDigest = recordDigest(superseded)
  return {
    records: [superseded, replacement],
    currentRecord: replacement,
    currentRecordDigest: successorDigest,
    currentStatus: 'active',
    recordEffects: [
      {
        versionId: record.versionId,
        priorDigest,
        resultDigest: supersededDigest,
        statusFrom: 'active',
        statusTo: 'superseded',
        supersededByVersionId: replacement.versionId,
        supersedingRecordDigest: successorDigest,
      },
      {
        versionId: replacement.versionId,
        resultDigest: successorDigest,
        statusTo: 'active',
        supersedesVersionId: record.versionId,
      },
    ],
    effect: { kind: 'none' },
  }
}

function applyPurgeProposal(
  command: Extract<MemoryCommandV1, { type: 'propose-purge' }>,
): InternalTransitionResult {
  if (command.record.governance.legalHold) transitionFail('legal-hold', ['record', 'governance'])
  const digest = recordDigest(command.record)
  return {
    records: [],
    currentRecord: command.record,
    currentRecordDigest: digest,
    currentStatus: command.record.lifecycle.status,
    recordEffects: [{
      versionId: command.record.versionId,
      priorDigest: digest,
      resultDigest: digest,
      statusFrom: command.record.lifecycle.status,
      statusTo: command.record.lifecycle.status,
    }],
    effect: {
      kind: 'purge-proposed',
      targetRefs: command.purgeTargetRefs,
      tombstone: {
        schema: 'datazup.memory.purge-proposal-tombstone/v1',
        memoryId: command.memoryId,
        versionId: command.record.versionId,
        recordDigest: digest,
        proposalEventId: command.eventId,
        idempotencyKey: command.idempotencyKey,
      },
    },
  }
}

function targetStatusFor(command: Exclude<MemoryCommandV1, { type: 'capture' }>): MemoryStatusV1 {
  switch (command.type) {
    case 'assess': return 'candidate'
    case 'require-review': return 'review-required'
    case 'promote':
    case 'confirm':
    case 'correct': return 'active'
    case 'reject': return 'rejected'
    case 'dispute': return 'disputed'
    case 'resolve': return command.resolutionStatus
    case 'revoke': return 'revoked'
    case 'expire': return 'expired'
    case 'archive': return 'archived'
    case 'propose-purge': return command.record.lifecycle.status
  }
}

function assertLegalTransition(
  from: MemoryStatusV1,
  type: Exclude<MemoryCommandV1['type'], 'capture'>,
  to: MemoryStatusV1,
): void {
  if (TERMINAL_STATUSES.has(from)) transitionFail('terminal-transition', ['record', 'lifecycle', 'status'])
  const legal =
    (type === 'assess' && from === 'captured' && to === 'candidate')
    || (type === 'require-review' && from === 'candidate' && to === 'review-required')
    || (type === 'promote' && from === 'candidate' && to === 'active')
    || (type === 'confirm' && from === 'review-required' && to === 'active')
    || (type === 'reject' && ['captured', 'candidate', 'review-required', 'active', 'disputed'].includes(from))
    || (type === 'correct' && from === 'active' && to === 'active')
    || (type === 'dispute' && from === 'active' && to === 'disputed')
    || (type === 'resolve' && from === 'disputed'
      && ['active', 'superseded', 'revoked'].includes(to))
    || (type === 'revoke' && ['active', 'disputed'].includes(from) && to === 'revoked')
    || (type === 'expire' && from === 'active' && to === 'expired')
    || (type === 'archive' && ['superseded', 'revoked', 'expired', 'rejected'].includes(from)
      && to === 'archived')
    || (type === 'propose-purge'
      && ['superseded', 'revoked', 'expired', 'rejected', 'archived'].includes(from)
      && to === from)
  if (!legal) transitionFail('illegal-transition', ['record', 'lifecycle', 'status'])
}

function transitionRecord(
  record: MemoryRecordV1,
  status: MemoryStatusV1,
  reasonCode: string,
  transitionAt: string,
  transitionSequence: number,
  supersededByVersionId?: string,
): MemoryRecordV1 {
  return decodeMemoryRecordV1({
    ...record,
    lifecycle: {
      ...record.lifecycle,
      status,
      reasonCode,
      transitionSequence,
      lastTransitionAt: transitionAt,
      ...(supersededByVersionId === undefined
        ? {}
        : { supersededByVersionId }),
    },
    temporal: {
      ...record.temporal,
      updatedAt: transitionAt,
    },
  })
}

function validateTransitionTime(record: MemoryRecordV1, transitionAt: string): void {
  const transition = timestampMillis(transitionAt)
  if (transition < timestampMillis(record.temporal.updatedAt)
    || transition < timestampMillis(record.lifecycle.lastTransitionAt)) {
    transitionFail('time-reversal', ['transitionAt'])
  }
}

function validateExpiry(record: MemoryRecordV1, transitionAt: string): void {
  if (record.temporal.expiresAt === undefined
    || timestampMillis(transitionAt) < timestampMillis(record.temporal.expiresAt)) {
    transitionFail('policy-precondition', ['record', 'temporal', 'expiresAt'])
  }
}
