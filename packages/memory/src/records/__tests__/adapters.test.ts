import type { MemoryRecord } from '@dzupagent/agent-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StagedRecord } from '../../staged-writer.js'
import {
  adaptMemoryRecordToV1,
  adaptStagedRecordToV1,
  MemoryRecordDecodeError,
  type MemoryGovernanceV1,
  type MemoryProvenanceV1,
  type MemoryQualityV1,
} from '../index.js'
import { contentDigest, makeRecord, T0, T1, T2 } from './fixtures.js'

const CREATED_MS = Date.parse(T1)
const UPDATED_MS = Date.parse(T2)

function policyInputs() {
  const record = makeRecord()
  return {
    versionId: record['versionId'] as string,
    kind: record['kind'] as 'fact',
    scope: record['scope'] as {
      tenantId: string
      workspaceId: string
      namespace: string
    },
    lifecycle: record['lifecycle'] as {
      status: 'active'
      reasonCode: string
      transitionSequence: number
      lastTransitionAt: string
    },
    temporal: { observedAt: T0 },
    provenance: record['provenance'] as unknown as MemoryProvenanceV1,
    governance: record['governance'] as unknown as MemoryGovernanceV1,
    quality: record['quality'] as unknown as MemoryQualityV1,
    tags: ['legacy'],
  }
}

function transport(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory-001',
    namespace: 'lessons',
    scope: { tenantId: 'tenant-001', workspaceId: 'workspace-001' },
    content: 'A sanitized legacy observation.',
    metadata: { category: 'lesson' },
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('canonical record compatibility adapters', () => {
  it('losslessly wraps a transport string and safe metadata', () => {
    const adapted = adaptMemoryRecordToV1(transport(), policyInputs())

    expect(adapted.memoryId).toBe('memory-001')
    expect(adapted.temporal.recordedAt).toBe(T1)
    expect(adapted.temporal.updatedAt).toBe(T2)
    expect(adapted.content).toEqual({
      format: 'datazup.memory.transport-content/v1',
      text: 'A sanitized legacy observation.',
      legacyMetadata: { category: 'lesson' },
    })
    expect(adapted.contentDigest).toBe(contentDigest(adapted.content as Record<string, unknown>))
  })

  it('requires exact legacy scope compatibility', () => {
    expect(() => adaptMemoryRecordToV1(
      transport(),
      { ...policyInputs(), scope: { ...policyInputs().scope, tenantId: 'other-tenant' } },
    )).toThrow(MemoryRecordDecodeError)
  })

  it('rejects unsafe legacy metadata even when referenced', () => {
    const legacy = transport({ metadata: { authorityGranted: true } })
    const wrapped = {
      format: 'datazup.memory.transport-content/v1',
      text: legacy.content,
      legacyMetadata: legacy.metadata,
    }
    const digest = contentDigest(wrapped)
    expect(() => adaptMemoryRecordToV1(legacy, {
      ...policyInputs(),
      governance: { ...policyInputs().governance, sensitivity: 'restricted' },
      contentRef: {
        schema: 'datazup.memory.content-ref/v1',
        owner: 'blob-store',
        id: 'content-001',
        digest,
        mediaType: 'application/json',
        byteLength: 128,
      },
    })).toThrow(MemoryRecordDecodeError)
  })

  it('uses a digest-bound reference for restricted transport content', () => {
    const legacy = transport()
    delete legacy.metadata
    const wrapped = {
      format: 'datazup.memory.transport-content/v1',
      text: legacy.content,
    }
    const digest = contentDigest(wrapped)
    const adapted = adaptMemoryRecordToV1(legacy, {
      ...policyInputs(),
      governance: { ...policyInputs().governance, sensitivity: 'restricted' },
      contentRef: {
        schema: 'datazup.memory.content-ref/v1',
        owner: 'blob-store',
        id: 'content-001',
        digest,
        mediaType: 'application/json',
        byteLength: 128,
      },
    })

    expect(adapted.content).toBeUndefined()
    expect(adapted.contentRef?.digest).toBe(digest)
  })

  it('maps staged confidence but does not infer transition sequence or policy', () => {
    const staged: StagedRecord = {
      key: 'memory-001',
      namespace: 'lessons',
      scope: { tenantId: 'tenant-001', workspaceId: 'workspace-001' },
      value: { summary: 'A staged, invented observation.' },
      stage: 'candidate',
      confidence: 0.72,
      createdAt: CREATED_MS,
      promotedAt: UPDATED_MS,
    }
    const inputs = policyInputs()
    const adapted = adaptStagedRecordToV1(staged, {
      ...inputs,
      lifecycle: { ...inputs.lifecycle, status: 'candidate' },
      quality: {
        sourceTrust: 0.9,
        freshnessState: 'current',
        contradictionState: 'none',
        verificationState: 'unverified',
      },
    })

    expect(adapted.lifecycle.transitionSequence).toBe(2)
    expect(adapted.quality.confidence).toBe(0.72)
    expect(adapted.temporal.updatedAt).toBe(T2)
    expect(adapted.content).toEqual({
      format: 'datazup.memory.staged-content/v1',
      value: staged.value,
      legacyStage: {
        stage: 'candidate',
        confidence: 0.72,
        createdAt: CREATED_MS,
        promotedAt: UPDATED_MS,
      },
    })
  })

  it('rejects a staged status or transition time not evidenced by the envelope', () => {
    const staged: StagedRecord = {
      key: 'memory-001',
      namespace: 'lessons',
      scope: { tenantId: 'tenant-001', workspaceId: 'workspace-001' },
      value: { summary: 'A staged, invented observation.' },
      stage: 'candidate',
      confidence: 0.72,
      createdAt: CREATED_MS,
      promotedAt: UPDATED_MS,
    }
    const inputs = policyInputs()
    expect(() => adaptStagedRecordToV1(staged, {
      ...inputs,
      quality: {
        sourceTrust: 0.9,
        freshnessState: 'current',
        contradictionState: 'none',
        verificationState: 'unverified',
      },
    })).toThrow(MemoryRecordDecodeError)
  })

  it('does not consult ambient clock or randomness', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('ambient clock used') })
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('randomness used') })

    expect(adaptMemoryRecordToV1(transport(), policyInputs()).memoryId).toBe('memory-001')
  })
})
