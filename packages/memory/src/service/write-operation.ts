import { transitionFail } from '../lifecycle/errors.js'
import type { MemoryTransitionReceiptV1 } from '../lifecycle/types.js'
import { digestLifecycleValue } from '../lifecycle/validation.js'
import type { MemoryScopeV1 } from '../records/types.js'
import { validateStagedCompatibilityV1 } from './compatibility.js'
import { reduceMemoryHistoryCommandV1 } from './history-reducer.js'
import {
  assertCheckpointInstruction,
  assertMethodCommand,
  findCommandReceipt,
  freezeServiceResult,
  hasCapacity,
  invokeStoreOutcome,
  isOpenGeneration,
  loadServiceSnapshot,
  matchingCheckpoint,
  outcomeMatchesSnapshot,
  previewCheckpoint,
  recordsForReceipt,
  snapshotIdentityMatches,
  storeOutcomeFailure,
  supportsAtomicLifecycleWrites,
  writeFailure,
  type InternalWriteMethod,
} from './service-runtime.js'
import { digestServiceValue } from './snapshot.js'
import type {
  InternalMemoryCheckpointV1,
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryLifecycleWriteResultV1,
  InternalMemoryServiceSnapshotV1,
  MemoryAdapterCapabilitiesV1,
  MemoryInvalidationPort,
  MemoryLifecycleStorePort,
} from './types.js'
import {
  decodeLifecycleWriteInputV1,
  decodeMemoryInvalidationResultV1,
} from './validation.js'

type CheckpointResult =
  | {
      readonly status: 'completed'
      readonly snapshot: InternalMemoryServiceSnapshotV1
      readonly checkpoint: InternalMemoryCheckpointV1
    }
  | { readonly status: 'failed'; readonly result: InternalMemoryLifecycleWriteResultV1 }

export async function performWrite(
  store: MemoryLifecycleStorePort,
  capabilities: MemoryAdapterCapabilitiesV1,
  invalidationPort: MemoryInvalidationPort | undefined,
  method: InternalWriteMethod,
  rawInput: InternalMemoryLifecycleWriteInputV1,
): Promise<InternalMemoryLifecycleWriteResultV1> {
  const input = decodeLifecycleWriteInputV1(rawInput)
  assertMethodCommand(method, input.command)
  if (!supportsAtomicLifecycleWrites(capabilities)) {
    return writeFailure('unsupported', 'unsupported-capability')
  }
  try {
    validateStagedCompatibilityV1(input.compatibility, input.command)
  } catch {
    return writeFailure('rejected', 'compatibility-mismatch')
  }

  const loaded = await loadServiceSnapshot(store, input.scope, input.command.memoryId)
  if (loaded.status === 'retryable') return writeFailure('retryable', 'store-unavailable')
  if (loaded.status === 'rejected') return writeFailure('rejected', 'invalid-store-snapshot')
  let current = loaded.status === 'found' ? loaded.snapshot : undefined

  if (current) {
    const replay = findCommandReceipt(current, input.command)
    if (replay) {
      return completeLogicalWrite(
        current,
        input,
        replay,
        'replayed',
        invalidationPort,
      )
    }
  }

  let checkpoint: InternalMemoryCheckpointV1 | undefined
  if (current?.sequence === 32) {
    if (!capabilities.checkpoints) {
      return writeFailure('unsupported', 'unsupported-capability')
    }
    if (!input.checkpoint) return writeFailure('rejected', 'checkpoint-required')
    if (current.checkpoints.length >= capabilities.limits.checkpoints) {
      return writeFailure('rejected', 'capacity-exceeded')
    }
    if (input.command.generation !== current.generation + 1) {
      transitionFail('stale-generation', ['command', 'generation'])
    }
    if (input.command.expectedSequence !== 0) {
      transitionFail('sequence-reorder', ['command', 'expectedSequence'])
    }

    const expectedCheckpoint = previewCheckpoint(current, input.checkpoint)
    const preview = reduceMemoryHistoryCommandV1(expectedCheckpoint, input.command)
    if (!hasCapacity(capabilities, expectedCheckpoint, preview)) {
      return writeFailure('rejected', 'capacity-exceeded')
    }
    const checkpointResult = await persistCheckpoint(
      store,
      input.scope,
      current,
      expectedCheckpoint,
      input.checkpoint,
    )
    if (checkpointResult.status === 'failed') return checkpointResult.result
    current = checkpointResult.snapshot
    checkpoint = checkpointResult.checkpoint

    const replay = findCommandReceipt(current, input.command)
    if (replay) {
      return completeLogicalWrite(
        current,
        input,
        replay,
        'replayed',
        invalidationPort,
        checkpoint,
      )
    }
    if (current.generation !== input.command.generation
      || current.sequence !== input.command.expectedSequence) {
      return writeFailure('conflict', 'cas-conflict', checkpoint)
    }
  } else if (current && isOpenGeneration(current)) {
    if (input.checkpoint) assertCheckpointInstruction(current, input.checkpoint)
  } else if (input.checkpoint) {
    return writeFailure('rejected', 'checkpoint-conflict')
  }

  const preview = reduceMemoryHistoryCommandV1(current, input.command)
  if (!hasCapacity(capabilities, current, preview)) {
    return writeFailure('rejected', 'capacity-exceeded', checkpoint)
  }
  const appendOutcome = await invokeStoreOutcome(() => store.append({
    schema: 'datazup.memory.store-append/v1',
    scope: input.scope,
    memoryId: input.command.memoryId,
    command: input.command,
    expectedRevision: current?.revision ?? 0,
    ...(current === undefined ? {} : { expectedSnapshotDigest: current.snapshotDigest }),
  }))
  if (appendOutcome.status === 'store-fault') {
    return writeFailure('retryable', 'store-unavailable', checkpoint)
  }
  if (appendOutcome.status === 'invalid') {
    return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
  }
  const outcome = appendOutcome.outcome
  if (outcome.status === 'committed' || outcome.status === 'replayed') {
    if (!outcome.snapshot || !snapshotIdentityMatches(
      outcome.snapshot,
      input.scope,
      input.command.memoryId,
    )) {
      return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
    }
    const expectedRevision = (current?.revision ?? 0) + (outcome.status === 'committed' ? 1 : 0)
    if (outcome.snapshot.revision !== expectedRevision) {
      return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
    }
    const receipt = findCommandReceipt(outcome.snapshot, input.command)
    if (!receipt || !outcomeMatchesSnapshot(outcome, receipt, outcome.snapshot)) {
      return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
    }
    return completeLogicalWrite(
      outcome.snapshot,
      input,
      receipt,
      outcome.status,
      invalidationPort,
      checkpoint,
    )
  }
  if (outcome.status === 'conflict' || outcome.status === 'ambiguous') {
    const reconciled = await loadServiceSnapshot(store, input.scope, input.command.memoryId)
    if (reconciled.status === 'found') {
      const receipt = findCommandReceipt(reconciled.snapshot, input.command)
      if (receipt) {
        return completeLogicalWrite(
          reconciled.snapshot,
          input,
          receipt,
          'replayed',
          invalidationPort,
          checkpoint,
        )
      }
    } else if (reconciled.status === 'rejected') {
      return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
    } else if (reconciled.status === 'retryable') {
      return writeFailure('retryable', 'store-unavailable', checkpoint)
    }
    return outcome.status === 'conflict'
      ? writeFailure('conflict', 'cas-conflict', checkpoint)
      : writeFailure('retryable', 'ambiguous-outcome', checkpoint)
  }
  return storeOutcomeFailure(outcome, checkpoint)
}

async function persistCheckpoint(
  store: MemoryLifecycleStorePort,
  scope: MemoryScopeV1,
  prior: InternalMemoryServiceSnapshotV1,
  expected: InternalMemoryServiceSnapshotV1,
  instruction: NonNullable<InternalMemoryLifecycleWriteInputV1['checkpoint']>,
): Promise<CheckpointResult> {
  const invoked = await invokeStoreOutcome(() => store.checkpoint({
    schema: 'datazup.memory.store-checkpoint/v1',
    scope,
    memoryId: prior.memoryId,
    checkpointId: instruction.checkpointId,
    checkpointedAt: instruction.checkpointedAt,
    expectedRevision: prior.revision,
    expectedSnapshotDigest: prior.snapshotDigest,
    fromGeneration: prior.generation,
    fromSequence: prior.sequence,
    toGeneration: prior.generation + 1,
  }))
  if (invoked.status === 'store-fault') {
    return { status: 'failed', result: writeFailure('retryable', 'store-unavailable') }
  }
  if (invoked.status === 'invalid') {
    return { status: 'failed', result: writeFailure('rejected', 'invalid-store-snapshot') }
  }
  const outcome = invoked.outcome
  if (outcome.status === 'committed' || outcome.status === 'replayed') {
    if (!outcome.snapshot
      || outcome.snapshot.snapshotDigest !== expected.snapshotDigest
      || !snapshotIdentityMatches(outcome.snapshot, scope, prior.memoryId)) {
      return { status: 'failed', result: writeFailure('rejected', 'invalid-store-snapshot') }
    }
    const checkpoint = matchingCheckpoint(outcome.snapshot, instruction, prior)
    if (!checkpoint
      || (outcome.checkpoint !== undefined
        && digestServiceValue(outcome.checkpoint) !== digestServiceValue(checkpoint))) {
      return { status: 'failed', result: writeFailure('rejected', 'invalid-store-snapshot') }
    }
    return { status: 'completed', snapshot: outcome.snapshot, checkpoint }
  }
  if (outcome.status === 'ambiguous' || outcome.status === 'conflict') {
    const loaded = await loadServiceSnapshot(store, scope, prior.memoryId)
    if (loaded.status === 'found') {
      const checkpoint = matchingCheckpoint(loaded.snapshot, instruction, prior)
      if (checkpoint) {
        return { status: 'completed', snapshot: loaded.snapshot, checkpoint }
      }
    } else if (loaded.status === 'retryable') {
      return { status: 'failed', result: writeFailure('retryable', 'store-unavailable') }
    } else if (loaded.status === 'rejected') {
      return { status: 'failed', result: writeFailure('rejected', 'invalid-store-snapshot') }
    }
    return {
      status: 'failed',
      result: outcome.status === 'ambiguous'
        ? writeFailure('retryable', 'ambiguous-outcome')
        : writeFailure('conflict', 'checkpoint-conflict'),
    }
  }
  return { status: 'failed', result: storeOutcomeFailure(outcome) }
}

async function completeLogicalWrite(
  snapshot: InternalMemoryServiceSnapshotV1,
  input: InternalMemoryLifecycleWriteInputV1,
  receipt: MemoryTransitionReceiptV1,
  logicalStatus: 'committed' | 'replayed',
  invalidationPort: MemoryInvalidationPort | undefined,
  checkpoint?: InternalMemoryCheckpointV1,
): Promise<InternalMemoryLifecycleWriteResultV1> {
  const event = snapshot.events.find(entry => entry.eventId === receipt.eventId)
  if (!event) return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
  const records = recordsForReceipt(snapshot, receipt)
  const changedDigests = new Set(receipt.recordEffects
    .filter(effect => effect.priorDigest !== effect.resultDigest)
    .map(effect => effect.resultDigest))
  if (records.length !== changedDigests.size) {
    return writeFailure('rejected', 'invalid-store-snapshot', checkpoint)
  }
  if (input.command.type !== 'revoke' || !input.invalidationTargets?.length) {
    return freezeServiceResult({
      schema: 'datazup.memory.service-write-result/v1',
      status: logicalStatus,
      reason: 'none',
      receipt,
      event,
      records,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    })
  }
  const invalidation = await performInvalidation(
    invalidationPort,
    input,
    event.currentVersionId,
    event.currentRecordDigest,
  )
  return freezeServiceResult({
    schema: 'datazup.memory.service-write-result/v1',
    status: invalidation.status === 'completed' ? logicalStatus : 'partial',
    reason: invalidation.status === 'completed' ? 'none' : 'invalidation-incomplete',
    receipt,
    event,
    records,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    invalidation,
  })
}

async function performInvalidation(
  port: MemoryInvalidationPort | undefined,
  input: InternalMemoryLifecycleWriteInputV1,
  versionId: string,
  recordDigest: `sha256:${string}`,
): Promise<NonNullable<InternalMemoryLifecycleWriteResultV1['invalidation']>> {
  const targets = input.invalidationTargets!
  if (!port) return syntheticInvalidation('unsupported', targets)
  let decoded: ReturnType<typeof decodeMemoryInvalidationResultV1>
  try {
    decoded = decodeMemoryInvalidationResultV1(await port.invalidate({
      schema: 'datazup.memory.invalidation-request/v1',
      scope: input.scope,
      memoryId: input.command.memoryId,
      versionId,
      recordDigest,
      idempotencyKey: `invalidation-${digestLifecycleValue(input.command).slice(7)}`,
      targets,
    }))
  } catch {
    return syntheticInvalidation('retryable', targets)
  }
  const expected = new Map(targets.map(target => [digestServiceValue(target), target]))
  if (decoded.outcomes.length !== targets.length
    || decoded.outcomes.some(outcome => !expected.delete(digestServiceValue(outcome.target)))
    || expected.size !== 0) {
    return syntheticInvalidation('retryable', targets)
  }
  return decoded
}

function syntheticInvalidation(
  status: 'unsupported' | 'retryable',
  targets: NonNullable<InternalMemoryLifecycleWriteInputV1['invalidationTargets']>,
): NonNullable<InternalMemoryLifecycleWriteResultV1['invalidation']> {
  return decodeMemoryInvalidationResultV1({
    schema: 'datazup.memory.invalidation-result/v1',
    status,
    outcomes: targets.map(target => ({ target, status })),
  })
}
