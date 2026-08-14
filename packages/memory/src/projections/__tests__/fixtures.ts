import { reduceMemoryCommandV1 } from '../../lifecycle/reducer.js'
import type { InternalMemoryReducerResultV1 } from '../../lifecycle/types.js'
import { digestSafeJson, snapshotSafeJson } from '../../records/safe-json.js'
import { decodeMemoryRecordV1 } from '../../records/decoder.js'
import type { MemoryRecordV1 } from '../../records/types.js'
import {
  ARCHIVE_RECEIPT_REF,
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  makeReplacement,
  PURGE_TARGET_REFS,
  time,
} from '../../lifecycle/__tests__/fixtures.js'
import type {
  MemoryProjectionProfileV1,
  MemoryProjectionRequestV1,
} from '../types.js'

export const PROFILE: MemoryProjectionProfileV1 = {
  schema: 'datazup.memory.projection-profile/v1',
  formatVersion: '1.0',
  contentMode: 'reference-only',
  inlineSensitivities: [],
  maxRecords: 16,
  maxEvents: 64,
  maxReceipts: 64,
  maxInlineContentBytes: 4096,
  maxOutputBytes: 256 * 1024,
}

export function activeFixture(record: MemoryRecordV1 = makeCapturedRecord()): {
  readonly result: InternalMemoryReducerResultV1
  readonly request: MemoryProjectionRequestV1
} {
  const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(record))
  const assess = reduceMemoryCommandV1(
    capture.state,
    makeCommand('assess', capture.state, record),
  )
  const candidate = assess.records[0]!
  const promote = reduceMemoryCommandV1(
    assess.state,
    makeCommand('promote', assess.state, candidate),
  )
  return { result: promote, request: requestFor(promote, promote.records) }
}

export function correctedFixture(): {
  readonly base: ReturnType<typeof activeFixture>
  readonly result: InternalMemoryReducerResultV1
  readonly request: MemoryProjectionRequestV1
} {
  const base = activeFixture()
  const active = base.result.records[0]!
  const replacement = makeReplacement(active, 'version-002', time(4), 4)
  const corrected = reduceMemoryCommandV1(
    base.result.state,
    makeCommand('correct', base.result.state, active, { replacement }),
  )
  return { base, result: corrected, request: requestFor(corrected, corrected.records) }
}

export function purgeFixture(): MemoryProjectionRequestV1 {
  const active = activeFixture()
  const current = active.result.records[0]!
  const revoke = reduceMemoryCommandV1(
    active.result.state,
    makeCommand('revoke', active.result.state, current),
  )
  const revoked = revoke.records[0]!
  const archive = reduceMemoryCommandV1(
    revoke.state,
    makeCommand('archive', revoke.state, revoked, { archiveReceiptRef: ARCHIVE_RECEIPT_REF }),
  )
  const archived = archive.records[0]!
  const proposal = reduceMemoryCommandV1(
    archive.state,
    makeCommand('propose-purge', archive.state, archived, { purgeTargetRefs: PURGE_TARGET_REFS }),
  )
  return requestFor(proposal, [archived])
}

export function inlineFixture(contentText = '<script>alert(1)</script> | [run](javascript:x)'): {
  readonly result: InternalMemoryReducerResultV1
  readonly request: MemoryProjectionRequestV1
} {
  const original = makeCapturedRecord({ contentText })
  const record = decodeMemoryRecordV1({
    ...original,
    governance: {
      ...original.governance,
      sensitivity: 'public',
      exportable: true,
    },
  })
  const fixture = activeFixture(record)
  return {
    ...fixture,
    request: {
      ...fixture.request,
      profile: {
        ...PROFILE,
        contentMode: 'exportable-inline',
        inlineSensitivities: ['public'],
      },
    },
  }
}

export function requestFor(
  result: InternalMemoryReducerResultV1,
  inputRecords: readonly MemoryRecordV1[],
  overrides: Partial<MemoryProjectionRequestV1> = {},
): MemoryProjectionRequestV1 {
  const records = [...inputRecords].sort((left, right) => left.versionId.localeCompare(right.versionId))
  const events = [...result.state.events]
  const receipts = [...result.state.receipts]
  return {
    schema: 'datazup.memory.projection-request/v1',
    scope: records[0]!.scope,
    records,
    events,
    receipts,
    expectedSource: {
      recordSetDigest: digestSafeJson(snapshotSafeJson(records)),
      historyDigest: digestSafeJson(snapshotSafeJson({ events, receipts })),
      generation: result.state.generation,
      sequence: result.state.sequence,
    },
    redactionPolicyRef: {
      id: 'projection-redaction',
      version: 'v1',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    generatedAt: time(20),
    profile: PROFILE,
    ...overrides,
  }
}
