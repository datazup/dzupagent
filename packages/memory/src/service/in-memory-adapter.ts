import {
  digestValue,
  identifierValue,
  integerValue,
  objectValue,
  required,
  stringValue,
  timestampValue,
} from '../records/decoder-primitives.js'
import { decodeMemoryCommandV1, digestLifecycleValue, timestampMillis } from '../lifecycle/validation.js'
import { transitionFail } from '../lifecycle/errors.js'
import { reduceMemoryHistoryCommandV1 } from './history-reducer.js'
import { projectMemoryHistoryV1 } from './history.js'
import {
  decodeMemoryScopeV1,
  decodeMemoryServiceSnapshotV1,
  digestServiceValue,
  memoryScopeDigestV1,
  sealMemoryServiceSnapshotV1,
  snapshotServiceJson,
} from './snapshot.js'
import { decodeMemoryAdapterCapabilitiesV1 } from './validation.js'
import type {
  InternalMemoryServiceSnapshotV1,
  InternalMemoryStoreOutcomeV1,
  MemoryAdapterCapabilitiesV1,
  MemoryLifecycleStorePort,
} from './types.js'

type AdapterFault = 'none' | 'ambiguous-before' | 'ambiguous-after'

interface InMemoryAdapterOptions {
  readonly seed?: readonly unknown[]
  readonly capabilities?: MemoryAdapterCapabilitiesV1
  readonly appendFault?: AdapterFault
  readonly checkpointFault?: AdapterFault
}

const DEFAULT_CAPABILITIES: MemoryAdapterCapabilitiesV1 = {
  schema: 'datazup.memory.adapter-capabilities/v1',
  atomicCompareAndSwap: true,
  transactions: true,
  checkpoints: true,
  delete: false,
  purge: false,
  indexInvalidation: false,
  durableIdempotency: true,
  authenticatedCustody: true,
  limits: {
    records: 64,
    events: 96,
    receipts: 96,
    checkpoints: 2,
    tombstones: 32,
  },
}

/** Deterministic provider-free reference adapter for lifecycle-store conformance. */
export class InMemoryMemoryLifecycleAdapter implements MemoryLifecycleStorePort {
  readonly capabilities: MemoryAdapterCapabilitiesV1
  private readonly snapshots = new Map<string, InternalMemoryServiceSnapshotV1>()
  private readonly appendFault: AdapterFault
  private readonly checkpointFault: AdapterFault

  constructor(options: InMemoryAdapterOptions = {}) {
    if ((options.seed?.length ?? 0) > 128) transitionFail('limit-exceeded', ['options', 'seed'])
    if ((options.appendFault !== undefined
      && !['none', 'ambiguous-before', 'ambiguous-after'].includes(options.appendFault))
      || (options.checkpointFault !== undefined
        && !['none', 'ambiguous-before', 'ambiguous-after'].includes(options.checkpointFault))) {
      transitionFail('invalid-command', ['options'])
    }
    this.capabilities = decodeMemoryAdapterCapabilitiesV1(
      options.capabilities ?? DEFAULT_CAPABILITIES,
    )
    if (this.capabilities.delete
      || this.capabilities.purge
      || this.capabilities.indexInvalidation) {
      transitionFail('invalid-state', ['capabilities'])
    }
    this.appendFault = options.appendFault ?? 'none'
    this.checkpointFault = options.checkpointFault ?? 'none'
    for (const input of options.seed ?? []) {
      const snapshot = decodeMemoryServiceSnapshotV1(input)
      const key = storageKey(snapshot.scope, snapshot.memoryId)
      if (this.snapshots.has(key)) transitionFail('identity-mismatch', ['seed'])
      this.assertWithinLimits(snapshot)
      this.snapshots.set(key, snapshot)
    }
  }

  async load(
    input: Parameters<MemoryLifecycleStorePort['load']>[0],
  ): Promise<unknown> {
    const request = decodeLoadRequest(input)
    const snapshot = this.snapshots.get(storageKey(request.scope, request.memoryId))
    return snapshot === undefined ? null : decodeMemoryServiceSnapshotV1(snapshot)
  }

  async append(
    input: Parameters<MemoryLifecycleStorePort['append']>[0],
  ): Promise<unknown> {
    const request = decodeAppendRequest(input)
    if (!this.capabilities.atomicCompareAndSwap
      || !this.capabilities.transactions
      || !this.capabilities.durableIdempotency
      || !this.capabilities.authenticatedCustody) {
      return outcome('unsupported', 'unsupported-capability')
    }
    const key = storageKey(request.scope, request.memoryId)
    const current = this.snapshots.get(key)
    if (!matchesExpected(current, request.expectedRevision, request.expectedSnapshotDigest)) {
      return outcome('conflict', 'cas-conflict')
    }
    if (this.appendFault === 'ambiguous-before') {
      return outcome('ambiguous', 'ambiguous-outcome')
    }
    const reduced = reduceMemoryHistoryCommandV1(current, request.command)
    if (reduced.replayed) {
      return outcome('replayed', 'none', {
        snapshot: current!,
        receipt: reduced.receipt,
        records: [],
      })
    }
    const event = reduced.event!
    const records = mergeRecords(current?.records ?? [], reduced.records)
    const events = [...(current?.events ?? []), event]
    const receipts = [...(current?.receipts ?? []), reduced.receipt]
    const tombstones = event.effect.kind === 'purge-proposed'
      ? [...(current?.tombstones ?? []), event.effect.tombstone]
      : [...(current?.tombstones ?? [])]
    if (records.length > this.capabilities.limits.records
      || events.length > this.capabilities.limits.events
      || receipts.length > this.capabilities.limits.receipts
      || tombstones.length > this.capabilities.limits.tombstones) {
      return outcome('rejected', 'capacity-exceeded')
    }
    const next = sealMemoryServiceSnapshotV1({
      schema: 'datazup.memory.store-snapshot/v1',
      scope: request.scope,
      memoryId: request.memoryId,
      generation: event.generation,
      sequence: event.sequence,
      revision: (current?.revision ?? 0) + 1,
      head: {
        versionId: event.currentVersionId,
        recordDigest: event.currentRecordDigest,
        status: event.currentStatus,
        lastTransitionAt: event.occurredAt,
        retrievalEligible: projectMemoryHistoryV1(events).versions.find(
          version => version.versionId === event.currentVersionId,
        )!.retrievalEligible,
      },
      records,
      events,
      receipts,
      checkpoints: current?.checkpoints ?? [],
      tombstones,
    })
    this.snapshots.set(key, next)
    if (this.appendFault === 'ambiguous-after') {
      return outcome('ambiguous', 'ambiguous-outcome')
    }
    return outcome('committed', 'none', {
      snapshot: next,
      receipt: reduced.receipt,
      event,
      records: reduced.records,
    })
  }

  async checkpoint(
    input: Parameters<MemoryLifecycleStorePort['checkpoint']>[0],
  ): Promise<unknown> {
    const request = decodeCheckpointRequest(input)
    if (!this.capabilities.atomicCompareAndSwap
      || !this.capabilities.transactions
      || !this.capabilities.checkpoints
      || !this.capabilities.durableIdempotency
      || !this.capabilities.authenticatedCustody) {
      return outcome('unsupported', 'unsupported-capability')
    }
    const key = storageKey(request.scope, request.memoryId)
    const current = this.snapshots.get(key)
    if (!current
      || !matchesExpected(current, request.expectedRevision, request.expectedSnapshotDigest)
      || current.generation !== request.fromGeneration
      || current.sequence !== request.fromSequence
      || request.fromSequence !== 32
      || request.toGeneration !== request.fromGeneration + 1
      || current.checkpoints.some(entry => entry.checkpointId === request.checkpointId)) {
      return outcome('conflict', 'checkpoint-conflict')
    }
    if (current.checkpoints.length >= this.capabilities.limits.checkpoints) {
      return outcome('rejected', 'capacity-exceeded')
    }
    const lastEvent = current.events.at(-1)!
    const lastReceipt = current.receipts.at(-1)!
    if (timestampMillis(request.checkpointedAt) < timestampMillis(lastEvent.occurredAt)) {
      return outcome('rejected', 'checkpoint-conflict')
    }
    if (this.checkpointFault === 'ambiguous-before') {
      return outcome('ambiguous', 'ambiguous-outcome')
    }
    const checkpoint = {
      schema: 'datazup.memory.store-checkpoint-record/v1' as const,
      checkpointId: request.checkpointId,
      checkpointedAt: request.checkpointedAt,
      memoryId: request.memoryId,
      fromGeneration: request.fromGeneration,
      fromSequence: request.fromSequence,
      toGeneration: request.toGeneration,
      priorSnapshotDigest: current.snapshotDigest,
      stateDigest: lastReceipt.resultStateDigest,
      chainDigest: digestLifecycleValue(projectMemoryHistoryV1(current.events)),
      lastEventDigest: digestLifecycleValue(lastEvent),
      lastReceiptDigest: digestLifecycleValue(lastReceipt),
    }
    const next = sealMemoryServiceSnapshotV1({
      ...withoutSnapshotDigest(current),
      generation: request.toGeneration,
      sequence: 0,
      revision: current.revision + 1,
      checkpoints: [...current.checkpoints, checkpoint],
    })
    this.snapshots.set(key, next)
    if (this.checkpointFault === 'ambiguous-after') {
      return outcome('ambiguous', 'ambiguous-outcome')
    }
    return outcome('committed', 'none', { snapshot: next, checkpoint })
  }

  private assertWithinLimits(snapshot: InternalMemoryServiceSnapshotV1): void {
    if (snapshot.records.length > this.capabilities.limits.records
      || snapshot.events.length > this.capabilities.limits.events
      || snapshot.receipts.length > this.capabilities.limits.receipts
      || snapshot.checkpoints.length > this.capabilities.limits.checkpoints
      || snapshot.tombstones.length > this.capabilities.limits.tombstones) {
      transitionFail('limit-exceeded', ['seed'])
    }
  }
}

function decodeLoadRequest(input: unknown) {
  const root = objectValue(snapshotServiceJson(input), [], ['schema', 'scope', 'memoryId'])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.store-load/v1') {
    transitionFail('invalid-command', ['schema'])
  }
  return {
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    memoryId: identifierValue(root, 'memoryId', []),
  }
}

function decodeAppendRequest(input: unknown) {
  const root = objectValue(snapshotServiceJson(input), [], [
    'schema', 'scope', 'memoryId', 'command', 'expectedRevision',
    'expectedSnapshotDigest',
  ])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.store-append/v1') {
    transitionFail('invalid-command', ['schema'])
  }
  const scope = decodeMemoryScopeV1(required(root, 'scope', []))
  const memoryId = identifierValue(root, 'memoryId', [])
  const command = decodeMemoryCommandV1(required(root, 'command', []))
  if (command.memoryId !== memoryId
    || digestServiceValue(command.record.scope) !== digestServiceValue(scope)) {
    transitionFail('identity-mismatch')
  }
  return {
    scope,
    memoryId,
    command,
    expectedRevision: nonNegativeInteger(root, 'expectedRevision'),
    ...(root['expectedSnapshotDigest'] === undefined ? {} : {
      expectedSnapshotDigest: digestValue(root, 'expectedSnapshotDigest', []),
    }),
  }
}

function decodeCheckpointRequest(input: unknown) {
  const root = objectValue(snapshotServiceJson(input), [], [
    'schema', 'scope', 'memoryId', 'checkpointId', 'checkpointedAt',
    'expectedRevision', 'expectedSnapshotDigest', 'fromGeneration',
    'fromSequence', 'toGeneration',
  ])
  if (stringValue(root, 'schema', []) !== 'datazup.memory.store-checkpoint/v1') {
    transitionFail('invalid-command', ['schema'])
  }
  return {
    scope: decodeMemoryScopeV1(required(root, 'scope', [])),
    memoryId: identifierValue(root, 'memoryId', []),
    checkpointId: identifierValue(root, 'checkpointId', []),
    checkpointedAt: timestampValue(root, 'checkpointedAt', []),
    expectedRevision: nonNegativeInteger(root, 'expectedRevision'),
    expectedSnapshotDigest: digestValue(root, 'expectedSnapshotDigest', []),
    fromGeneration: positiveInteger(root, 'fromGeneration'),
    fromSequence: positiveInteger(root, 'fromSequence'),
    toGeneration: positiveInteger(root, 'toGeneration'),
  }
}

function matchesExpected(
  current: InternalMemoryServiceSnapshotV1 | undefined,
  expectedRevision: number,
  expectedDigest: `sha256:${string}` | undefined,
): boolean {
  if (!current) return expectedRevision === 0 && expectedDigest === undefined
  return current.revision === expectedRevision && current.snapshotDigest === expectedDigest
}

function mergeRecords(
  current: InternalMemoryServiceSnapshotV1['records'],
  updates: InternalMemoryServiceSnapshotV1['records'],
) {
  const output = [...current]
  const digests = new Set(output.map(digestLifecycleValue))
  for (const record of updates) {
    const digest = digestLifecycleValue(record)
    if (!digests.has(digest)) {
      output.push(record)
      digests.add(digest)
    }
  }
  return output
}

function storageKey(scope: Parameters<typeof memoryScopeDigestV1>[0], memoryId: string): string {
  return `${memoryScopeDigestV1(scope)}\0${memoryId}`
}

function outcome(
  status: InternalMemoryStoreOutcomeV1['status'],
  reason: InternalMemoryStoreOutcomeV1['reason'],
  fields: Omit<InternalMemoryStoreOutcomeV1, 'schema' | 'status' | 'reason'> = {},
): InternalMemoryStoreOutcomeV1 {
  return {
    schema: 'datazup.memory.store-outcome/v1',
    status,
    reason,
    ...fields,
  }
}

function withoutSnapshotDigest(
  snapshot: InternalMemoryServiceSnapshotV1,
): Omit<InternalMemoryServiceSnapshotV1, 'snapshotDigest'> {
  return {
    schema: snapshot.schema,
    scope: snapshot.scope,
    memoryId: snapshot.memoryId,
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    revision: snapshot.revision,
    head: snapshot.head,
    records: snapshot.records,
    events: snapshot.events,
    receipts: snapshot.receipts,
    checkpoints: snapshot.checkpoints,
    tombstones: snapshot.tombstones,
  }
}

function nonNegativeInteger(root: ReturnType<typeof objectValue>, key: string): number {
  const value = integerValue(root, key, [])
  if (value < 0) transitionFail('invalid-command', [key])
  return value
}

function positiveInteger(root: ReturnType<typeof objectValue>, key: string): number {
  const value = integerValue(root, key, [])
  if (value < 1) transitionFail('invalid-command', [key])
  return value
}
