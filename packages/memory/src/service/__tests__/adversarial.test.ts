import { describe, expect, it, vi } from 'vitest'

import type { MemoryCommandV1 } from '../../lifecycle/types.js'
import type { MemoryRecordV1 } from '../../records/types.js'
import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import type {
  InternalMemoryServiceSnapshotV1,
  MemoryAdapterCapabilitiesV1,
  MemoryLifecycleStorePort,
} from '../types.js'
import {
  captureInput,
  capturedRecord,
  currentRecord,
  DEFAULT_SCOPE,
  INVALIDATION_TARGETS,
  transitionInput,
} from './fixtures.js'

const CAPABILITIES: MemoryAdapterCapabilitiesV1 = {
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

describe('memory service hostile stores and fail-closed boundaries', () => {
  it('rejects malformed, forged, reordered, missing, accessor, and proxy snapshots', async () => {
    const source = new InMemoryMemoryLifecycleAdapter()
    const sourceService = new MemoryLifecycleService(source)
    const active = await prepareActive(sourceService, 'memory-hostile')
    const raw = await source.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    }) as InternalMemoryServiceSnapshotV1
    const snapshot = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
    const missingReceipt = { ...snapshot, receipts: (snapshot['receipts'] as unknown[]).slice(1) }
    const reordered = {
      ...snapshot,
      events: [...(snapshot['events'] as unknown[])].reverse(),
    }
    const forged = { ...snapshot, revision: 999 }
    const wrongScope = {
      ...snapshot,
      scope: { ...DEFAULT_SCOPE, tenantId: 'tenant-other' },
    }
    const accessor: Record<string, unknown> = {}
    const getter = vi.fn(() => { throw new Error('secret getter executed') })
    Object.defineProperty(accessor, 'schema', { enumerable: true, get: getter })
    const proxy = new Proxy(snapshot, {})

    for (const hostile of [{}, missingReceipt, reordered, forged, wrongScope, accessor, proxy]) {
      const service = new MemoryLifecycleService(staticStore(hostile))
      expect(await service.queryLifecycle({
        scope: DEFAULT_SCOPE,
        memoryId: active.memoryId,
      })).toMatchObject({
        status: 'rejected',
        reason: 'invalid-store-snapshot',
        records: [],
      })
      expect(await service.explain({
        scope: DEFAULT_SCOPE,
        memoryId: active.memoryId,
      })).toMatchObject({ status: 'rejected', transitions: [] })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not convert malformed or failing append outcomes into success', async () => {
    const record = capturedRecord({ memoryId: 'memory-hostile-append' })
    const malformed: MemoryLifecycleStorePort = {
      capabilities: CAPABILITIES,
      load: async () => null,
      append: async () => ({
        schema: 'datazup.memory.store-outcome/v1',
        status: 'committed',
        reason: 'none',
        snapshot: { forged: true },
      }),
      checkpoint: async () => ({
        schema: 'datazup.memory.store-outcome/v1',
        status: 'unsupported',
        reason: 'unsupported-capability',
      }),
    }
    expect(await new MemoryLifecycleService(malformed).remember(captureInput(record))).toMatchObject({
      status: 'rejected',
      reason: 'invalid-store-snapshot',
      records: [],
    })

    const failing: MemoryLifecycleStorePort = {
      ...malformed,
      append: async () => { throw new Error('/private/path SECRET_STORE_TOKEN') },
    }
    const failure = await new MemoryLifecycleService(failing).remember(captureInput(record))
    expect(failure).toMatchObject({
      status: 'retryable',
      reason: 'store-unavailable',
      records: [],
    })
    expect(JSON.stringify(failure)).not.toContain('SECRET_STORE_TOKEN')
    expect(JSON.stringify(failure)).not.toContain('/private/path')
  })

  it('rejects stale sequence, generation, and digest without mutation', async () => {
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const active = await prepareActive(service, 'memory-stale')
    const base = transitionInput('dispute', active, 1, 3, 4)
    await expect(service.remember({
      ...base,
      command: { ...base.command, expectedSequence: 2 } as MemoryCommandV1,
    })).rejects.toMatchObject({ code: 'sequence-reorder' })
    await expect(service.remember({
      ...base,
      command: { ...base.command, generation: 2 } as MemoryCommandV1,
    })).rejects.toMatchObject({ code: 'stale-generation' })
    await expect(service.remember({
      ...base,
      command: {
        ...base.command,
        expectedRecordDigest: `sha256:${'f'.repeat(64)}`,
      } as MemoryCommandV1,
    })).rejects.toMatchObject({ code: 'stale-digest' })
    expect((await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    })).transitions).toHaveLength(3)
  })

  it('refuses legal-hold purge and bounded tombstone overflow before append', async () => {
    const legalService = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const legalActive = await prepareActive(legalService, 'memory-legal-hold', true)
    const legalRevoked = currentRecord(
      await legalService.revoke(transitionInput('revoke', legalActive, 1, 3, 4)),
    )
    await expect(legalService.remember(transitionInput(
      'propose-purge',
      legalRevoked,
      1,
      4,
      5,
      { purgeTargetRefs: purgeTargets() },
    ))).rejects.toMatchObject({ code: 'legal-hold' })
    expect((await legalService.explain({
      scope: DEFAULT_SCOPE,
      memoryId: legalActive.memoryId,
    })).transitions).toHaveLength(4)

    const boundedCapabilities: MemoryAdapterCapabilitiesV1 = {
      ...CAPABILITIES,
      limits: { ...CAPABILITIES.limits, tombstones: 0 },
    }
    const boundedAdapter = new InMemoryMemoryLifecycleAdapter({ capabilities: boundedCapabilities })
    const bounded = new MemoryLifecycleService(boundedAdapter)
    const boundedActive = await prepareActive(bounded, 'memory-tombstone-bound')
    const boundedRevoked = currentRecord(
      await bounded.revoke(transitionInput('revoke', boundedActive, 1, 3, 4)),
    )
    expect(await bounded.remember(transitionInput(
      'propose-purge',
      boundedRevoked,
      1,
      4,
      5,
      { purgeTargetRefs: purgeTargets() },
    ))).toMatchObject({ status: 'rejected', reason: 'capacity-exceeded' })
    const durable = await boundedAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: boundedActive.memoryId,
    }) as InternalMemoryServiceSnapshotV1
    expect(durable.events).toHaveLength(4)
    expect(durable.receipts).toHaveLength(4)
    expect(durable.tombstones).toEqual([])
    expect(durable.records.length).toBeGreaterThan(durable.tombstones.length)
  })

  it('records a purge proposal without claiming physical purge completion', async () => {
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    const active = await prepareActive(service, 'memory-purge-proposal')
    const revoked = currentRecord(
      await service.revoke(transitionInput('revoke', active, 1, 3, 4)),
    )
    const proposal = await service.remember(transitionInput(
      'propose-purge',
      revoked,
      1,
      4,
      5,
      { purgeTargetRefs: purgeTargets() },
    ))
    expect(proposal).toMatchObject({
      status: 'committed',
      receipt: { effectStatus: 'proposed' },
      event: { effect: { kind: 'purge-proposed' } },
      records: [],
    })
    const snapshot = await adapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    }) as InternalMemoryServiceSnapshotV1
    expect(snapshot.tombstones).toHaveLength(1)
    expect(JSON.stringify(snapshot.tombstones)).not.toContain('content')
    expect((await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: active.memoryId,
    })).capabilities.purge).toBe(false)
  })

  it('keeps forged or missing invalidation target evidence incomplete', async () => {
    const port = {
      invalidate: vi.fn(async () => ({
        schema: 'datazup.memory.invalidation-result/v1' as const,
        status: 'completed' as const,
        outcomes: INVALIDATION_TARGETS.map(target => ({
          target: { ...target, id: `forged-${target.id}` },
          status: 'completed' as const,
        })),
      })),
    }
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter(), {
      invalidationPort: port,
    })
    const active = await prepareActive(service, 'memory-forged-invalidation')
    const result = await service.revoke({
      ...transitionInput('revoke', active, 1, 3, 4),
      invalidationTargets: INVALIDATION_TARGETS,
    })
    expect(result).toMatchObject({
      status: 'partial',
      reason: 'invalidation-incomplete',
      invalidation: { status: 'retryable' },
    })
    expect(currentRecord(result).lifecycle.status).toBe('revoked')
  })

  it('validates exact capability claims at construction', () => {
    expect(() => new InMemoryMemoryLifecycleAdapter({
      capabilities: {
        ...CAPABILITIES,
        checkpoints: false,
      },
    })).toThrow()
    expect(() => new InMemoryMemoryLifecycleAdapter({
      capabilities: {
        ...CAPABILITIES,
        limits: { ...CAPABILITIES.limits, events: 95 },
      },
    })).toThrow()
  })
})

async function prepareActive(
  service: MemoryLifecycleService,
  memoryId: string,
  legalHold = false,
): Promise<MemoryRecordV1> {
  const record = capturedRecord({ memoryId, legalHold })
  await service.remember(captureInput(record))
  const candidate = currentRecord(
    await service.remember(transitionInput('assess', record, 1, 1, 2)),
  )
  return currentRecord(
    await service.remember(transitionInput('promote', candidate, 1, 2, 3)),
  )
}

function staticStore(snapshot: unknown): MemoryLifecycleStorePort {
  return {
    capabilities: CAPABILITIES,
    load: async () => snapshot,
    append: async () => { throw new Error('append not expected') },
    checkpoint: async () => { throw new Error('checkpoint not expected') },
  }
}

function purgeTargets() {
  return [{
    owner: 'memory-store',
    id: 'purge-target-001',
    digest: `sha256:${'6'.repeat(64)}` as const,
  }]
}
