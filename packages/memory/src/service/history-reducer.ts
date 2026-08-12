import { MemoryTransitionError, transitionFail } from '../lifecycle/errors.js'
import {
  decodeMemoryEventV1,
  decodeMemoryTransitionReceiptV1,
  digestLifecycleStateCore,
  effectStatus,
  isRetrievalEligible,
} from '../lifecycle/ledger.js'
import { applyRecordTransition } from '../lifecycle/record-transitions.js'
import { reduceMemoryCommandV1 } from '../lifecycle/reducer.js'
import type {
  MemoryCommandV1,
  MemoryEventV1,
  MemoryLifecycleStateV1,
  MemoryTransitionReceiptV1,
  MemoryVersionChainV1,
} from '../lifecycle/types.js'
import {
  decodeMemoryCommandV1,
  digestLifecycleValue,
  freezeValue,
  recordDigest,
  timestampMillis,
} from '../lifecycle/validation.js'
import type { MemoryRecordV1 } from '../records/types.js'
import { projectMemoryHistoryV1, validateMemoryHistoryReceiptsV1 } from './history.js'
import type { InternalMemoryServiceSnapshotV1 } from './types.js'

export interface InternalMemoryHistoryReducerResultV1 {
  readonly receipt: MemoryTransitionReceiptV1
  readonly event?: MemoryEventV1
  readonly records: readonly MemoryRecordV1[]
  readonly replayed: boolean
}

/** Apply one lifecycle command against validated durable generation history. */
export function reduceMemoryHistoryCommandV1(
  snapshot: InternalMemoryServiceSnapshotV1 | undefined,
  inputCommand: MemoryCommandV1,
): InternalMemoryHistoryReducerResultV1 {
  const command = decodeMemoryCommandV1(inputCommand)
  if (!snapshot) {
    const result = reduceMemoryCommandV1(undefined, command)
    return freezeValue({
      receipt: result.receipt,
      ...(result.event === undefined ? {} : { event: result.event }),
      records: result.records,
      replayed: result.replayed,
    })
  }
  const commandDigest = digestLifecycleValue(command)
  const replay = findReplay(snapshot, command, commandDigest)
  if (replay) {
    return freezeValue({
      receipt: replay,
      records: [],
      replayed: true,
    })
  }
  if (snapshot.generation === 1) {
    const result = reduceMemoryCommandV1(asGenerationOneState(snapshot), command)
    return freezeValue({
      receipt: result.receipt,
      ...(result.event === undefined ? {} : { event: result.event }),
      records: result.records,
      replayed: result.replayed,
    })
  }

  const chain = projectMemoryHistoryV1(snapshot.events)
  validateAdmission(snapshot, command, chain)
  const nextSequence = command.expectedSequence + 1
  const transition = applyRecordTransition(command, nextSequence)
  const event = decodeMemoryEventV1({
    schema: 'datazup.memory.event/v1',
    eventId: command.eventId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandDigest,
    memoryId: command.memoryId,
    generation: command.generation,
    sequence: nextSequence,
    type: command.type,
    occurredAt: command.transitionAt,
    actorRef: command.actorRef,
    decisionRef: command.decisionRef,
    reasonCode: command.reasonCode,
    evidenceRefs: command.evidenceRefs,
    currentVersionId: transition.currentRecord.versionId,
    currentRecordDigest: transition.currentRecordDigest,
    currentStatus: transition.currentStatus,
    recordEffects: transition.recordEffects,
    effect: transition.effect,
  })
  const previousStateDigest = digestLifecycleStateCore({
    memoryId: snapshot.memoryId,
    generation: lastCommittedGeneration(snapshot),
    sequence: lastCommittedSequence(snapshot),
    versionId: snapshot.head.versionId,
    recordDigest: snapshot.head.recordDigest,
    status: snapshot.head.status,
    lastTransitionAt: snapshot.head.lastTransitionAt,
    retrievalEligible: snapshot.head.retrievalEligible,
  })
  const resultStateDigest = digestLifecycleStateCore({
    memoryId: event.memoryId,
    generation: event.generation,
    sequence: event.sequence,
    versionId: event.currentVersionId,
    recordDigest: event.currentRecordDigest,
    status: event.currentStatus,
    lastTransitionAt: event.occurredAt,
    retrievalEligible: isRetrievalEligible(event.currentStatus),
  })
  const receipt = decodeMemoryTransitionReceiptV1({
    schema: 'datazup.memory.transition-receipt/v1',
    receiptId: command.receiptId,
    eventId: event.eventId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandDigest,
    memoryId: command.memoryId,
    generation: command.generation,
    sequence: nextSequence,
    occurredAt: command.transitionAt,
    previousStateDigest,
    eventDigest: digestLifecycleValue(event),
    resultStateDigest,
    recordEffects: event.recordEffects,
    effectStatus: effectStatus(event),
  })
  projectMemoryHistoryV1([...snapshot.events, event])
  validateMemoryHistoryReceiptsV1(
    [...snapshot.events, event],
    [...snapshot.receipts, receipt],
  )
  return freezeValue({
    receipt,
    event,
    records: transition.records,
    replayed: false,
  })
}

function asGenerationOneState(
  snapshot: InternalMemoryServiceSnapshotV1,
): MemoryLifecycleStateV1 {
  return {
    schema: 'datazup.memory.lifecycle-state/v1',
    memoryId: snapshot.memoryId,
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    versionId: snapshot.head.versionId,
    recordDigest: snapshot.head.recordDigest,
    status: snapshot.head.status,
    lastTransitionAt: snapshot.head.lastTransitionAt,
    retrievalEligible: snapshot.head.retrievalEligible,
    events: snapshot.events,
    receipts: snapshot.receipts,
  }
}

function findReplay(
  snapshot: InternalMemoryServiceSnapshotV1,
  command: MemoryCommandV1,
  commandDigest: `sha256:${string}`,
): MemoryTransitionReceiptV1 | undefined {
  const receipt = snapshot.receipts.find(entry =>
    entry.idempotencyKey === command.idempotencyKey)
  if (!receipt) return undefined
  if (receipt.commandDigest !== commandDigest
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.receiptId !== command.receiptId) {
    transitionFail('idempotency-conflict', ['idempotencyKey'])
  }
  return receipt
}

function validateAdmission(
  snapshot: InternalMemoryServiceSnapshotV1,
  command: MemoryCommandV1,
  chain: MemoryVersionChainV1,
): void {
  if (command.type === 'capture') transitionFail('illegal-transition', ['type'])
  if (snapshot.sequence >= 32) transitionFail('limit-exceeded', ['events'])
  if (command.memoryId !== snapshot.memoryId) transitionFail('identity-mismatch', ['memoryId'])
  if (command.generation !== snapshot.generation) {
    transitionFail('stale-generation', ['generation'])
  }
  if (command.expectedSequence < snapshot.sequence) {
    transitionFail('sequence-reorder', ['expectedSequence'])
  }
  if (command.expectedSequence > snapshot.sequence) {
    transitionFail('sequence-gap', ['expectedSequence'])
  }
  if (timestampMillis(command.transitionAt) < timestampMillis(snapshot.head.lastTransitionAt)) {
    transitionFail('time-reversal', ['transitionAt'])
  }
  if (command.expectedVersionId !== command.record.versionId) {
    transitionFail('stale-version', ['expectedVersionId'])
  }
  const targetVersion = chain.versions.find(version =>
    version.versionId === command.expectedVersionId)
  if (!targetVersion) transitionFail('stale-version', ['expectedVersionId'])
  const suppliedDigest = recordDigest(command.record)
  if (command.expectedRecordDigest !== suppliedDigest) {
    transitionFail('stale-digest', ['expectedRecordDigest'])
  }
  const stored = snapshot.records.some(record =>
    record.versionId === command.record.versionId
    && recordDigest(record) === suppliedDigest)
  if (!stored) transitionFail('stale-digest', ['record'])
  const branchCorrection = isExplicitCorrectionBranch(
    snapshot.events,
    command,
    targetVersion,
    suppliedDigest,
  )
  if (!branchCorrection && targetVersion.recordDigests.at(-1) !== suppliedDigest) {
    transitionFail('stale-digest', ['expectedRecordDigest'])
  }
  if (!branchCorrection && command.record.lifecycle.status !== targetVersion.status) {
    transitionFail('stale-version', ['record', 'lifecycle', 'status'])
  }
  validateResolutionTarget(command, chain)
  for (const event of snapshot.events) {
    if (event.commandId === command.commandId) {
      transitionFail('idempotency-conflict', ['commandId'])
    }
    if (event.eventId === command.eventId) transitionFail('sequence-conflict', ['eventId'])
  }
  if (snapshot.receipts.some(receipt => receipt.receiptId === command.receiptId)) {
    transitionFail('idempotency-conflict', ['receiptId'])
  }
}

function isExplicitCorrectionBranch(
  events: readonly MemoryEventV1[],
  command: MemoryCommandV1,
  targetVersion: MemoryVersionChainV1['versions'][number],
  suppliedDigest: `sha256:${string}`,
): boolean {
  if (command.type !== 'correct'
    || command.record.lifecycle.status !== 'active'
    || targetVersion.status !== 'superseded'
    || !targetVersion.recordDigests.includes(suppliedDigest)) {
    return false
  }
  const effects = events.flatMap(event => event.recordEffects.map(effect => ({
    eventType: event.type,
    effect,
  })))
  const historicalActive = effects.some(({ effect }) =>
    effect.versionId === command.expectedVersionId
    && effect.resultDigest === suppliedDigest
    && effect.statusTo === 'active')
  const latest = [...effects].reverse().find(({ effect }) =>
    effect.versionId === command.expectedVersionId)
  return historicalActive
    && latest?.eventType === 'correct'
    && latest.effect.statusTo === 'superseded'
}

function validateResolutionTarget(
  command: MemoryCommandV1,
  chain: MemoryVersionChainV1,
): void {
  if (command.type !== 'resolve' || command.resolutionStatus !== 'superseded') return
  const successor = chain.versions.find(version =>
    version.versionId === command.supersededByVersionId)
  if (!successor
    || successor.versionId === command.record.versionId
    || successor.status !== 'active') {
    transitionFail('stale-version', ['supersededByVersionId'])
  }
  if (successor.recordDigests.at(-1) !== command.supersedingRecordDigest) {
    transitionFail('stale-digest', ['supersedingRecordDigest'])
  }
}

function lastCommittedGeneration(snapshot: InternalMemoryServiceSnapshotV1): number {
  return snapshot.events.at(-1)!.generation
}

function lastCommittedSequence(snapshot: InternalMemoryServiceSnapshotV1): number {
  return snapshot.events.at(-1)!.sequence
}

/** Convert unknown store faults into a stable retryable boundary when needed. */
export function isMemoryTransitionError(cause: unknown): cause is MemoryTransitionError {
  return cause instanceof MemoryTransitionError
}

