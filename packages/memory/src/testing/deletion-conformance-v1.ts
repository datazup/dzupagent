import type { MemoryRecordV1 } from '../records/types.js'
import { InMemoryMemoryLifecycleAdapter } from '../service/in-memory-adapter.js'
import { MemoryLifecycleService } from '../service/memory-lifecycle-service.js'
import type { MemoryInvalidationPort } from '../service/types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  createTransitionCommand,
  MEMORY_CONFORMANCE_FIXTURE_VERSION,
} from './fixtures-v1.js'
import {
  CONFORMANCE_INVALIDATION_TARGETS,
  currentServiceRecord,
  loadServiceSnapshot,
  prepareServiceActive,
  rejectsAsync,
} from './service-fixtures-v1.js'

/** Build logical deletion, invalidation, and purge-truth conformance cases. */
export function createMemoryDeletionConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-deletion-conformance',
    suiteVersion: 'v1',
    domain: 'deletion',
    fixtureSetId: 'invented-deletion-contracts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'deletion.revoke-excludes-query',
      capability: 'logical-deletion',
      expected: 'pass',
      run: async () => revokeExcludesQuery(),
    }, {
      id: 'deletion.invalidation-outcome-truth',
      capability: 'invalidation-truthfulness',
      expected: 'pass',
      run: async () => partialInvalidationTruth(),
    }, {
      id: 'deletion.purge-is-proposal',
      capability: 'physical-purge-separation',
      expected: 'pass',
      run: async () => purgeIsProposal(),
    }, {
      id: 'deletion.legal-hold-blocks-purge',
      capability: 'legal-hold',
      expected: 'pass',
      run: async () => legalHoldBlocksPurge(),
    }],
  })
}

async function revokeExcludesQuery() {
  const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
  const active = await prepareServiceActive(service, 'memory-delete-revoke')
  const revoked = await revokeRecord(service, active.record)
  const query = await service.queryLifecycle({
    scope: active.record.scope,
    memoryId: active.record.memoryId,
  })
  const passed = revoked.status === 'committed'
    && revoked.event?.currentStatus === 'revoked'
    && query.status === 'completed'
    && query.records.length === 0
  return {
    passed,
    reasonCode: passed ? 'revoked-query-empty' : 'revoked-query-visible',
    evidenceDigests: revoked.receipt ? [revoked.receipt.resultStateDigest] : [],
  }
}

async function partialInvalidationTruth() {
  const completedPort: MemoryInvalidationPort = {
    invalidate: async request => ({
      schema: 'datazup.memory.invalidation-result/v1',
      status: 'completed',
      outcomes: request.targets.map(target => ({ target, status: 'completed' })),
    }),
  }
  const completedService = new MemoryLifecycleService(
    new InMemoryMemoryLifecycleAdapter(),
    { invalidationPort: completedPort },
  )
  const completedActive = await prepareServiceActive(
    completedService,
    'memory-delete-completed',
  )
  const completed = await completedService.revoke({
    scope: completedActive.record.scope,
    command: createTransitionCommand(
      'revoke',
      { generation: 1, sequence: 3 },
      completedActive.record,
    ),
    invalidationTargets: CONFORMANCE_INVALIDATION_TARGETS,
  })

  const partialPort: MemoryInvalidationPort = {
    invalidate: async request => ({
      schema: 'datazup.memory.invalidation-result/v1',
      status: 'partial',
      outcomes: request.targets.map((target, index) => ({
        target,
        status: index === 0 ? 'completed' : 'retryable',
      })),
    }),
  }
  const service = new MemoryLifecycleService(
    new InMemoryMemoryLifecycleAdapter(),
    { invalidationPort: partialPort },
  )
  const active = await prepareServiceActive(service, 'memory-delete-partial')
  const result = await service.revoke({
    scope: active.record.scope,
    command: createTransitionCommand(
      'revoke',
      { generation: 1, sequence: 3 },
      active.record,
    ),
    invalidationTargets: CONFORMANCE_INVALIDATION_TARGETS,
  })
  const query = await service.queryLifecycle({
    scope: active.record.scope,
    memoryId: active.record.memoryId,
  })
  const unsupportedService = new MemoryLifecycleService(
    new InMemoryMemoryLifecycleAdapter(),
  )
  const unsupportedActive = await prepareServiceActive(
    unsupportedService,
    'memory-delete-unsupported',
  )
  const unsupported = await unsupportedService.revoke({
    scope: unsupportedActive.record.scope,
    command: createTransitionCommand(
      'revoke',
      { generation: 1, sequence: 3 },
      unsupportedActive.record,
    ),
    invalidationTargets: CONFORMANCE_INVALIDATION_TARGETS,
  })
  const passed = completed.status === 'committed'
    && completed.invalidation?.status === 'completed'
    && result.status === 'partial'
    && result.reason === 'invalidation-incomplete'
    && result.invalidation?.status === 'partial'
    && unsupported.status === 'partial'
    && unsupported.invalidation?.status === 'unsupported'
    && query.records.length === 0
  return {
    passed,
    reasonCode: passed ? 'invalidation-outcomes-reported' : 'invalidation-outcome-hidden',
    evidenceDigests: [completed, result, unsupported].flatMap(outcome =>
      outcome.receipt ? [outcome.receipt.resultStateDigest] : []),
  }
}

async function purgeIsProposal() {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const active = await prepareServiceActive(service, 'memory-delete-purge')
  const revoked = await revokeRecord(service, active.record)
  const revokedRecord = currentServiceRecord(revoked)
  const proposed = await service.remember({
    scope: revokedRecord.scope,
    command: purgeCommand(revokedRecord, 4),
  })
  const snapshot = await loadServiceSnapshot(adapter, revokedRecord)
  const passed = proposed.status === 'committed'
    && proposed.receipt?.effectStatus === 'proposed'
    && proposed.event?.effect.kind === 'purge-proposed'
    && snapshot.tombstones.length === 1
    && !adapter.capabilities.delete
    && !adapter.capabilities.purge
  return {
    passed,
    reasonCode: passed ? 'purge-proposal-retained' : 'purge-falsely-completed',
    evidenceDigests: proposed.receipt ? [proposed.receipt.resultStateDigest] : [],
  }
}

async function legalHoldBlocksPurge() {
  const adapter = new InMemoryMemoryLifecycleAdapter()
  const service = new MemoryLifecycleService(adapter)
  const active = await prepareServiceActive(service, 'memory-delete-hold', {
    legalHold: true,
  })
  const revoked = await revokeRecord(service, active.record)
  const revokedRecord = currentServiceRecord(revoked)
  const rejected = await rejectsAsync(() => service.remember({
    scope: revokedRecord.scope,
    command: purgeCommand(revokedRecord, 4),
  }))
  const snapshot = await loadServiceSnapshot(adapter, revokedRecord)
  const passed = rejected && snapshot.tombstones.length === 0 && snapshot.sequence === 4
  return {
    passed,
    reasonCode: passed ? 'legal-hold-enforced' : 'legal-hold-bypassed',
  }
}

function revokeRecord(service: MemoryLifecycleService, record: MemoryRecordV1) {
  return service.revoke({
    scope: record.scope,
    command: createTransitionCommand(
      'revoke',
      { generation: 1, sequence: 3 },
      record,
    ),
  })
}

function purgeCommand(record: MemoryRecordV1, sequence: number) {
  return createTransitionCommand(
    'propose-purge',
    { generation: 1, sequence },
    record,
    {
      purgeTargetRefs: [{
        owner: 'invented-memory-store',
        id: 'purge-target-001',
        digest: `sha256:${'6'.repeat(64)}`,
      }],
    },
  )
}
