import { describe, expect, it, vi } from 'vitest'

import {
  projectMemoryVersionChainV1,
  reduceMemoryCommandV1,
} from '../index.js'
import type { MemoryRecordV1 } from '../../records/index.js'
import {
  ARCHIVE_RECEIPT_REF,
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  makeReplacement,
  PURGE_TARGET_REFS,
  time,
} from './fixtures.js'

describe('Memory lifecycle legal transitions', () => {
  it('runs capture, assess, promote, correct, dispute, resolve, revoke, archive, and purge proposal', () => {
    const captured = makeCapturedRecord()
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    expect(capture.state.status).toBe('captured')
    expect(capture.records).toEqual([captured])

    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const candidate = assess.records[0]!
    expect(assess.state.status).toBe('candidate')

    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, candidate),
    )
    const active = promote.records[0]!
    expect(promote.state.retrievalEligible).toBe(true)

    const replacement = makeReplacement(active, 'version-002', time(4), 4)
    const correct = reduceMemoryCommandV1(
      promote.state,
      makeCommand('correct', promote.state, active, { replacement }),
    )
    expect(correct.records).toHaveLength(2)
    expect(correct.records[0]!.lifecycle).toMatchObject({
      status: 'superseded',
      supersededByVersionId: 'version-002',
    })
    expect(correct.records[1]).toEqual(replacement)

    const dispute = reduceMemoryCommandV1(
      correct.state,
      makeCommand('dispute', correct.state, replacement),
    )
    const disputed = dispute.records[0]!
    expect(dispute.state.status).toBe('disputed')
    expect(dispute.state.retrievalEligible).toBe(false)

    const resolve = reduceMemoryCommandV1(
      dispute.state,
      makeCommand('resolve', dispute.state, disputed, { resolutionStatus: 'active' }),
    )
    const resolved = resolve.records[0]!
    expect(resolve.state.status).toBe('active')

    const revoke = reduceMemoryCommandV1(
      resolve.state,
      makeCommand('revoke', resolve.state, resolved),
    )
    const revoked = revoke.records[0]!
    expect(revoke.state.retrievalEligible).toBe(false)
    expect(revoked.content).toEqual(resolved.content)

    const archive = reduceMemoryCommandV1(
      revoke.state,
      makeCommand('archive', revoke.state, revoked, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )
    const archived = archive.records[0]!
    expect(archive.event?.effect).toEqual({
      kind: 'archive-recorded',
      receiptRef: ARCHIVE_RECEIPT_REF,
    })

    const proposal = reduceMemoryCommandV1(
      archive.state,
      makeCommand('propose-purge', archive.state, archived, {
        purgeTargetRefs: PURGE_TARGET_REFS,
      }),
    )
    expect(proposal.records).toEqual([])
    expect(proposal.state.status).toBe('archived')
    expect(proposal.receipt.effectStatus).toBe('proposed')
    const effect = proposal.event?.effect
    expect(effect?.kind).toBe('purge-proposed')
    if (effect?.kind === 'purge-proposed') {
      expect(Object.keys(effect.tombstone).sort()).toEqual([
        'idempotencyKey', 'memoryId', 'proposalEventId', 'recordDigest',
        'schema', 'versionId',
      ])
      expect(JSON.stringify(effect.tombstone)).not.toContain('content')
      expect(JSON.stringify(effect.tombstone)).not.toContain('scope')
    }

    const chain = projectMemoryVersionChainV1(proposal.state.events)
    expect(chain.activeVersionIds).toEqual([])
    expect(chain.purgeProposals).toHaveLength(1)
    expect(chain.versions.find(version => version.versionId === 'version-002')).toMatchObject({
      status: 'archived',
      archiveRecorded: true,
      purgeProposed: true,
    })
  })

  it('runs the review-required confirmation path without confidence authority', () => {
    const captured = makeCapturedRecord()
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const candidate = assess.records[0]!
    const review = reduceMemoryCommandV1(
      assess.state,
      makeCommand('require-review', assess.state, candidate),
    )
    const reviewRequired = review.records[0]!
    const confirm = reduceMemoryCommandV1(
      review.state,
      makeCommand('confirm', review.state, reviewRequired),
    )

    expect(confirm.state.status).toBe('active')
    expect(confirm.state.retrievalEligible).toBe(true)
    expect(confirm.event?.decisionRef).toBe('decision-004')
  })

  it('expires only after the caller-supplied expiry and then archives', () => {
    const captured = makeCapturedRecord({ expiresAt: time(4) })
    const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
    const assess = reduceMemoryCommandV1(
      capture.state,
      makeCommand('assess', capture.state, captured),
    )
    const promote = reduceMemoryCommandV1(
      assess.state,
      makeCommand('promote', assess.state, assess.records[0]!),
    )
    const expire = reduceMemoryCommandV1(
      promote.state,
      makeCommand('expire', promote.state, promote.records[0]!),
    )
    const archive = reduceMemoryCommandV1(
      expire.state,
      makeCommand('archive', expire.state, expire.records[0]!, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )

    expect(expire.state.status).toBe('expired')
    expect(archive.state.status).toBe('archived')
  })

  it('is detached, deeply immutable, and independent of ambient clock and randomness', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('ambient clock used')
    })
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('ambient randomness used')
    })
    try {
      const record = makeCapturedRecord()
      const command = makeCaptureCommand(record)
      const result = reduceMemoryCommandV1(undefined, command)

      expect(result.state).not.toBe(command)
      for (const value of [
        result, result.state, result.state.events, result.receipt,
        result.records[0] as MemoryRecordV1,
      ]) {
        expect(Object.isFrozen(value)).toBe(true)
      }
      expect(now).not.toHaveBeenCalled()
      expect(random).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
      random.mockRestore()
    }
  })
})
