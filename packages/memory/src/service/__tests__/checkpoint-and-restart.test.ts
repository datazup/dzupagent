import { describe, expect, it } from 'vitest'

import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import {
  CHECKPOINT_TEST_TIMEOUT_MS,
  fillGeneration,
  loadSnapshot,
  prepareActive,
  rolloverInput,
} from './checkpoint-fixtures.js'
import {
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
  }, CHECKPOINT_TEST_TIMEOUT_MS)

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

})
