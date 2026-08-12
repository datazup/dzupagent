import { digestLifecycleValue } from '../lifecycle/validation.js'
import type { MemoryRecordV1 } from '../records/types.js'
import { projectMemoryHistoryV1 } from './history.js'
import { freezeServiceResult, loadServiceSnapshot } from './service-runtime.js'
import { memoryScopeDigestV1, digestServiceValue } from './snapshot.js'
import type {
  InternalMemoryLifecycleExplanationV1,
  InternalMemoryLifecycleQueryInputV1,
  InternalMemoryLifecycleQueryResultV1,
  InternalMemoryServiceSnapshotV1,
  MemoryAdapterCapabilitiesV1,
  MemoryLifecycleStorePort,
} from './types.js'
import { decodeLifecycleQueryInputV1 } from './validation.js'

export async function performQuery(
  store: MemoryLifecycleStorePort,
  rawInput: InternalMemoryLifecycleQueryInputV1,
): Promise<InternalMemoryLifecycleQueryResultV1> {
  const input = decodeLifecycleQueryInputV1(rawInput)
  const loaded = await loadServiceSnapshot(store, input.scope, input.memoryId)
  if (loaded.status === 'not-found') {
    return freezeServiceResult({
      schema: 'datazup.memory.service-query-result/v1',
      status: 'not-found',
      reason: 'not-found',
      records: [],
      checkpointCount: 0,
    })
  }
  if (loaded.status === 'retryable') {
    return freezeServiceResult({
      schema: 'datazup.memory.service-query-result/v1',
      status: 'retryable',
      reason: 'store-unavailable',
      records: [],
      checkpointCount: 0,
    })
  }
  if (loaded.status === 'rejected') {
    return freezeServiceResult({
      schema: 'datazup.memory.service-query-result/v1',
      status: 'rejected',
      reason: 'invalid-store-snapshot',
      records: [],
      checkpointCount: 0,
    })
  }
  const chain = projectMemoryHistoryV1(loaded.snapshot.events)
  return freezeServiceResult({
    schema: 'datazup.memory.service-query-result/v1',
    status: 'completed',
    reason: 'none',
    records: selectQueryRecords(loaded.snapshot, chain, input),
    chain,
    generation: loaded.snapshot.generation,
    sequence: loaded.snapshot.sequence,
    checkpointCount: loaded.snapshot.checkpoints.length,
  })
}

export async function performExplain(
  store: MemoryLifecycleStorePort,
  capabilities: MemoryAdapterCapabilitiesV1,
  rawInput: InternalMemoryLifecycleQueryInputV1,
): Promise<InternalMemoryLifecycleExplanationV1> {
  const input = decodeLifecycleQueryInputV1(rawInput)
  const scopeDigest = memoryScopeDigestV1(input.scope)
  const loaded = await loadServiceSnapshot(store, input.scope, input.memoryId)
  if (loaded.status !== 'found') {
    return freezeServiceResult({
      schema: 'datazup.memory.service-explanation/v1',
      status: loaded.status === 'not-found'
        ? 'not-found'
        : loaded.status === 'retryable' ? 'retryable' : 'rejected',
      reason: loaded.status === 'not-found'
        ? 'not-found'
        : loaded.status === 'retryable' ? 'store-unavailable' : 'invalid-store-snapshot',
      memoryId: input.memoryId,
      scopeDigest,
      transitions: [],
      checkpoints: [],
      capabilities,
    })
  }
  const snapshot = loaded.snapshot
  return freezeServiceResult({
    schema: 'datazup.memory.service-explanation/v1',
    status: 'completed',
    reason: 'none',
    memoryId: input.memoryId,
    scopeDigest,
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    head: snapshot.head,
    chain: projectMemoryHistoryV1(snapshot.events),
    transitions: snapshot.events.map(event => ({
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      reasonCode: event.reasonCode,
      evidenceRefs: event.evidenceRefs,
      currentVersionId: event.currentVersionId,
      currentStatus: event.currentStatus,
    })),
    checkpoints: snapshot.checkpoints.map(entry => ({
      checkpointId: entry.checkpointId,
      checkpointedAt: entry.checkpointedAt,
      fromGeneration: entry.fromGeneration,
      toGeneration: entry.toGeneration,
      digest: digestServiceValue(entry),
    })),
    capabilities,
  })
}

function selectQueryRecords(
  snapshot: InternalMemoryServiceSnapshotV1,
  chain: ReturnType<typeof projectMemoryHistoryV1>,
  input: InternalMemoryLifecycleQueryInputV1,
): readonly MemoryRecordV1[] {
  if (input.includeHistory) return snapshot.records
  const versions = chain.versions.filter(version =>
    version.retrievalEligible || (input.includeDisputed && version.status === 'disputed'))
  return versions.flatMap(version => {
    const digest = version.recordDigests.at(-1)!
    const record = snapshot.records.find(candidate => digestLifecycleValue(candidate) === digest)
    return record ? [record] : []
  })
}
