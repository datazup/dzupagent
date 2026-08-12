import { describe, expect, it, vi } from 'vitest'

import { MemoryTransitionError } from '../../lifecycle/errors.js'
import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import type {
  MemoryAdapterCapabilitiesV1,
  MemoryInvalidationPort,
  MemoryLifecycleStorePort,
} from '../types.js'
import {
  captureInput,
  capturedRecord,
  currentRecord,
  DEFAULT_SCOPE,
  instant,
  INVALIDATION_TARGETS,
  replacementRecord,
  transitionInput,
} from './fixtures.js'

describe('MemoryLifecycleService facade', () => {
  it('runs remember, correct, query, explain, and logical revoke without changing CRUD', async () => {
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    const captured = capturedRecord({ content: 'SECRET_CANARY_NEVER_EXPLAIN' })

    const capture = await service.remember(captureInput(captured))
    expect(capture.status).toBe('committed')
    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
    })).records).toEqual([])

    const assess = await service.remember(transitionInput('assess', captured, 1, 1, 2))
    const candidate = currentRecord(assess)
    const promote = await service.remember(transitionInput('promote', candidate, 1, 2, 3))
    const active = currentRecord(promote)
    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
    })).records).toEqual([active])

    const replacement = replacementRecord(active, 'version-002', instant(4), 4)
    const correctionInput = transitionInput('correct', active, 1, 3, 4, { replacement })
    const correction = await service.correct(correctionInput)
    expect(correction.status).toBe('committed')
    expect(correction.records).toHaveLength(2)
    expect(correction.records[0]!.lifecycle.status).toBe('superseded')
    expect(currentRecord(correction)).toEqual(replacement)

    const explanation = await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
    })
    expect(explanation.status).toBe('completed')
    expect(explanation.transitions.map(entry => entry.type)).toEqual([
      'capture', 'assess', 'promote', 'correct',
    ])
    expect(explanation.chain?.activeVersionIds).toEqual(['version-002'])
    expect(explanation.capabilities).toMatchObject({
      delete: false,
      purge: false,
      indexInvalidation: false,
    })
    expect(JSON.stringify(explanation)).not.toContain('SECRET_CANARY_NEVER_EXPLAIN')
    expect(JSON.stringify(explanation)).not.toContain('"content"')

    const revokeInput = {
      ...transitionInput('revoke', replacement, 1, 4, 5),
      invalidationTargets: INVALIDATION_TARGETS,
    }
    const revoked = await service.revoke(revokeInput)
    expect(revoked).toMatchObject({
      status: 'partial',
      reason: 'invalidation-incomplete',
      invalidation: { status: 'unsupported' },
    })
    expect(currentRecord(revoked).content).toEqual(replacement.content)
    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
    })).records).toEqual([])
    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
      includeHistory: true,
    })).records.some(record => record.lifecycle.status === 'revoked')).toBe(true)

    const replay = await service.revoke(revokeInput)
    expect(replay.status).toBe('partial')
    expect(replay.receipt).toEqual(revoked.receipt)
    expect((await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: captured.memoryId,
    })).transitions).toHaveLength(5)
  })

  it('keeps disputed and historical access explicit and supports the forget alias', async () => {
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const record = capturedRecord({ memoryId: 'memory-forget' })
    await service.remember(captureInput(record))
    const candidate = currentRecord(
      await service.remember(transitionInput('assess', record, 1, 1, 2)),
    )
    const active = currentRecord(
      await service.remember(transitionInput('promote', candidate, 1, 2, 3)),
    )
    const disputed = currentRecord(
      await service.remember(transitionInput('dispute', active, 1, 3, 4)),
    )

    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: record.memoryId,
    })).records).toEqual([])
    expect((await service.queryLifecycle({
      scope: DEFAULT_SCOPE,
      memoryId: record.memoryId,
      includeDisputed: true,
    })).records).toEqual([disputed])

    const forgotten = await service.forget(transitionInput('revoke', disputed, 1, 4, 5))
    expect(forgotten.status).toBe('committed')
    expect(currentRecord(forgotten).lifecycle.status).toBe('revoked')
  })

  it('makes scope structural on every facade method', async () => {
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const record = capturedRecord({ memoryId: 'memory-scope' })
    const wrongTenant = { ...DEFAULT_SCOPE, tenantId: 'tenant-other' }
    const wrongNamespace = { ...DEFAULT_SCOPE, namespace: 'decisions' }
    const wrongProject = { ...DEFAULT_SCOPE, projectId: 'project-other' }
    await service.remember(captureInput(record))
    const candidate = currentRecord(
      await service.remember(transitionInput('assess', record, 1, 1, 2)),
    )
    const active = currentRecord(
      await service.remember(transitionInput('promote', candidate, 1, 2, 3)),
    )
    const replacement = replacementRecord(active, 'version-scope-002', instant(4), 4)

    await expect(service.remember({
      ...transitionInput('dispute', active, 1, 3, 4),
      scope: wrongTenant,
    })).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(service.correct({
      ...transitionInput('correct', active, 1, 3, 4, { replacement }),
      scope: wrongNamespace,
    })).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(service.forget({
      ...transitionInput('revoke', active, 1, 3, 4),
      scope: wrongProject,
    })).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(service.revoke({
      ...transitionInput('revoke', active, 1, 3, 4),
      scope: wrongProject,
    })).rejects.toMatchObject({ code: 'identity-mismatch' })
    for (const scope of [wrongTenant, wrongNamespace, wrongProject]) {
      expect(await service.queryLifecycle({
        scope,
        memoryId: record.memoryId,
      })).toMatchObject({ status: 'not-found', records: [] })
      expect(await service.explain({
        scope,
        memoryId: record.memoryId,
      })).toMatchObject({ status: 'not-found', transitions: [] })
    }
  })

  it('reports completed and partial injected invalidation truth per target', async () => {
    const completedInvalidate = vi.fn(async (
      request: Parameters<MemoryInvalidationPort['invalidate']>[0],
    ) => ({
        schema: 'datazup.memory.invalidation-result/v1' as const,
        status: 'completed' as const,
        outcomes: request.targets.map(target => ({ target, status: 'completed' as const })),
      }))
    const completedPort: MemoryInvalidationPort = { invalidate: completedInvalidate }
    const completedService = new MemoryLifecycleService(
      new InMemoryMemoryLifecycleAdapter(),
      { invalidationPort: completedPort },
    )
    const completedActive = await prepareActive(completedService, 'memory-invalidation-complete')
    const completed = await completedService.revoke({
      ...transitionInput('revoke', completedActive, 1, 3, 4),
      invalidationTargets: INVALIDATION_TARGETS,
    })
    expect(completed).toMatchObject({ status: 'committed', invalidation: { status: 'completed' } })
    expect(completedInvalidate).toHaveBeenCalledOnce()

    const partialInvalidate = vi.fn(async (
      request: Parameters<MemoryInvalidationPort['invalidate']>[0],
    ) => ({
        schema: 'datazup.memory.invalidation-result/v1' as const,
        status: 'partial' as const,
        outcomes: request.targets.map((target, index) => ({
          target,
          status: index === 0 ? 'completed' as const : 'retryable' as const,
        })),
      }))
    const partialPort: MemoryInvalidationPort = { invalidate: partialInvalidate }
    const partialService = new MemoryLifecycleService(
      new InMemoryMemoryLifecycleAdapter(),
      { invalidationPort: partialPort },
    )
    const partialActive = await prepareActive(partialService, 'memory-invalidation-partial')
    const partial = await partialService.revoke({
      ...transitionInput('revoke', partialActive, 1, 3, 4),
      invalidationTargets: INVALIDATION_TARGETS,
    })
    expect(partial).toMatchObject({
      status: 'partial',
      reason: 'invalidation-incomplete',
      invalidation: { status: 'partial' },
    })
  })

  it('fails closed on unsupported custody and store faults without fallback or empty success', async () => {
    const unsupportedCapabilities: MemoryAdapterCapabilitiesV1 = {
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
    const unsupportedAdapter = new InMemoryMemoryLifecycleAdapter({
      capabilities: unsupportedCapabilities,
    })
    const unsupported = new MemoryLifecycleService(unsupportedAdapter)
    const record = capturedRecord({ memoryId: 'memory-unsupported' })
    expect(await unsupported.remember(captureInput(record))).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported-capability',
      records: [],
    })
    expect(await unsupportedAdapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: record.scope,
      memoryId: record.memoryId,
    })).toBeNull()

    const faultingStore: MemoryLifecycleStorePort = {
      capabilities: { ...unsupportedCapabilities, atomicCompareAndSwap: true },
      load: async () => { throw new Error('sensitive provider failure') },
      append: async () => { throw new Error('must not be reached') },
      checkpoint: async () => { throw new Error('must not be reached') },
    }
    const faulting = new MemoryLifecycleService(faultingStore)
    expect(await faulting.remember(captureInput(record))).toMatchObject({
      status: 'retryable',
      reason: 'store-unavailable',
      records: [],
    })
    expect(await faulting.queryLifecycle({ scope: record.scope, memoryId: record.memoryId })).toMatchObject({
      status: 'retryable',
      records: [],
    })
    expect(JSON.stringify(await faulting.explain({
      scope: record.scope,
      memoryId: record.memoryId,
    }))).not.toContain('sensitive provider failure')
  })

  it('rejects method/command mismatches with value-free lifecycle errors', async () => {
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const record = capturedRecord({ memoryId: 'memory-method' })
    const capture = captureInput(record)
    await expect(service.correct(capture)).rejects.toBeInstanceOf(MemoryTransitionError)
    await expect(service.revoke(capture)).rejects.toMatchObject({ code: 'invalid-command' })
  })
})

async function prepareActive(
  service: MemoryLifecycleService,
  memoryId: string,
) {
  const record = capturedRecord({ memoryId })
  await service.remember(captureInput(record))
  const candidate = currentRecord(
    await service.remember(transitionInput('assess', record, 1, 1, 2)),
  )
  return currentRecord(
    await service.remember(transitionInput('promote', candidate, 1, 2, 3)),
  )
}
