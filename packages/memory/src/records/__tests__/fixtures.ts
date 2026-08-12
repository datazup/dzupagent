import { digestSafeJson, snapshotSafeJson } from '../safe-json.js'

export const T0 = '2026-08-11T10:00:00.000Z'
export const T1 = '2026-08-11T10:00:01.000Z'
export const T2 = '2026-08-11T10:00:02.000Z'

export function contentDigest(content: Record<string, unknown>): `sha256:${string}` {
  return digestSafeJson(snapshotSafeJson(content))
}

export function makeRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const content = { summary: 'A bounded, invented memory fixture.' }
  return {
    schema: 'datazup.memory.record/v1',
    memoryId: 'memory-001',
    versionId: 'version-001',
    kind: 'fact',
    scope: {
      tenantId: 'tenant-001',
      workspaceId: 'workspace-001',
      namespace: 'lessons',
    },
    lifecycle: {
      status: 'active',
      reasonCode: 'reviewed',
      transitionSequence: 2,
      lastTransitionAt: T2,
    },
    temporal: {
      observedAt: T0,
      recordedAt: T1,
      updatedAt: T2,
      validFrom: T0,
      lastVerifiedAt: T2,
    },
    provenance: {
      sourceKind: 'application',
      sourceId: 'source-001',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      evidenceRefs: [{
        schema: 'datazup.memory.evidence-ref/v1',
        kind: 'application-event',
        owner: 'sample-app',
        id: 'event-001',
        digest: `sha256:${'2'.repeat(64)}`,
        observedAt: T0,
        sensitivity: 'internal',
      }],
      createdByRef: 'forge://sample/memory-writer',
    },
    governance: {
      sensitivity: 'internal',
      retentionPolicyId: 'working-memory',
      retentionPolicyVersion: 'v1',
      accessPolicyRef: 'access-001',
      writePolicyRef: 'write-001',
      legalHold: false,
      exportable: false,
      userVisible: true,
    },
    quality: {
      confidence: 0.8,
      sourceTrust: 0.9,
      extractionQuality: 0.75,
      freshnessState: 'current',
      contradictionState: 'none',
      verificationState: 'human-reviewed',
    },
    contentDigest: contentDigest(content),
    content,
    tags: ['sample', 'verified'],
    ...overrides,
  }
}
