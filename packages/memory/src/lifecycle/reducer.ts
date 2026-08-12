import { applyRecordTransition } from './record-transitions.js'
import { transitionFail } from './errors.js'
import {
  decodeMemoryEventV1,
  decodeMemoryLifecycleStateV1,
  decodeMemoryTransitionReceiptV1,
  digestLifecycleStateCore,
  effectStatus,
  isRetrievalEligible,
} from './ledger.js'
import type {
  InternalMemoryReducerResultV1,
  MemoryCommandV1,
  MemoryLifecycleStateV1,
  MemoryVersionChainV1,
} from './types.js'
import {
  decodeMemoryCommandV1,
  digestLifecycleValue,
  freezeValue,
  recordDigest,
  timestampMillis,
} from './validation.js'
import { projectMemoryVersionChainV1 } from './projection.js'

const MAX_LEDGER_ENTRIES = 32

/** Apply one validated command without I/O, clock access, or hidden state. */
export function reduceMemoryCommandV1(
  currentState: MemoryLifecycleStateV1 | undefined,
  inputCommand: MemoryCommandV1,
): InternalMemoryReducerResultV1 {
  const command = decodeMemoryCommandV1(inputCommand)
  const state = currentState === undefined
    ? undefined
    : decodeMemoryLifecycleStateV1(currentState)
  const commandDigest = digestLifecycleValue(command)
  const chain = state === undefined
    ? undefined
    : projectMemoryVersionChainV1(state.events)

  if (state) {
    const replay = findReplay(state, command, commandDigest)
    if (replay) {
      return freezeValue({
        state,
        receipt: replay,
        records: [],
        replayed: true,
      })
    }
  }

  validateAdmission(state, command, chain)
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
  const previousStateDigest = state === undefined
    ? undefined
    : digestLifecycleStateCore(state)
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
    ...(previousStateDigest === undefined ? {} : { previousStateDigest }),
    eventDigest: digestLifecycleValue(event),
    resultStateDigest,
    recordEffects: event.recordEffects,
    effectStatus: effectStatus(event),
  })
  const nextEvents = [...(state?.events ?? []), event]
  projectMemoryVersionChainV1(nextEvents)
  const nextState = decodeMemoryLifecycleStateV1({
    schema: 'datazup.memory.lifecycle-state/v1',
    memoryId: command.memoryId,
    generation: command.generation,
    sequence: nextSequence,
    versionId: event.currentVersionId,
    recordDigest: event.currentRecordDigest,
    status: event.currentStatus,
    lastTransitionAt: event.occurredAt,
    retrievalEligible: isRetrievalEligible(event.currentStatus),
    events: nextEvents,
    receipts: [...(state?.receipts ?? []), receipt],
  })
  return freezeValue({
    state: nextState,
    receipt,
    event,
    records: transition.records,
    replayed: false,
  })
}

function findReplay(
  state: MemoryLifecycleStateV1,
  command: MemoryCommandV1,
  commandDigest: `sha256:${string}`,
) {
  const receipt = state.receipts.find(entry => entry.idempotencyKey === command.idempotencyKey)
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
  state: MemoryLifecycleStateV1 | undefined,
  command: MemoryCommandV1,
  chain: MemoryVersionChainV1 | undefined,
): void {
  if (!state) {
    if (command.type !== 'capture' || command.expectedSequence !== 0) {
      transitionFail('illegal-transition', ['type'])
    }
    return
  }
  if (command.type === 'capture') transitionFail('illegal-transition', ['type'])
  if (state.events.length >= MAX_LEDGER_ENTRIES) transitionFail('limit-exceeded', ['events'])
  if (command.memoryId !== state.memoryId) transitionFail('identity-mismatch', ['memoryId'])
  if (command.generation !== state.generation) {
    transitionFail('stale-generation', ['generation'])
  }
  if (command.expectedSequence < state.sequence) {
    transitionFail('sequence-reorder', ['expectedSequence'])
  }
  if (command.expectedSequence > state.sequence) {
    transitionFail('sequence-gap', ['expectedSequence'])
  }
  if (timestampMillis(command.transitionAt) < timestampMillis(state.lastTransitionAt)) {
    transitionFail('time-reversal', ['transitionAt'])
  }
  if (command.expectedVersionId !== command.record.versionId) {
    transitionFail('stale-version', ['expectedVersionId'])
  }
  if (!chain) transitionFail('invalid-state')
  const targetVersion = chain.versions.find(version =>
    version.versionId === command.expectedVersionId)
  if (!targetVersion) transitionFail('stale-version', ['expectedVersionId'])
  const suppliedDigest = recordDigest(command.record)
  if (command.expectedRecordDigest !== suppliedDigest) {
    transitionFail('stale-digest', ['expectedRecordDigest'])
  }
  const branchCorrection = isExplicitCorrectionBranch(
    state,
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
  for (const event of state.events) {
    if (event.commandId === command.commandId) {
      transitionFail('idempotency-conflict', ['commandId'])
    }
    if (event.eventId === command.eventId) transitionFail('sequence-conflict', ['eventId'])
  }
  if (state.receipts.some(receipt => receipt.receiptId === command.receiptId)) {
    transitionFail('idempotency-conflict', ['receiptId'])
  }
}

function isExplicitCorrectionBranch(
  state: MemoryLifecycleStateV1,
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
  const effects = state.events.flatMap(event => event.recordEffects.map(effect => ({
    eventType: event.type,
    effect,
  })))
  const historicalActive = effects.some(({ effect }) =>
    effect.versionId === command.expectedVersionId
    && effect.resultDigest === suppliedDigest
    && effect.statusTo === 'active')
  const latestTargetEffect = [...effects].reverse().find(({ effect }) =>
    effect.versionId === command.expectedVersionId)
  return historicalActive
    && latestTargetEffect?.eventType === 'correct'
    && latestTargetEffect.effect.statusTo === 'superseded'
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
