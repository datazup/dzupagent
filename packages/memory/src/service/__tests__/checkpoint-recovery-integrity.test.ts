import { test, expect } from 'vitest'
import { captureInput, transitionInput, instant } from '../../service/__tests__/fixtures.js'
import { decodeMemoryInvalidationResultV1 } from '../../service/validation.js'
import { recordDigest } from '../../lifecycle/validation.js'
import { reduceMemoryHistoryCommandV1 } from '../../service/history-reducer.js'
import { assertCheckpointInstruction, findCommandReceipt, outcomeMatchesSnapshot, recordsForReceipt, matchingCheckpoint, hasCapacity, snapshotIdentityMatches } from '../../service/service-runtime.js'
import { InMemoryMemoryLifecycleAdapter } from '../../service/in-memory-adapter.js'
import { MemoryLifecycleService } from '../../service/memory-lifecycle-service.js'
import { fillGeneration, rolloverInput, loadSnapshot } from '../../service/__tests__/checkpoint-fixtures.js'
import { decodeMemoryServiceSnapshotV1 } from '../../service/snapshot.js'
import type { InternalMemoryServiceSnapshotV1 } from '../../service/types.js'

test('checkpoint recovery rejects a different generation, owner, head, receipt or settlement history', async () => {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const full = await fillGeneration(service, 'audit-checkpoint')
  expect((await service.remember(rolloverInput(full.record))).status).toBe('committed')
  const snapshot = await loadSnapshot(adapter, 'audit-checkpoint')
  expect(() => new InMemoryMemoryLifecycleAdapter({ seed: Array.from({ length: 129 }, () => snapshot) })).toThrow(/limit/)
  expect(() => new InMemoryMemoryLifecycleAdapter({ seed: [snapshot, snapshot] })).toThrow(/identity/)
  for (const fault of [{ appendFault: 'foreign' }, { checkpointFault: 'foreign' }]) expect(() => Reflect.construct(InMemoryMemoryLifecycleAdapter, [fault])).toThrow()
  for (const key of ['delete', 'purge', 'indexInvalidation'] as const) expect(() => new InMemoryMemoryLifecycleAdapter({ capabilities: { ...adapter.capabilities, [key]: true } })).toThrow()
  for (const key of ['records', 'events', 'receipts'] as const) expect(() => new InMemoryMemoryLifecycleAdapter({ seed: [snapshot], capabilities: { ...adapter.capabilities, limits: { ...adapter.capabilities.limits, [key]: 1 } } })).toThrow(/limit/)
  await expect(Reflect.apply(adapter.load, adapter, [{ schema: 'foreign', scope: snapshot.scope, memoryId: snapshot.memoryId }])).rejects.toThrow()
  const append = { schema: 'datazup.memory.store-append/v1', scope: snapshot.scope, memoryId: snapshot.memoryId, command: full.capture.command, expectedRevision: 0 }
  for (const change of [{ schema: 'foreign' }, { memoryId: 'foreign' }, { scope: { ...snapshot.scope, tenantId: 'foreign' } }]) await expect(Reflect.apply(adapter.append, adapter, [{ ...append, ...change }])).rejects.toThrow()
  const checkpoint = snapshot.checkpoints[0]!
  const instruction = { checkpointId: checkpoint.checkpointId, checkpointedAt: checkpoint.checkpointedAt }
  expect(() => assertCheckpointInstruction(snapshot, instruction)).not.toThrow()
  for (const change of [{ checkpointId: 'foreign' }, { checkpointedAt: instant(0) }]) expect(() => assertCheckpointInstruction(snapshot, { ...instruction, ...change })).toThrow()
  expect(() => assertCheckpointInstruction({ ...snapshot, checkpoints: [] }, instruction)).toThrow()
  const changes: Array<Record<string, unknown>> = [{ generation: 3 }, { sequence: 0 }, { revision: 1 }, { records: [] }, { records: [...snapshot.records, snapshot.records[0]] }, { checkpoints: [] }]
  for (const key of ['versionId', 'recordDigest', 'status', 'lastTransitionAt', 'retrievalEligible'] as const) changes.push({ head: { ...snapshot.head, [key]: key === 'retrievalEligible' ? !snapshot.head[key] : key === 'recordDigest' ? `sha256:${'a'.repeat(64)}` : key === 'lastTransitionAt' ? instant(0) : key === 'status' ? 'archived' : 'foreign' } })
  for (const key of ['memoryId', 'fromGeneration', 'toGeneration', 'fromSequence', 'stateDigest', 'chainDigest', 'lastEventDigest', 'lastReceiptDigest', 'checkpointedAt'] as const) changes.push({ checkpoints: [{ ...checkpoint, [key]: typeof checkpoint[key] === 'number' ? 99 : key === 'checkpointedAt' ? instant(0) : key.endsWith('Digest') ? `sha256:${'a'.repeat(64)}` : 'foreign' }] })
  for (const change of changes) expect(() => decodeMemoryServiceSnapshotV1({ ...snapshot, ...change }), Object.keys(change).join()).toThrow()
  const record = snapshot.records.find(item => recordDigest(item) === snapshot.head.recordDigest)!
  const command = transitionInput('dispute', record, snapshot.generation, snapshot.sequence, 35).command
  expect(() => reduceMemoryHistoryCommandV1(snapshot, command)).not.toThrow()
  const receipt = snapshot.receipts.at(-1)!
  const event = snapshot.events.find(item => item.eventId === receipt.eventId)!
  const outcome = { schema: 'datazup.memory.store-outcome/v1' as const, status: 'committed' as const, reason: 'none' as const, receipt, event, records: recordsForReceipt(snapshot, receipt) }
  expect(outcomeMatchesSnapshot(outcome, receipt, snapshot)).toBe(true)
  expect(outcomeMatchesSnapshot(outcome, receipt, { ...snapshot, events: [] })).toBe(false)
  expect(outcomeMatchesSnapshot({ ...outcome, receipt: { ...receipt, receiptId: 'foreign' } }, receipt, snapshot)).toBe(false)
  expect(outcomeMatchesSnapshot({ ...outcome, event: { ...event, eventId: 'foreign' } }, receipt, snapshot)).toBe(false)
  expect(outcomeMatchesSnapshot({ ...outcome, records: [] }, receipt, snapshot)).toBe(false)
  expect(outcomeMatchesSnapshot({ ...outcome, checkpoint }, receipt, snapshot)).toBe(false)
  expect(recordsForReceipt({ ...snapshot, records: [] }, receipt)).toEqual([])
  expect(snapshotIdentityMatches(snapshot, { ...snapshot.scope, tenantId: 'foreign' }, snapshot.memoryId)).toBe(false)
  const prior = { ...snapshot, generation: checkpoint.fromGeneration, sequence: checkpoint.fromSequence, snapshotDigest: checkpoint.priorSnapshotDigest }
  expect(matchingCheckpoint(snapshot, instruction, prior)).toEqual(checkpoint)
  for (const change of [{ checkpointedAt: instant(0) }, { fromGeneration: 99 }, { fromSequence: 99 }, { toGeneration: 99 }, { priorSnapshotDigest: `sha256:${'f'.repeat(64)}` }]) expect(matchingCheckpoint({ ...snapshot, checkpoints: [{ ...checkpoint, ...change }] } as InternalMemoryServiceSnapshotV1, instruction, prior)).toBeUndefined()
  const reduced = reduceMemoryHistoryCommandV1(snapshot, command)
  expect(hasCapacity(adapter.capabilities, snapshot, reduced)).toBe(true)
  for (const key of ['records', 'events', 'receipts', 'tombstones'] as const) {
    const input = key === 'tombstones' ? { ...snapshot, tombstones: [snapshot.records[0]] } as unknown as InternalMemoryServiceSnapshotV1 : snapshot
    expect(hasCapacity({ ...adapter.capabilities, limits: { ...adapter.capabilities.limits, [key]: 0 } }, input, reduced)).toBe(false)
  }
  const firstRecord = snapshot.records.find(item => recordDigest(item) === snapshot.events[0]!.currentRecordDigest)!
  const replayCommand = captureInput(firstRecord).command
  expect(findCommandReceipt(snapshot, command)).toBeUndefined()
  const bound = { ...replayCommand, idempotencyKey: snapshot.receipts[0]!.idempotencyKey }
  expect(findCommandReceipt(snapshot, bound)).toEqual(snapshot.receipts[0])
  expect(reduceMemoryHistoryCommandV1(snapshot, bound)).toMatchObject({ replayed: true, records: [] })
  for (const key of ['commandId', 'eventId', 'receiptId'] as const) {
    expect(() => findCommandReceipt(snapshot, { ...bound, [key]: 'foreign' })).toThrow(/idempotency/)
    expect(() => reduceMemoryHistoryCommandV1(snapshot, { ...bound, [key]: 'foreign' })).toThrow(/idempotency/)
  }
  const invalidCommands = [{ memoryId: 'foreign' }, { generation: 3 }, { expectedSequence: 0 }, { expectedSequence: 99 }, { transitionAt: instant(0) }, { expectedVersionId: 'foreign' }, { expectedRecordDigest: `sha256:${'a'.repeat(64)}` }, { commandId: snapshot.events[0]!.commandId }, { eventId: snapshot.events[0]!.eventId }, { receiptId: snapshot.receipts[0]!.receiptId }]
  for (const change of invalidCommands) expect(() => reduceMemoryHistoryCommandV1(snapshot, { ...command, ...change } as typeof command)).toThrow()
  expect(() => reduceMemoryHistoryCommandV1({ ...snapshot, records: [] } as InternalMemoryServiceSnapshotV1, command)).toThrow()
  const reference = { owner: 'fixture', id: 'receipt', digest: `sha256:${'a'.repeat(64)}` }
  const invalidation = { schema: 'datazup.memory.invalidation-result/v1', status: 'completed', outcomes: [{ target: { ...reference, kind: 'cache' }, status: 'completed', receiptRef: reference }] }
  expect(decodeMemoryInvalidationResultV1(invalidation).status).toBe('completed')
  for (const status of ['partial', 'unsupported', 'retryable']) expect(() => decodeMemoryInvalidationResultV1({ ...invalidation, status })).toThrow()
}, 60_000)
