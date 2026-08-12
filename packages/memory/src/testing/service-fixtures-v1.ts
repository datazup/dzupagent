import type { MemoryCommandV1 } from '../lifecycle/types.js'
import { digestMemoryRecordV1 } from '../records/canonical.js'
import type { MemoryRecordV1 } from '../records/types.js'
import type { InMemoryMemoryLifecycleAdapter } from '../service/in-memory-adapter.js'
import type { MemoryLifecycleService } from '../service/memory-lifecycle-service.js'
import type {
  InternalMemoryLifecycleWriteResultV1,
  InternalMemoryServiceSnapshotV1,
} from '../service/types.js'
import {
  createCaptureCommand,
  createCapturedConformanceRecord,
  createTransitionCommand,
} from './fixtures-v1.js'

export const CONFORMANCE_INVALIDATION_TARGETS = Object.freeze([{
  kind: 'cache' as const,
  owner: 'invented-memory-cache',
  id: 'cache-target-001',
  digest: `sha256:${'4'.repeat(64)}` as const,
}, {
  kind: 'index' as const,
  owner: 'invented-memory-index',
  id: 'index-target-001',
  digest: `sha256:${'5'.repeat(64)}` as const,
}])

export async function prepareServiceActive(
  service: MemoryLifecycleService,
  memoryId: string,
  options: { readonly legalHold?: boolean } = {},
): Promise<{
  readonly initial: MemoryRecordV1
  readonly capture: MemoryCommandV1
  readonly record: MemoryRecordV1
}> {
  const initial = createCapturedConformanceRecord({
    memoryId,
    ...(options.legalHold === undefined ? {} : { legalHold: options.legalHold }),
  })
  const capture = createCaptureCommand(initial)
  await service.remember({ scope: initial.scope, command: capture })
  const assessed = await service.remember({
    scope: initial.scope,
    command: createTransitionCommand('assess', { generation: 1, sequence: 1 }, initial),
  })
  const candidate = currentServiceRecord(assessed)
  const promoted = await service.remember({
    scope: initial.scope,
    command: createTransitionCommand('promote', { generation: 1, sequence: 2 }, candidate),
  })
  return { initial, capture, record: currentServiceRecord(promoted) }
}

export function currentServiceRecord(
  result: InternalMemoryLifecycleWriteResultV1,
): MemoryRecordV1 {
  if (!result.event) throw new Error('conformance write event missing')
  const record = result.records.find(candidate =>
    digestMemoryRecordV1(candidate) === result.event?.currentRecordDigest)
  if (!record) throw new Error('conformance current record missing')
  return record
}

export async function loadServiceSnapshot(
  adapter: InMemoryMemoryLifecycleAdapter,
  record: Pick<MemoryRecordV1, 'scope' | 'memoryId'>,
): Promise<InternalMemoryServiceSnapshotV1> {
  const snapshot = await adapter.load({
    schema: 'datazup.memory.store-load/v1',
    scope: record.scope,
    memoryId: record.memoryId,
  })
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('conformance snapshot missing')
  }
  return snapshot as InternalMemoryServiceSnapshotV1
}

export async function rejectsAsync(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}
