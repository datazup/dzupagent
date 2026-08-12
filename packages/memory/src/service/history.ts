import {
  decodeMemoryEventV1,
  decodeMemoryTransitionReceiptV1,
  digestLifecycleStateCore,
  effectStatus,
  isRetrievalEligible,
} from '../lifecycle/ledger.js'
import { projectMemoryVersionChainV1 } from '../lifecycle/projection.js'
import type {
  MemoryEventV1,
  MemoryTransitionReceiptV1,
  MemoryVersionChainV1,
} from '../lifecycle/types.js'
import { digestLifecycleValue, freezeValue, timestampMillis } from '../lifecycle/validation.js'
import { transitionFail } from '../lifecycle/errors.js'

/** Project ordered per-generation events as one temporal version history. */
export function projectMemoryHistoryV1(
  inputEvents: readonly MemoryEventV1[],
): MemoryVersionChainV1 {
  if (inputEvents.length === 0) transitionFail('invalid-event', ['events'])
  const events = inputEvents.map(decodeMemoryEventV1)
  let generation = 1
  let sequence = 0
  let priorTime = -Infinity
  const identities = new Set<string>()
  for (const [index, event] of events.entries()) {
    if (index === 0 && (event.generation !== 1 || event.type !== 'capture')) {
      transitionFail('invalid-event', ['events', '0'])
    }
    if (event.generation === generation) {
      sequence += 1
    } else {
      if (event.generation !== generation + 1) {
        transitionFail('stale-generation', ['events', String(index), 'generation'])
      }
      generation = event.generation
      sequence = 1
    }
    if (event.sequence !== sequence) {
      transitionFail('sequence-conflict', ['events', String(index), 'sequence'])
    }
    const occurredAt = timestampMillis(event.occurredAt)
    if (occurredAt < priorTime) {
      transitionFail('time-reversal', ['events', String(index), 'occurredAt'])
    }
    priorTime = occurredAt
    for (const identity of [
      `event:${event.eventId}`,
      `command:${event.commandId}`,
      `idempotency:${event.idempotencyKey}`,
    ]) {
      if (identities.has(identity)) {
        transitionFail('projection-conflict', ['events', String(index)])
      }
      identities.add(identity)
    }
  }

  // The existing projector owns transition and branch validation. Rebase only
  // generation/sequence coordinates into one virtual ledger; semantic fields,
  // identities, record effects, digests, and times remain unchanged.
  const rebased = events.map((event, index) => decodeMemoryEventV1({
    ...event,
    generation: 1,
    sequence: index + 1,
  }))
  const projected = projectMemoryVersionChainV1(rebased)
  return freezeValue({
    ...projected,
    generation: events.at(-1)!.generation,
    lastSequence: events.at(-1)!.sequence,
  })
}

/** Validate the one-to-one event/receipt ledger across generation boundaries. */
export function validateMemoryHistoryReceiptsV1(
  inputEvents: readonly MemoryEventV1[],
  inputReceipts: readonly MemoryTransitionReceiptV1[],
): readonly MemoryTransitionReceiptV1[] {
  if (inputEvents.length !== inputReceipts.length || inputEvents.length === 0) {
    transitionFail('invalid-state', ['receipts'])
  }
  const events = inputEvents.map(decodeMemoryEventV1)
  const receipts = inputReceipts.map(decodeMemoryTransitionReceiptV1)
  const receiptIds = new Set<string>()
  let priorResultDigest: `sha256:${string}` | undefined
  for (const [index, event] of events.entries()) {
    const receipt = receipts[index]!
    if (receiptIds.has(receipt.receiptId)) {
      transitionFail('invalid-state', ['receipts', String(index), 'receiptId'])
    }
    receiptIds.add(receipt.receiptId)
    if (receipt.memoryId !== event.memoryId
      || receipt.generation !== event.generation
      || receipt.sequence !== event.sequence
      || receipt.eventId !== event.eventId
      || receipt.commandId !== event.commandId
      || receipt.idempotencyKey !== event.idempotencyKey
      || receipt.commandDigest !== event.commandDigest
      || receipt.occurredAt !== event.occurredAt
      || receipt.previousStateDigest !== priorResultDigest
      || receipt.eventDigest !== digestLifecycleValue(event)
      || digestLifecycleValue(receipt.recordEffects) !== digestLifecycleValue(event.recordEffects)
      || receipt.effectStatus !== effectStatus(event)) {
      transitionFail('invalid-state', ['receipts', String(index)])
    }
    const expectedResultDigest = digestLifecycleStateCore({
      memoryId: event.memoryId,
      generation: event.generation,
      sequence: event.sequence,
      versionId: event.currentVersionId,
      recordDigest: event.currentRecordDigest,
      status: event.currentStatus,
      lastTransitionAt: event.occurredAt,
      retrievalEligible: isRetrievalEligible(event.currentStatus),
    })
    if (receipt.resultStateDigest !== expectedResultDigest) {
      transitionFail('invalid-state', ['receipts', String(index), 'resultStateDigest'])
    }
    priorResultDigest = receipt.resultStateDigest
  }
  return freezeValue(receipts)
}

