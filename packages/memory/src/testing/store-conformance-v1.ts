import { InMemoryMemoryLifecycleAdapter } from '../service/in-memory-adapter.js'
import { MemoryLifecycleService } from '../service/memory-lifecycle-service.js'
import type {
  MemoryAdapterCapabilitiesV1,
  MemoryLifecycleStorePort,
} from '../service/types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  conformanceInstant,
  createCaptureCommand,
  createCapturedConformanceRecord,
  createReplacementConformanceRecord,
  createTransitionCommand,
  MEMORY_CONFORMANCE_FIXTURE_VERSION,
  OTHER_CONFORMANCE_SCOPE,
} from './fixtures-v1.js'
import {
  currentServiceRecord,
  loadServiceSnapshot,
  prepareServiceActive,
  rejectsAsync,
} from './service-fixtures-v1.js'

/** Build the deterministic lifecycle-store and service-facade conformance suite. */
export function createMemoryStoreConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-store-conformance',
    suiteVersion: 'v1',
    domain: 'store',
    fixtureSetId: 'invented-store-contracts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'store.scope-isolation',
      capability: 'scope-isolation',
      expected: 'pass',
      run: async () => scopeIsolation(),
    }, {
      id: 'store.concurrent-cas',
      capability: 'atomic-compare-and-swap',
      expected: 'pass',
      run: async () => concurrentCas(),
    }, {
      id: 'store.restart-and-replay',
      capability: 'durable-idempotency',
      expected: 'pass',
      run: async () => restartAndReplay(),
    }, {
      id: 'store.unsupported-capability',
      capability: 'fail-closed-capabilities',
      expected: 'pass',
      run: async () => unsupportedCapability(),
    }, {
      id: 'store.generation-rollover',
      capability: 'bounded-checkpoint-rollover',
      expected: 'pass',
      run: async () => generationRollover(),
    }, {
      id: 'store.ambiguous-outcome-reconciliation',
      capability: 'ambiguous-outcome-reconciliation',
      expected: 'pass',
      run: async () => ambiguousOutcomeReconciliation(),
    }, {
      id: 'store.hostile-adapter-output',
      capability: 'hostile-adapter-boundary',
      expected: 'pass',
      run: async () => hostileAdapterOutput(),
    }, {
      id: 'store.correction-branches-after-restart',
      capability: 'persistent-correction-branches',
      expected: 'pass',
      run: async () => correctionBranchesAfterRestart(),
    }],
  })
}

async function scopeIsolation() {
  const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
  const active = await prepareServiceActive(service, 'memory-store-scope')
  const hidden = await service.queryLifecycle({
    scope: OTHER_CONFORMANCE_SCOPE,
    memoryId: active.record.memoryId,
  })
  const mismatchRejected = await rejectsAsync(() => service.remember({
    scope: OTHER_CONFORMANCE_SCOPE,
    command: createTransitionCommand(
      'dispute',
      { generation: 1, sequence: 3 },
      active.record,
    ),
  }))
  const passed = hidden.status === 'not-found'
    && hidden.records.length === 0
    && mismatchRejected
  return {
    passed,
    reasonCode: passed ? 'scope-isolated' : 'cross-scope-visible',
  }
}

async function concurrentCas() {
  const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
  const active = await prepareServiceActive(service, 'memory-store-cas')
  const left = createTransitionCommand(
    'dispute',
    { generation: 1, sequence: 3 },
    active.record,
    identityOverrides('left'),
  )
  const right = createTransitionCommand(
    'dispute',
    { generation: 1, sequence: 3 },
    active.record,
    identityOverrides('right'),
  )
  const outcomes = await Promise.all([
    service.remember({ scope: active.record.scope, command: left }),
    service.remember({ scope: active.record.scope, command: right }),
  ])
  const statuses = outcomes.map(outcome => outcome.status).sort().join(',')
  const explanation = await service.explain({
    scope: active.record.scope,
    memoryId: active.record.memoryId,
  })
  const passed = statuses === 'committed,conflict'
    && explanation.transitions.length === 4
  return {
    passed,
    reasonCode: passed ? 'single-writer-won' : 'cas-writer-mismatch',
    evidenceDigests: outcomes.flatMap(outcome =>
      outcome.receipt ? [outcome.receipt.resultStateDigest] : []),
  }
}

async function restartAndReplay() {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const active = await prepareServiceActive(service, 'memory-store-restart')
  const snapshot = await loadServiceSnapshot(adapter, active.record)
  const restarted = new MemoryLifecycleService(
    new InMemoryMemoryLifecycleAdapter({ seed: [snapshot] }),
  )
  const replay = await restarted.remember({
    scope: active.initial.scope,
    command: active.capture,
  })
  const explanation = await restarted.explain({
    scope: active.record.scope,
    memoryId: active.record.memoryId,
  })
  const passed = replay.status === 'replayed'
    && explanation.transitions.length === 3
    && explanation.sequence === 3
  return {
    passed,
    reasonCode: passed ? 'restart-replay-preserved' : 'restart-replay-lost',
    evidenceDigests: replay.receipt ? [replay.receipt.resultStateDigest] : [],
  }
}

async function unsupportedCapability() {
  const capabilities: MemoryAdapterCapabilitiesV1 = {
    schema: 'datazup.memory.adapter-capabilities/v1',
    atomicCompareAndSwap: false,
    transactions: true,
    checkpoints: true,
    delete: false,
    purge: false,
    indexInvalidation: false,
    durableIdempotency: true,
    authenticatedCustody: true,
    limits: { records: 64, events: 96, receipts: 96, checkpoints: 2, tombstones: 32 },
  }
  const adapter = new InMemoryMemoryLifecycleAdapter({ capabilities })
  const service = new MemoryLifecycleService(adapter)
  const initial = createCapturedConformanceRecord({
    memoryId: 'memory-store-unsupported',
  })
  const capture = createCaptureCommand(initial)
  const result = await service.remember({ scope: initial.scope, command: capture })
  const absent = await adapter.load({
    schema: 'datazup.memory.store-load/v1',
    scope: initial.scope,
    memoryId: initial.memoryId,
  })
  const passed = result.status === 'unsupported'
    && result.reason === 'unsupported-capability'
    && absent === null
  return {
    passed,
    reasonCode: passed ? 'unsupported-failed-closed' : 'unsupported-mutated',
  }
}

async function generationRollover() {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const active = await prepareServiceActive(service, 'memory-store-rollover')
  let record = active.record
  let sequence = 3
  while (sequence < 32) {
    const type = record.lifecycle.status === 'active' ? 'dispute' : 'resolve'
    const result = await service.remember({
      scope: record.scope,
      command: createTransitionCommand(type, { generation: 1, sequence }, record, {
        ...(type === 'resolve' ? { resolutionStatus: 'active' } : {}),
        transitionAt: conformanceInstant(sequence + 1),
      }),
    })
    record = currentServiceRecord(result)
    sequence += 1
  }
  const type = record.lifecycle.status === 'active' ? 'dispute' : 'resolve'
  const rollover = await service.remember({
    scope: record.scope,
    command: createTransitionCommand(type, { generation: 2, sequence: 0 }, record, {
      ...(type === 'resolve' ? { resolutionStatus: 'active' } : {}),
      transitionAt: conformanceInstant(33),
    }),
    checkpoint: {
      checkpointId: 'checkpoint-conformance-generation-001',
      checkpointedAt: conformanceInstant(33),
    },
  })
  const snapshot = await loadServiceSnapshot(adapter, record)
  const passed = rollover.status === 'committed'
    && rollover.event?.generation === 2
    && rollover.event.sequence === 1
    && snapshot.checkpoints.length === 1
    && snapshot.events.length === 33
  return {
    passed,
    reasonCode: passed ? 'rollover-bounded' : 'rollover-mismatch',
    evidenceDigests: rollover.receipt ? [rollover.receipt.resultStateDigest] : [],
  }
}

async function ambiguousOutcomeReconciliation() {
  const afterAdapter = new InMemoryMemoryLifecycleAdapter({
    appendFault: 'ambiguous-after',
  })
  const afterService = new MemoryLifecycleService(afterAdapter)
  const afterRecord = createCapturedConformanceRecord({
    memoryId: 'memory-store-ambiguous-after',
  })
  const reconciled = await afterService.remember({
    scope: afterRecord.scope,
    command: createCaptureCommand(afterRecord),
  })

  const beforeAdapter = new InMemoryMemoryLifecycleAdapter({
    appendFault: 'ambiguous-before',
  })
  const beforeService = new MemoryLifecycleService(beforeAdapter)
  const beforeRecord = createCapturedConformanceRecord({
    memoryId: 'memory-store-ambiguous-before',
  })
  const retryable = await beforeService.remember({
    scope: beforeRecord.scope,
    command: createCaptureCommand(beforeRecord),
  })
  const absent = await beforeAdapter.load({
    schema: 'datazup.memory.store-load/v1',
    scope: beforeRecord.scope,
    memoryId: beforeRecord.memoryId,
  })
  const passed = reconciled.status === 'replayed'
    && retryable.status === 'retryable'
    && retryable.reason === 'ambiguous-outcome'
    && absent === null
  return {
    passed,
    reasonCode: passed ? 'ambiguous-outcomes-reconciled' : 'ambiguous-outcome-misreported',
    evidenceDigests: reconciled.receipt ? [reconciled.receipt.resultStateDigest] : [],
  }
}

async function hostileAdapterOutput() {
  const capabilities = conformanceCapabilities()
  const malformedLoadStore: MemoryLifecycleStorePort = {
    capabilities,
    load: async () => new Proxy({}, {}),
    append: async () => { throw new Error('must-not-append') },
    checkpoint: async () => { throw new Error('must-not-checkpoint') },
  }
  const malformedLoad = new MemoryLifecycleService(malformedLoadStore)
  const query = await malformedLoad.queryLifecycle({
    scope: OTHER_CONFORMANCE_SCOPE,
    memoryId: 'memory-hostile-load',
  })

  const malformedAppendStore: MemoryLifecycleStorePort = {
    capabilities,
    load: async () => null,
    append: async () => new Proxy({}, {
      ownKeys() {
        throw new Error('INVENTED_ADAPTER_CANARY_31')
      },
    }),
    checkpoint: async () => null,
  }
  const malformedAppend = new MemoryLifecycleService(malformedAppendStore)
  const record = createCapturedConformanceRecord({ memoryId: 'memory-hostile-append' })
  const write = await malformedAppend.remember({
    scope: record.scope,
    command: createCaptureCommand(record),
  })
  const safe = JSON.stringify({ query, write })
  const passed = query.status === 'rejected'
    && query.reason === 'invalid-store-snapshot'
    && write.status === 'rejected'
    && write.reason === 'invalid-store-snapshot'
    && !safe.includes('INVENTED_ADAPTER_CANARY_31')
  return {
    passed,
    reasonCode: passed ? 'hostile-adapter-contained' : 'hostile-adapter-admitted',
  }
}

async function correctionBranchesAfterRestart() {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const active = await prepareServiceActive(service, 'memory-store-branches')
  const branchA = createReplacementConformanceRecord(
    active.record,
    'version-store-branch-a',
    conformanceInstant(4),
    4,
  )
  const first = await service.correct({
    scope: active.record.scope,
    command: createTransitionCommand(
      'correct',
      { generation: 1, sequence: 3 },
      active.record,
      { replacement: branchA },
    ),
  })
  const branchB = createReplacementConformanceRecord(
    active.record,
    'version-store-branch-b',
    conformanceInstant(5),
    5,
  )
  const second = await service.correct({
    scope: active.record.scope,
    command: createTransitionCommand(
      'correct',
      { generation: 1, sequence: 4 },
      active.record,
      {
        ...identityOverrides('branch-b'),
        replacement: branchB,
        transitionAt: conformanceInstant(5),
      },
    ),
  })
  const snapshot = await loadServiceSnapshot(adapter, active.record)
  const restarted = new MemoryLifecycleService(
    new InMemoryMemoryLifecycleAdapter({ seed: [snapshot] }),
  )
  const query = await restarted.queryLifecycle({
    scope: active.record.scope,
    memoryId: active.record.memoryId,
  })
  const passed = first.status === 'committed'
    && second.status === 'committed'
    && query.chain?.activeVersionIds.join(',')
      === 'version-store-branch-a,version-store-branch-b'
    && query.chain.conflicts.length === 1
  return {
    passed,
    reasonCode: passed ? 'correction-branches-durable' : 'correction-branch-lost',
    evidenceDigests: [first, second].flatMap(result =>
      result.receipt ? [result.receipt.resultStateDigest] : []),
  }
}

function conformanceCapabilities(): MemoryAdapterCapabilitiesV1 {
  return {
    schema: 'datazup.memory.adapter-capabilities/v1',
    atomicCompareAndSwap: true,
    transactions: true,
    checkpoints: true,
    delete: false,
    purge: false,
    indexInvalidation: false,
    durableIdempotency: true,
    authenticatedCustody: true,
    limits: { records: 64, events: 96, receipts: 96, checkpoints: 2, tombstones: 32 },
  }
}

function identityOverrides(suffix: string): Record<string, string> {
  return {
    commandId: `command-concurrent-${suffix}`,
    eventId: `event-concurrent-${suffix}`,
    receiptId: `receipt-concurrent-${suffix}`,
    idempotencyKey: `idempotency-concurrent-${suffix}`,
  }
}
