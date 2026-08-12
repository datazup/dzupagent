import { digestMemoryRecordV1 } from '../records/canonical.js'
import {
  canonicalizeSafeJson,
  deepFreezeSafeJson,
  digestSafeJson,
  snapshotSafeJson,
} from '../records/safe-json.js'
import type { MemoryRecordV1, MemoryStatusV1 } from '../records/types.js'
import { projectionFail } from './errors.js'
import type {
  MemoryProjectedRecordV1,
  MemoryProjectionProfileV1,
  MemoryProjectionRequestV1,
  MemoryProjectionV1,
} from './types.js'
import { decodeProjectionRequest } from './validation.js'

const STATUSES: readonly MemoryStatusV1[] = [
  'captured', 'candidate', 'review-required', 'active', 'disputed',
  'superseded', 'revoked', 'expired', 'archived', 'purged', 'rejected',
]

/** Build the immutable semantic projection without performing an effect. */
export function projectMemoryRecordV1(request: MemoryProjectionRequestV1): MemoryProjectionV1 {
  const decoded = decodeProjectionRequest(request)
  const records = decoded.records.map(record => projectRecord(record, decoded.profile))
  const statuses = Object.fromEntries(STATUSES.map(status => [
    status,
    records.filter(record => record.status === status).length,
  ])) as Record<MemoryStatusV1, number>
  const purgeState = records.some(record => record.status === 'purged')
    ? 'record-claims-purged-unverified' as const
    : decoded.chain.purgeProposals.length > 0
      ? 'proposed-incomplete' as const
      : 'not-proposed' as const
  const core = {
    schema: 'datazup.memory.projection/v1' as const,
    formatVersion: '1.0' as const,
    authority: 'none' as const,
    generatedAt: decoded.generatedAt,
    scope: decoded.scope,
    scopeDigest: decoded.scopeDigest,
    profileDigest: decoded.profileDigest,
    redactionPolicyRef: decoded.redactionPolicyRef,
    source: {
      ...decoded.expectedSource,
      sourceDigest: decoded.sourceDigest,
    },
    summary: {
      memoryId: decoded.records[0]!.memoryId,
      recordCount: records.length,
      eventCount: decoded.events.length,
      receiptCount: decoded.receipts.length,
      statuses,
      activeVersionIds: [...decoded.chain.activeVersionIds],
      purgeState,
    },
    records,
    chain: decoded.chain,
    events: decoded.events,
    receipts: decoded.receipts,
  }
  const projection = {
    ...core,
    projectionDigest: digestSafeJson(snapshotSafeJson(core)),
  }
  assertOutputBound(canonicalizeSafeJson(snapshotSafeJson(projection)), decoded.profile)
  return deepFreezeSafeJson(snapshotSafeJson(projection)) as unknown as MemoryProjectionV1
}

function projectRecord(
  record: MemoryRecordV1,
  profile: MemoryProjectionProfileV1,
): MemoryProjectedRecordV1 {
  const content = record.content === undefined ? undefined : snapshotSafeJson(record.content)
  const inlineBytes = content === undefined
    ? 0
    : Buffer.byteLength(canonicalizeSafeJson(content), 'utf8')
  const inline = content !== undefined
    && profile.contentMode === 'exportable-inline'
    && record.governance.exportable
    && record.governance.sensitivity !== 'restricted'
    && profile.inlineSensitivities.includes(record.governance.sensitivity)
    && inlineBytes <= profile.maxInlineContentBytes
  const reason = inline
    ? 'inline' as const
    : content === undefined
      ? 'content-reference' as const
      : profile.contentMode === 'reference-only'
        ? 'profile-reference-only' as const
        : !record.governance.exportable
          ? 'not-exportable' as const
          : record.governance.sensitivity === 'restricted'
            ? 'restricted' as const
            : !profile.inlineSensitivities.includes(record.governance.sensitivity)
              ? 'sensitivity-excluded' as const
              : 'oversized' as const
  return {
    memoryId: record.memoryId,
    versionId: record.versionId,
    kind: record.kind,
    status: record.lifecycle.status,
    recordDigest: digestMemoryRecordV1(record),
    lifecycle: record.lifecycle,
    temporal: record.temporal,
    provenance: record.provenance,
    governance: record.governance,
    quality: record.quality,
    tags: [...record.tags].sort(),
    content: {
      mode: inline ? 'inline' : 'reference-only',
      reason,
      digest: record.contentDigest,
      byteLength: inlineBytes || record.contentRef?.byteLength || 0,
      ...(inline ? { value: content } : {}),
      ...(record.contentRef === undefined ? {} : { contentRef: record.contentRef }),
      ...(record.searchTextRef === undefined ? {} : { searchTextRef: record.searchTextRef }),
    },
  }
}

export function assertOutputBound(text: string, profile: MemoryProjectionProfileV1): void {
  if (Buffer.byteLength(text, 'utf8') > profile.maxOutputBytes) {
    projectionFail('limit-exceeded', ['profile', 'maxOutputBytes'])
  }
}
