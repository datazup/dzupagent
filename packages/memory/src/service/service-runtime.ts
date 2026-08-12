import { MemoryTransitionError, transitionFail } from '../lifecycle/errors.js'
import type { MemoryCommandV1, MemoryTransitionReceiptV1 } from '../lifecycle/types.js'
import { digestLifecycleValue } from '../lifecycle/validation.js'
import { deepFreezeSafeJson } from '../records/safe-json.js'
import type { MemoryRecordV1, MemoryScopeV1 } from '../records/types.js'
import { projectMemoryHistoryV1 } from './history.js'
import type { InternalMemoryHistoryReducerResultV1 } from './history-reducer.js'
import {
  decodeMemoryServiceSnapshotV1,
  digestServiceValue,
  memoryScopeDigestV1,
  sealMemoryServiceSnapshotV1,
  snapshotServiceJson,
} from './snapshot.js'
import type {
  InternalMemoryCheckpointV1,
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryLifecycleWriteResultV1,
  InternalMemoryServiceSnapshotV1,
  InternalMemoryStoreOutcomeV1,
  MemoryAdapterCapabilitiesV1,
  MemoryLifecycleStorePort,
} from './types.js'
import { decodeMemoryStoreOutcomeV1 } from './validation.js'

export type InternalWriteMethod = 'remember' | 'correct' | 'revoke'

export type InternalLoadedSnapshot =
  | { readonly status: 'found'; readonly snapshot: InternalMemoryServiceSnapshotV1 }
  | { readonly status: 'not-found' }
  | { readonly status: 'retryable' }
  | { readonly status: 'rejected' }

export async function loadServiceSnapshot(
  store: MemoryLifecycleStorePort,
  scope: MemoryScopeV1,
  memoryId: string,
): Promise<InternalLoadedSnapshot> {
  let raw: unknown
  try {
    raw = await store.load({ schema: 'datazup.memory.store-load/v1', scope, memoryId })
  } catch {
    return { status: 'retryable' }
  }
  if (raw === null) return { status: 'not-found' }
  try {
    const snapshot = decodeMemoryServiceSnapshotV1(raw)
    if (!snapshotIdentityMatches(snapshot, scope, memoryId)) return { status: 'rejected' }
    return { status: 'found', snapshot }
  } catch {
    return { status: 'rejected' }
  }
}

export async function invokeStoreOutcome(
  operation: () => Promise<unknown>,
): Promise<
  | { readonly status: 'completed'; readonly outcome: InternalMemoryStoreOutcomeV1 }
  | { readonly status: 'store-fault' }
  | { readonly status: 'invalid' }
> {
  let raw: unknown
  try {
    raw = await operation()
  } catch {
    return { status: 'store-fault' }
  }
  try {
    return { status: 'completed', outcome: decodeMemoryStoreOutcomeV1(raw) }
  } catch {
    return { status: 'invalid' }
  }
}

export function previewCheckpoint(
  snapshot: InternalMemoryServiceSnapshotV1,
  instruction: NonNullable<InternalMemoryLifecycleWriteInputV1['checkpoint']>,
): InternalMemoryServiceSnapshotV1 {
  const lastEvent = snapshot.events.at(-1)!
  const lastReceipt = snapshot.receipts.at(-1)!
  const checkpoint: InternalMemoryCheckpointV1 = {
    schema: 'datazup.memory.store-checkpoint-record/v1',
    checkpointId: instruction.checkpointId,
    checkpointedAt: instruction.checkpointedAt,
    memoryId: snapshot.memoryId,
    fromGeneration: snapshot.generation,
    fromSequence: snapshot.sequence,
    toGeneration: snapshot.generation + 1,
    priorSnapshotDigest: snapshot.snapshotDigest,
    stateDigest: lastReceipt.resultStateDigest,
    chainDigest: digestLifecycleValue(projectMemoryHistoryV1(snapshot.events)),
    lastEventDigest: digestLifecycleValue(lastEvent),
    lastReceiptDigest: digestLifecycleValue(lastReceipt),
  }
  return sealMemoryServiceSnapshotV1({
    schema: snapshot.schema,
    scope: snapshot.scope,
    memoryId: snapshot.memoryId,
    generation: snapshot.generation + 1,
    sequence: 0,
    revision: snapshot.revision + 1,
    head: snapshot.head,
    records: snapshot.records,
    events: snapshot.events,
    receipts: snapshot.receipts,
    checkpoints: [...snapshot.checkpoints, checkpoint],
    tombstones: snapshot.tombstones,
  })
}

export function findCommandReceipt(
  snapshot: InternalMemoryServiceSnapshotV1,
  command: MemoryCommandV1,
): MemoryTransitionReceiptV1 | undefined {
  const receipt = snapshot.receipts.find(entry => entry.idempotencyKey === command.idempotencyKey)
  if (!receipt) return undefined
  if (receipt.commandDigest !== digestLifecycleValue(command)
    || receipt.commandId !== command.commandId
    || receipt.eventId !== command.eventId
    || receipt.receiptId !== command.receiptId) {
    transitionFail('idempotency-conflict', ['command', 'idempotencyKey'])
  }
  return receipt
}

export function outcomeMatchesSnapshot(
  outcome: InternalMemoryStoreOutcomeV1,
  receipt: MemoryTransitionReceiptV1,
  snapshot: InternalMemoryServiceSnapshotV1,
): boolean {
  const event = snapshot.events.find(entry => entry.eventId === receipt.eventId)
  if (!event) return false
  if (outcome.receipt !== undefined
    && digestServiceValue(outcome.receipt) !== digestServiceValue(receipt)) return false
  if (outcome.event !== undefined
    && digestServiceValue(outcome.event) !== digestServiceValue(event)) return false
  if (outcome.records !== undefined) {
    const expected = recordsForReceipt(snapshot, receipt).map(digestLifecycleValue).sort()
    const actual = outcome.records.map(digestLifecycleValue).sort()
    if (digestServiceValue(actual) !== digestServiceValue(expected)) return false
  }
  return outcome.checkpoint === undefined
}

export function recordsForReceipt(
  snapshot: InternalMemoryServiceSnapshotV1,
  receipt: MemoryTransitionReceiptV1,
): readonly MemoryRecordV1[] {
  const digests = [...new Set(receipt.recordEffects
    .filter(effect => effect.priorDigest !== effect.resultDigest)
    .map(effect => effect.resultDigest))]
  return digests.flatMap(digest => {
    const record = snapshot.records.find(candidate => digestLifecycleValue(candidate) === digest)
    return record ? [record] : []
  })
}

export function matchingCheckpoint(
  snapshot: InternalMemoryServiceSnapshotV1,
  instruction: NonNullable<InternalMemoryLifecycleWriteInputV1['checkpoint']>,
  prior: InternalMemoryServiceSnapshotV1,
): InternalMemoryCheckpointV1 | undefined {
  return snapshot.checkpoints.find(entry =>
    entry.checkpointId === instruction.checkpointId
    && entry.checkpointedAt === instruction.checkpointedAt
    && entry.fromGeneration === prior.generation
    && entry.fromSequence === prior.sequence
    && entry.toGeneration === prior.generation + 1
    && entry.priorSnapshotDigest === prior.snapshotDigest)
}

export function assertCheckpointInstruction(
  snapshot: InternalMemoryServiceSnapshotV1,
  instruction: NonNullable<InternalMemoryLifecycleWriteInputV1['checkpoint']>,
): void {
  const checkpoint = snapshot.checkpoints.at(-1)
  if (!checkpoint
    || checkpoint.checkpointId !== instruction.checkpointId
    || checkpoint.checkpointedAt !== instruction.checkpointedAt
    || checkpoint.toGeneration !== snapshot.generation) {
    throw new MemoryTransitionError('stale-digest', ['checkpoint'])
  }
}

export function isOpenGeneration(snapshot: InternalMemoryServiceSnapshotV1): boolean {
  return snapshot.sequence === 0
    && snapshot.events.at(-1)!.generation + 1 === snapshot.generation
}

export function snapshotIdentityMatches(
  snapshot: InternalMemoryServiceSnapshotV1,
  scope: MemoryScopeV1,
  memoryId: string,
): boolean {
  return snapshot.memoryId === memoryId
    && memoryScopeDigestV1(snapshot.scope) === memoryScopeDigestV1(scope)
}

export function hasCapacity(
  capabilities: MemoryAdapterCapabilitiesV1,
  snapshot: InternalMemoryServiceSnapshotV1 | undefined,
  reduced: InternalMemoryHistoryReducerResultV1,
): boolean {
  const currentRecords = snapshot?.records ?? []
  const recordDigests = new Set(currentRecords.map(digestLifecycleValue))
  for (const record of reduced.records) recordDigests.add(digestLifecycleValue(record))
  const tombstoneDelta = reduced.event?.effect.kind === 'purge-proposed' ? 1 : 0
  return recordDigests.size <= capabilities.limits.records
    && (snapshot?.events.length ?? 0) + (reduced.replayed ? 0 : 1) <= capabilities.limits.events
    && (snapshot?.receipts.length ?? 0) + (reduced.replayed ? 0 : 1) <= capabilities.limits.receipts
    && (snapshot?.tombstones.length ?? 0) + tombstoneDelta <= capabilities.limits.tombstones
}

export function supportsAtomicLifecycleWrites(
  capabilities: MemoryAdapterCapabilitiesV1,
): boolean {
  return capabilities.atomicCompareAndSwap
    && capabilities.transactions
    && capabilities.durableIdempotency
    && capabilities.authenticatedCustody
}

export function assertMethodCommand(
  method: InternalWriteMethod,
  command: MemoryCommandV1,
): void {
  if ((method === 'correct' && command.type !== 'correct')
    || (method === 'revoke' && command.type !== 'revoke')
    || (method === 'remember' && (command.type === 'correct' || command.type === 'revoke'))) {
    transitionFail('invalid-command', ['command', 'type'])
  }
}

export function storeOutcomeFailure(
  outcome: InternalMemoryStoreOutcomeV1,
  checkpoint?: InternalMemoryCheckpointV1,
): InternalMemoryLifecycleWriteResultV1 {
  if (outcome.status === 'conflict') return writeFailure('conflict', outcome.reason, checkpoint)
  if (outcome.status === 'unsupported') return writeFailure('unsupported', outcome.reason, checkpoint)
  if (outcome.status === 'ambiguous') return writeFailure('retryable', outcome.reason, checkpoint)
  return writeFailure('rejected', outcome.reason, checkpoint)
}

export function writeFailure(
  status: Extract<InternalMemoryLifecycleWriteResultV1['status'],
    'conflict' | 'unsupported' | 'retryable' | 'rejected'>,
  reason: InternalMemoryLifecycleWriteResultV1['reason'],
  checkpoint?: InternalMemoryCheckpointV1,
): InternalMemoryLifecycleWriteResultV1 {
  return freezeServiceResult({
    schema: 'datazup.memory.service-write-result/v1',
    status,
    reason,
    records: [],
    ...(checkpoint === undefined ? {} : { checkpoint }),
  })
}

export function freezeServiceResult<T>(input: T): T {
  return deepFreezeSafeJson(snapshotServiceJson(input)) as unknown as T
}
