import { describe, expect, it } from 'vitest'

import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import type { MemoryAdapterCapabilitiesV1 } from '../types.js'
import {
  CHECKPOINT_TEST_TIMEOUT_MS,
  fillGeneration,
  loadSnapshot,
  rolloverInput,
} from './checkpoint-fixtures.js'

describe('memory checkpoint capacity custody', () => {
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
  }, CHECKPOINT_TEST_TIMEOUT_MS)
})
