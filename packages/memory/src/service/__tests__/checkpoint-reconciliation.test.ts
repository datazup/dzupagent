import { describe, expect, it } from 'vitest'

import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import {
  CHECKPOINT_TEST_TIMEOUT_MS,
  fillGeneration,
  rolloverInput,
} from './checkpoint-fixtures.js'
import { captureInput, capturedRecord, DEFAULT_SCOPE } from './fixtures.js'

describe('memory checkpoint recovery custody', () => {
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
  }, CHECKPOINT_TEST_TIMEOUT_MS)
})
