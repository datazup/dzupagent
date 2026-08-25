import type { MemoryRecordV1 } from '../../records/types.js'
import type { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import type { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import type {
  InternalMemoryLifecycleWriteInputV1,
  InternalMemoryServiceSnapshotV1,
} from '../types.js'
import {
  captureInput,
  capturedRecord,
  currentRecord,
  DEFAULT_SCOPE,
  instant,
  transitionInput,
} from './fixtures.js'

export const CHECKPOINT_TEST_TIMEOUT_MS = 60_000

export async function prepareActive(
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

export async function fillGeneration(
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

export function rolloverInput(record: MemoryRecordV1): InternalMemoryLifecycleWriteInputV1 {
  return {
    ...transitionInput('resolve', record, 2, 0, 34, { resolutionStatus: 'active' }),
    checkpoint: {
      checkpointId: 'checkpoint-generation-001',
      checkpointedAt: instant(33),
    },
  }
}

export async function loadSnapshot(
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
