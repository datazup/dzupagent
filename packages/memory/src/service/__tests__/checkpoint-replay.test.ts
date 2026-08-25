import { describe, expect, it } from 'vitest'

import type { MemoryCommandV1 } from '../../lifecycle/types.js'
import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import {
  CHECKPOINT_TEST_TIMEOUT_MS,
  fillGeneration,
  rolloverInput,
} from './checkpoint-fixtures.js'
import { DEFAULT_SCOPE } from './fixtures.js'

describe('memory checkpoint replay custody', () => {
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
  }, CHECKPOINT_TEST_TIMEOUT_MS)
})
