import { describe, expect, it } from 'vitest'

import type { MemoryCommandV1 } from '../../lifecycle/types.js'
import type { MemoryRecordV1 } from '../../records/types.js'
import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import type {
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryServiceSnapshotV1,
  MemoryAdapterCapabilitiesV1,
} from '../types.js'
import {
  captureInput,
  capturedRecord,
  currentRecord,
  DEFAULT_SCOPE,
  instant,
  replacementRecord,
  transitionInput,
} from './fixtures.js'

describe('memory service checkpoint, replay, and restart custody', () => {
  it('checkpoints exactly at 32 and admits the verified next generation', async () => {
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    const full = await fillGeneration(service, 'memory-rollover')
    const rollover = rolloverInput(full.record)

    expect(await service.remember({
      scope: rollover.scope,
      command: rollover.command,
    })).toMatchObject({
      status: 'rejected',
      reason: 'checkpoint-required',
    })
    await expect(service.remember({
      ...rollover,
      checkpoint: {
        ...rollover.checkpoint!,
        checkpointedAt: instant(31),
      },
    })).rejects.toMatchObject({ code: 'invalid-state' })
    expect(await loadSnapshot(adapter, full.record.memoryId)).toMatchObject({
      generation: 1,
      sequence: 32,
      checkpoints: [],
    })

    const result = await service.remember(rollover)
    expect(result).toMatchObject({
      status: 'committed',
      event: { generation: 2, sequence: 1 },
      checkpoint: { fromGeneration: 1, fromSequence: 32, toGeneration: 2 },
    })
    const explanation = await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: full.record.memoryId,
    })
    expect(explanation).toMatchObject({ generation: 2, sequence: 1 })
    expect(explanation.transitions).toHaveLength(33)
    expect(explanation.checkpoints).toHaveLength(1)

    const snapshot = await loadSnapshot(adapter, full.record.memoryId)
    expect(snapshot.events).toHaveLength(33)
    expect(snapshot.receipts).toHaveLength(33)
    expect(snapshot.checkpoints).toHaveLength(1)
    expect(snapshot.generation).toBe(2)
    expect(snapshot.sequence).toBe(1)
  }, 20_000)

  it('retains exact replay and conflicting idempotency truth across rollover and restart', async () => {
    const firstAdapter = new InMemoryMemoryLifecycleAdapter()
    const firstService = new MemoryLifecycleService(firstAdapter)
    const full = await fillGeneration(firstService, 'memory-restart')
    const rollover = rolloverInput(full.record)
    await firstService.remember(rollover)
    const durable = await firstAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: full.record.memoryId,
    })

    const restartedAdapter = new InMemoryMemoryLifecycleAdapter({ seed: [durable] })
    const restarted = new MemoryLifecycleService(restartedAdapter)
    const replay = await restarted.remember(full.capture)
    expect(replay.status).toBe('replayed')
    expect(replay.receipt).toEqual(full.captureReceipt)
    expect((await restarted.explain({
      scope: DEFAULT_SCOPE,
      memoryId: full.record.memoryId,
    })).transitions).toHaveLength(33)

    const conflict = {
      ...full.capture,
      command: {
        ...full.capture.command,
        reasonCode: 'application-observation',
      } as MemoryCommandV1,
    }
    await expect(restarted.remember(conflict)).rejects.toMatchObject({
      code: 'idempotency-conflict',
    })
  }, 20_000)

  it('reconciles interrupted append and checkpoint outcomes from durable evidence', async () => {
    const appendAfter = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter({
      appendFault: 'ambiguous-after',
    }))
    const appendRecord = capturedRecord({ memoryId: 'memory-append-after' })
    const reconciledAppend = await appendAfter.remember(captureInput(appendRecord))
    expect(reconciledAppend.status).toBe('replayed')
    expect((await appendAfter.explain({
      scope: DEFAULT_SCOPE,
      memoryId: appendRecord.memoryId,
    })).transitions).toHaveLength(1)

    const appendBeforeAdapter = new InMemoryMemoryLifecycleAdapter({
      appendFault: 'ambiguous-before',
    })
    const appendBefore = new MemoryLifecycleService(appendBeforeAdapter)
    const beforeRecord = capturedRecord({ memoryId: 'memory-append-before' })
    expect(await appendBefore.remember(captureInput(beforeRecord))).toMatchObject({
      status: 'retryable',
      reason: 'ambiguous-outcome',
    })
    expect(await appendBeforeAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: beforeRecord.memoryId,
    })).toBeNull()

    const baseAdapter = new InMemoryMemoryLifecycleAdapter()
    const base = new MemoryLifecycleService(baseAdapter)
    const full = await fillGeneration(base, 'memory-checkpoint-interrupt')
    const seed = await baseAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: full.record.memoryId,
    })
    const checkpointAfter = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter({
      seed: [seed],
      checkpointFault: 'ambiguous-after',
    }))
    const afterResult = await checkpointAfter.remember(rolloverInput(full.record))
    expect(afterResult).toMatchObject({
      status: 'committed',
      event: { generation: 2, sequence: 1 },
      checkpoint: { toGeneration: 2 },
    })

    const checkpointBeforeAdapter = new InMemoryMemoryLifecycleAdapter({
      seed: [seed],
      checkpointFault: 'ambiguous-before',
    })
    const checkpointBefore = new MemoryLifecycleService(checkpointBeforeAdapter)
    expect(await checkpointBefore.remember(rolloverInput(full.record))).toMatchObject({
      status: 'retryable',
      reason: 'ambiguous-outcome',
    })
    const interrupted = await checkpointBeforeAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: full.record.memoryId,
    })
    const recovered = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter({
      seed: [interrupted],
    }))
    expect(await recovered.remember(rolloverInput(full.record))).toMatchObject({
      status: 'committed',
      event: { generation: 2, sequence: 1 },
    })
  }, 30_000)

  it('serializes concurrent writers without hidden resequencing', async () => {
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    const active = await prepareActive(service, 'memory-concurrent')
    const left = transitionInput('dispute', active, 1, 3, 4, {
      commandId: 'command-concurrent-left',
      eventId: 'event-concurrent-left',
      receiptId: 'receipt-concurrent-left',
      idempotencyKey: 'idempotency-concurrent-left',
    })
    const right = transitionInput('dispute', active, 1, 3, 4, {
      commandId: 'command-concurrent-right',
      eventId: 'event-concurrent-right',
      receiptId: 'receipt-concurrent-right',
      idempotencyKey: 'idempotency-concurrent-right',
    })
    const outcomes = await Promise.all([service.remember(left), service.remember(right)])
    expect(outcomes.map(result => result.status).sort()).toEqual(['committed', 'conflict'])
    expect((await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    })).transitions.map(event => event.type)).toEqual([
      'capture', 'assess', 'promote', 'dispute',
    ])

    const replayAdapter = new InMemoryMemoryLifecycleAdapter()
    const replayService = new MemoryLifecycleService(replayAdapter)
    const replayActive = await prepareActive(replayService, 'memory-concurrent-replay')
    const equal = transitionInput('dispute', replayActive, 1, 3, 4)
    const equalOutcomes = await Promise.all([
      replayService.remember(equal),
      replayService.remember(JSON.parse(JSON.stringify(equal))),
    ])
    expect(equalOutcomes.map(result => result.status).sort()).toEqual(['committed', 'replayed'])
    expect(equalOutcomes[0]!.receipt).toEqual(equalOutcomes[1]!.receipt)
  })

  it('preserves competing correction branches through persistence and restart', async () => {
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    const active = await prepareActive(service, 'memory-branches')
    const firstReplacement = replacementRecord(active, 'version-branch-a', instant(4), 4)
    await service.correct(transitionInput('correct', active, 1, 3, 4, {
      replacement: firstReplacement,
    }))
    const secondReplacement = replacementRecord(active, 'version-branch-b', instant(5), 5)
    await service.correct(transitionInput('correct', active, 1, 4, 5, {
      replacement: secondReplacement,
      commandId: 'command-branch-b',
      eventId: 'event-branch-b',
      receiptId: 'receipt-branch-b',
      idempotencyKey: 'idempotency-branch-b',
    }))
    const durable = await adapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    })
    const restarted = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter({
      seed: [durable],
    }))
    const query = await restarted.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    })
    expect(query.chain?.activeVersionIds).toEqual(['version-branch-a', 'version-branch-b'])
    expect(query.chain?.conflicts).toEqual([{
      baseVersionId: active.versionId,
      headVersionIds: ['version-branch-a', 'version-branch-b'],
      resolved: false,
    }])
    expect(query.records.map(record => record.versionId).sort()).toEqual([
      'version-branch-a', 'version-branch-b',
    ])
  })

  it('fails before checkpoint mutation when retained bounds cannot admit the next event', async () => {
    const capabilities: MemoryAdapterCapabilitiesV1 = {
      schema: 'datazup.memory.adapter-capabilities/v1',
      atomicCompareAndSwap: true,
      transactions: true,
      checkpoints: true,
      delete: false,
      purge: false,
      indexInvalidation: false,
      durableIdempotency: true,
      authenticatedCustody: true,
      limits: { records: 64, events: 32, receipts: 32, checkpoints: 1, tombstones: 32 },
    }
    const adapter = new InMemoryMemoryLifecycleAdapter({ capabilities })
    const service = new MemoryLifecycleService(adapter)
    const full = await fillGeneration(service, 'memory-bounded')
    expect(await service.remember(rolloverInput(full.record))).toMatchObject({
      status: 'rejected',
      reason: 'capacity-exceeded',
    })
    const snapshot = await loadSnapshot(adapter, full.record.memoryId)
    expect(snapshot).toMatchObject({ generation: 1, sequence: 32, revision: 32 })
    expect(snapshot.checkpoints).toEqual([])
    expect(snapshot.events).toHaveLength(32)
    expect(snapshot.receipts).toHaveLength(32)
  }, 20_000)
})

async function prepareActive(
  service: MemoryLifecycleService,
  memoryId: string,
): Promise<MemoryRecordV1> {
  const record = capturedRecord({ memoryId })
  await service.remember(captureInput(record))
  const candidate = currentRecord(
    await service.remember(transitionInput('assess', record, 1, 1, 2)),
  )
  return currentRecord(
    await service.remember(transitionInput('promote', candidate, 1, 2, 3)),
  )
}

async function fillGeneration(
  service: MemoryLifecycleService,
  memoryId: string,
): Promise<{
  readonly record: MemoryRecordV1
  readonly capture: InternalMemoryLifecycleWriteInputV1
  readonly captureReceipt: NonNullable<Awaited<ReturnType<MemoryLifecycleService['remember']>>['receipt']>
}> {
  const initial = capturedRecord({ memoryId })
  const capture = captureInput(initial)
  const captured = await service.remember(capture)
  let record = initial
  let sequence = 1
  let result = await service.remember(transitionInput('assess', record, 1, sequence, 2))
  record = currentRecord(result)
  sequence += 1
  result = await service.remember(transitionInput('promote', record, 1, sequence, 3))
  record = currentRecord(result)
  sequence += 1
  while (sequence < 32) {
    const type = record.lifecycle.status === 'active' ? 'dispute' : 'resolve'
    result = await service.remember(transitionInput(
      type,
      record,
      1,
      sequence,
      sequence + 1,
      type === 'resolve' ? { resolutionStatus: 'active' } : {},
    ))
    record = currentRecord(result)
    sequence += 1
  }
  if (!captured.receipt) throw new Error('capture receipt missing')
  return { record, capture, captureReceipt: captured.receipt }
}

function rolloverInput(record: MemoryRecordV1): InternalMemoryLifecycleWriteInputV1 {
  return {
    ...transitionInput('resolve', record, 2, 0, 34, { resolutionStatus: 'active' }),
    checkpoint: {
      checkpointId: 'checkpoint-generation-001',
      checkpointedAt: instant(33),
    },
  }
}

async function loadSnapshot(
  adapter: InMemoryMemoryLifecycleAdapter,
  memoryId: string,
): Promise<InternalMemoryServiceSnapshotV1> {
  const snapshot = await adapter.load({
    schema: 'datazup.memory.store-load/v1',
    scope: DEFAULT_SCOPE,
    memoryId,
  })
  if (!snapshot) throw new Error('snapshot missing')
  return snapshot as InternalMemoryServiceSnapshotV1
}
