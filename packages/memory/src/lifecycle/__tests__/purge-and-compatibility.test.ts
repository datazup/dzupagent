import { describe, expect, it } from 'vitest'

import {
  createObservationConfirmationReceipt,
  type StagedRecord,
} from '../../index.js'
import {
  adaptStagedRecordToV1,
  digestMemoryRecordV1,
} from '../../records/index.js'
import { digestSafeJson, snapshotSafeJson } from '../../records/safe-json.js'
import { MemoryTransitionError, reduceMemoryCommandV1 } from '../index.js'
import {
  ARCHIVE_RECEIPT_REF,
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  PURGE_TARGET_REFS,
  time,
} from './fixtures.js'

describe('Memory purge truth and legacy compatibility', () => {
  it('blocks purge proposals under legal hold and never fabricates purged state', () => {
    const captured = makeCapturedRecord({ legalHold: true })
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, assess.records[0]!),
    )
    const revoke = reduceMemoryCommandV1(
      promote.state,
      makeCommand('revoke', promote.state, promote.records[0]!),
    )
    const archive = reduceMemoryCommandV1(
      revoke.state,
      makeCommand('archive', revoke.state, revoke.records[0]!, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )

    expectCode(() => reduceMemoryCommandV1(
      archive.state,
      makeCommand('propose-purge', archive.state, archive.records[0]!, {
        purgeTargetRefs: PURGE_TARGET_REFS,
      }),
    ), 'legal-hold')
    expect(archive.state.status).toBe('archived')
    expect(archive.records[0]!.content).toBeDefined()
  })

  it('requires explicit archive evidence, purge targets, and elapsed expiry', () => {
    const captured = makeCapturedRecord({ expiresAt: time(8) })
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, assess.records[0]!),
    )

    expectCode(() => reduceMemoryCommandV1(
      promote.state,
      makeCommand('expire', promote.state, promote.records[0]!),
    ), 'policy-precondition')

    const revoke = reduceMemoryCommandV1(
      promote.state,
      makeCommand('revoke', promote.state, promote.records[0]!),
    )
    expectCode(() => reduceMemoryCommandV1(
      revoke.state,
      makeCommand('archive', revoke.state, revoke.records[0]!),
    ), 'invalid-command')

    const archive = reduceMemoryCommandV1(
      revoke.state,
      makeCommand('archive', revoke.state, revoke.records[0]!, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )
    expectCode(() => reduceMemoryCommandV1(
      archive.state,
      makeCommand('propose-purge', archive.state, archive.records[0]!, {
        purgeTargetRefs: [],
      }),
    ), 'limit-exceeded')
  })

  it('admits exactly the bounded 32-entry ledger and then fails closed', () => {
    const captured = makeCapturedRecord()
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, assess.records[0]!),
    )
    const revoke = reduceMemoryCommandV1(
      promote.state,
      makeCommand('revoke', promote.state, promote.records[0]!),
    )
    const archive = reduceMemoryCommandV1(
      revoke.state,
      makeCommand('archive', revoke.state, revoke.records[0]!, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )
    const record = archive.records[0]!
    let state = archive.state
    while (state.sequence < 32) {
      state = reduceMemoryCommandV1(
        state,
        makeCommand('propose-purge', state, record, {
          purgeTargetRefs: PURGE_TARGET_REFS,
        }),
      ).state
    }

    expect(state.events).toHaveLength(32)
    expect(state.receipts).toHaveLength(32)
    expectCode(() => reduceMemoryCommandV1(
      state,
      makeCommand('propose-purge', state, record, {
        purgeTargetRefs: PURGE_TARGET_REFS,
      }),
    ), 'limit-exceeded')
  })

  it('adapts a staged record without changing legacy storage semantics', () => {
    const staged: StagedRecord = {
      key: 'memory-001',
      namespace: 'lessons',
      scope: { tenantId: 'tenant-001', workspaceId: 'workspace-001' },
      value: { summary: 'A sanitized legacy candidate.' },
      stage: 'captured',
      captureReason: 'explicit request',
      confidence: 0.4,
      createdAt: Date.parse(time(1)),
    }
    const baseline = makeCapturedRecord()
    const canonical = adaptStagedRecordToV1(staged, {
      versionId: baseline.versionId,
      kind: baseline.kind,
      scope: baseline.scope,
      lifecycle: baseline.lifecycle,
      temporal: {
        observedAt: time(0),
        validFrom: time(0),
      },
      provenance: baseline.provenance,
      governance: baseline.governance,
      quality: {
        sourceTrust: baseline.quality.sourceTrust,
        ...(baseline.quality.extractionQuality === undefined ? {} : {
          extractionQuality: baseline.quality.extractionQuality,
        }),
        freshnessState: baseline.quality.freshnessState,
        contradictionState: baseline.quality.contradictionState,
        verificationState: baseline.quality.verificationState,
      },
      tags: baseline.tags,
    })
    const result = reduceMemoryCommandV1(undefined, makeCaptureCommand(canonical))

    expect(result.state.status).toBe('captured')
    expect(result.state.recordDigest).toBe(digestMemoryRecordV1(canonical))
    expect(staged.stage).toBe('captured')
    expect(staged.value).toEqual({ summary: 'A sanitized legacy candidate.' })
  })

  it('binds a legacy confirmation receipt as evidence without granting authority', () => {
    const captured = makeCapturedRecord()
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const review = reduceMemoryCommandV1(
      assess.state,
      makeCommand('require-review', assess.state, assess.records[0]!),
    )
    const staged: StagedRecord = {
      key: 'memory-001',
      namespace: 'lessons',
      scope: { tenantId: 'tenant-001', workspaceId: 'workspace-001' },
      value: { summary: 'A sanitized confirmed candidate.' },
      stage: 'confirmed',
      confidence: 0.8,
      createdAt: Date.parse(time(1)),
      confirmedAt: Date.parse(time(4)),
    }
    const legacyReceipt = createObservationConfirmationReceipt(staged, Date.parse(time(4)))
    const receiptDigest = digestSafeJson(snapshotSafeJson(legacyReceipt))
    const evidenceRef = {
      schema: 'datazup.memory.evidence-ref/v1' as const,
      kind: 'transition-receipt' as const,
      owner: 'legacy-candidate-store',
      id: 'legacy-confirmation-001',
      digest: receiptDigest,
      observedAt: time(4),
      sensitivity: 'internal' as const,
    }
    const command = makeCommand('confirm', review.state, review.records[0]!, {
      evidenceRefs: [evidenceRef],
      decisionRef: 'decision-human-review-001',
    })
    const confirm = reduceMemoryCommandV1(review.state, command)

    expect(confirm.state.status).toBe('active')
    expect(confirm.event?.evidenceRefs).toEqual([evidenceRef])
    expect(confirm.event).not.toHaveProperty('authority')
    expect(confirm.receipt.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})

function expectCode(operation: () => unknown, code: MemoryTransitionError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (cause) {
    expect(cause).toBeInstanceOf(MemoryTransitionError)
    expect((cause as MemoryTransitionError).code).toBe(code)
  }
}
