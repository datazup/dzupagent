import type { BaseStore } from '@langchain/langgraph'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryService } from '../../memory-service.js'
import type { NamespaceConfig } from '../../memory-types.js'
import {
  createObservationConfirmationReceipt,
  MemoryServiceObservationCandidateStore,
} from '../../observation-candidate-store.js'
import { PolicyAwareStagedWriter } from '../../policy-aware-staged-writer.js'
import { adaptStagedRecordToV1 } from '../../records/adapters.js'
import type { StagedRecord } from '../../staged-writer.js'
import { InMemoryMemoryLifecycleAdapter } from '../in-memory-adapter.js'
import { MemoryLifecycleService } from '../memory-lifecycle-service.js'
import {
  captureInput,
  capturedRecord,
  currentRecord,
  DEFAULT_SCOPE,
  instant,
  transitionInput,
} from './fixtures.js'

afterEach(() => vi.restoreAllMocks())

describe('lifecycle service legacy writer compatibility', () => {
  it('round-trips PolicyAwareStagedWriter stages and candidate-store receipt custody', async () => {
    const clock = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse(instant(1)))
      .mockReturnValueOnce(Date.parse(instant(2)))
      .mockReturnValueOnce(Date.parse(instant(3)))
    const writer = new PolicyAwareStagedWriter({
      autoPromoteThreshold: 0.7,
      autoConfirmThreshold: 0.9,
      maxPending: 10,
      policies: [{ name: 'explicit-only', evaluate: () => 'auto' }],
    })
    const stagedScope = {
      tenantId: DEFAULT_SCOPE.tenantId,
      workspaceId: DEFAULT_SCOPE.workspaceId!,
      projectId: DEFAULT_SCOPE.projectId!,
    }
    const captured = cloneStage(writer.capture({
      key: 'memory-staged',
      namespace: DEFAULT_SCOPE.namespace,
      scope: stagedScope,
      value: { summary: 'Legacy staged observation.' },
      confidence: 0.3,
    }))
    const candidate = cloneStage(writer.promote(captured.key)!)
    const confirmed = cloneStage(writer.confirm(captured.key)!)
    expect(clock).toHaveBeenCalledTimes(3)
    expect([captured.stage, candidate.stage, confirmed.stage]).toEqual([
      'captured', 'candidate', 'confirmed',
    ])

    const { store } = createLegacyStore()
    const namespaces: NamespaceConfig[] = [{
      name: 'observation-candidates',
      scopeKeys: ['tenantId', 'workspaceId', 'projectId'],
      searchable: false,
    }]
    const candidateStore = new MemoryServiceObservationCandidateStore(
      new MemoryService(store, namespaces),
      'observation-candidates',
    )
    const receipt = createObservationConfirmationReceipt(
      confirmed,
      Date.parse(instant(4)),
    )
    expect(await candidateStore.put(confirmed)).toBe(true)
    expect(await candidateStore.putReceipt(receipt)).toBe(true)
    const restored = (await candidateStore.load(confirmed.namespace, stagedScope))[0]!
    const restoredReceipt = await candidateStore.getReceipt(
      confirmed.namespace,
      stagedScope,
      confirmed.key,
    )
    expect(restored).toEqual(confirmed)
    expect(restoredReceipt).toEqual(receipt)

    const template = capturedRecord({ memoryId: captured.key })
    const canonicalCaptured = adaptStagedRecordToV1(captured, {
      versionId: template.versionId,
      kind: template.kind,
      scope: template.scope,
      lifecycle: template.lifecycle,
      temporal: { observedAt: template.temporal.observedAt },
      provenance: template.provenance,
      governance: template.governance,
      quality: {
        sourceTrust: template.quality.sourceTrust,
        freshnessState: template.quality.freshnessState,
        contradictionState: template.quality.contradictionState,
        verificationState: template.quality.verificationState,
      },
      tags: template.tags,
    })
    const service = new MemoryLifecycleService(new InMemoryMemoryLifecycleAdapter())
    const capture = await service.remember({
      ...captureInput(canonicalCaptured),
      compatibility: { stagedRecord: captured },
    })
    expect(capture.status).toBe('committed')

    const assessed = await service.remember({
      ...transitionInput('assess', canonicalCaptured, 1, 1, 2),
      compatibility: { stagedRecord: candidate },
    })
    const canonicalCandidate = currentRecord(assessed)
    expect(canonicalCandidate.quality.confidence).toBe(0.3)

    const promoteInput = {
      ...transitionInput('promote', canonicalCandidate, 1, 2, 3),
      compatibility: {
        stagedRecord: restored,
        confirmationReceipt: restoredReceipt!,
      },
    }
    const forged = await service.remember({
      ...promoteInput,
      compatibility: {
        ...promoteInput.compatibility,
        confirmationReceipt: {
          ...promoteInput.compatibility.confirmationReceipt,
          valueDigest: 'f'.repeat(64),
        },
      },
    })
    expect(forged).toMatchObject({ status: 'rejected', reason: 'compatibility-mismatch' })
    expect((await service.explain({
      scope: DEFAULT_SCOPE,
      memoryId: canonicalCaptured.memoryId,
    })).transitions).toHaveLength(2)

    const promoted = await service.remember(promoteInput)
    expect(promoted.status).toBe('committed')
    expect(currentRecord(promoted).lifecycle.status).toBe('active')
    expect(currentRecord(promoted).quality.confidence).toBe(0.3)
  })

  it('rejects mismatched staged scope or unexpected receipts before mutation', async () => {
    const staged: StagedRecord = {
      key: 'memory-stage-mismatch',
      namespace: DEFAULT_SCOPE.namespace,
      scope: {
        tenantId: DEFAULT_SCOPE.tenantId,
        workspaceId: DEFAULT_SCOPE.workspaceId!,
        projectId: DEFAULT_SCOPE.projectId!,
      },
      value: { summary: 'Compatibility mismatch.' },
      stage: 'captured',
      confidence: 0.4,
      createdAt: Date.parse(instant(1)),
    }
    const template = capturedRecord({ memoryId: staged.key })
    const canonical = adaptStagedRecordToV1(staged, {
      versionId: template.versionId,
      kind: template.kind,
      scope: template.scope,
      lifecycle: template.lifecycle,
      temporal: { observedAt: template.temporal.observedAt },
      provenance: template.provenance,
      governance: template.governance,
      quality: {
        sourceTrust: template.quality.sourceTrust,
        freshnessState: template.quality.freshnessState,
        contradictionState: template.quality.contradictionState,
        verificationState: template.quality.verificationState,
      },
      tags: template.tags,
    })
    const adapter = new InMemoryMemoryLifecycleAdapter()
    const service = new MemoryLifecycleService(adapter)
    expect(await service.remember({
      ...captureInput(canonical),
      compatibility: {
        stagedRecord: { ...staged, scope: { ...staged.scope, tenantId: 'tenant-other' } },
      },
    })).toMatchObject({ status: 'rejected', reason: 'compatibility-mismatch' })
    expect(await adapter.load({
      schema: 'datazup.memory.store-load/v1',
      scope: DEFAULT_SCOPE,
      memoryId: canonical.memoryId,
    })).toBeNull()
  })
})

function cloneStage(record: StagedRecord): StagedRecord {
  return JSON.parse(JSON.stringify(record)) as StagedRecord
}

function createLegacyStore() {
  const data = new Map<string, Record<string, unknown>>()
  const key = (namespace: string[], item: string) => `${namespace.join('/')}:${item}`
  // This is a LangGraph BaseStore fixture, not a MemoryService test double.
  // eslint-disable-next-line no-restricted-syntax
  const store = {
    put: async (
      namespace: string[],
      item: string,
      value: Record<string, unknown>,
    ) => { data.set(key(namespace, item), value) },
    get: async (namespace: string[], item: string) => {
      const value = data.get(key(namespace, item))
      return value ? { key: item, value } : undefined
    },
    search: async (namespace: string[]) => {
      const prefix = `${namespace.join('/')}:`
      return [...data.entries()]
        .filter(([entry]) => entry.startsWith(prefix))
        .map(([entry, value]) => ({ key: entry.slice(prefix.length), value }))
    },
    delete: async (namespace: string[], item: string) => {
      data.delete(key(namespace, item))
    },
  }
  return { store: store as unknown as BaseStore }
}
