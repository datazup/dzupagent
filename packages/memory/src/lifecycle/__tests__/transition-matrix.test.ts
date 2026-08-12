import { describe, expect, it } from 'vitest'

import { MemoryTransitionError, projectMemoryVersionChainV1, reduceMemoryCommandV1 } from '../index.js'
import { applyRecordTransition } from '../record-transitions.js'
import type { MemoryLifecycleStateV1 } from '../types.js'
import { decodeMemoryRecordV1, type MemoryRecordV1, type MemoryStatusV1 } from '../../records/index.js'
import {
  ARCHIVE_RECEIPT_REF,
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  makeReplacement,
  PURGE_TARGET_REFS,
  time,
} from './fixtures.js'

describe('Memory lifecycle transition matrix', () => {
  it.each([
    'captured', 'candidate', 'review-required', 'active', 'disputed',
  ] as const)('rejects an admitted %s record', sourceStatus => {
    const source = buildStatus(sourceStatus)
    const result = reduceMemoryCommandV1(
      source.state,
      makeCommand('reject', source.state, source.record),
    )
    expect(result.state.status).toBe('rejected')
    expect(result.records[0]!.lifecycle.status).toBe('rejected')
  })

  it.each(['active', 'disputed'] as const)('revokes an admitted %s record', sourceStatus => {
    const source = buildStatus(sourceStatus)
    const result = reduceMemoryCommandV1(
      source.state,
      makeCommand('revoke', source.state, source.record),
    )
    expect(result.state.status).toBe('revoked')
    expect(result.state.retrievalEligible).toBe(false)
  })

  it.each([
    'superseded', 'revoked', 'expired', 'rejected',
  ] as const)('archives an admitted %s record', sourceStatus => {
    const source = buildStatus(sourceStatus)
    const result = reduceMemoryCommandV1(
      source.state,
      makeCommand('archive', source.state, source.record, {
        archiveReceiptRef: ARCHIVE_RECEIPT_REF,
      }),
    )
    expect(result.state.status).toBe('archived')
    const chain = projectMemoryVersionChainV1(result.state.events)
    expect(chain.versions.find(version => version.versionId === source.record.versionId)).toMatchObject({
      status: 'archived',
      archiveRecorded: true,
    })
  })

  it.each([
    'superseded', 'revoked', 'expired', 'rejected', 'archived',
  ] as const)('proposes purge for an eligible %s record without completing it', sourceStatus => {
    const source = buildStatus(sourceStatus)
    const result = reduceMemoryCommandV1(
      source.state,
      makeCommand('propose-purge', source.state, source.record, {
        purgeTargetRefs: PURGE_TARGET_REFS,
      }),
    )
    expect(result.state.status).toBe(sourceStatus)
    expect(result.state.status).not.toBe('purged')
    expect(result.records).toEqual([])
  })

  it.each(['active', 'revoked'] as const)('resolves a dispute to %s', resolutionStatus => {
    const disputed = buildStatus('disputed')
    const result = reduceMemoryCommandV1(
      disputed.state,
      makeCommand('resolve', disputed.state, disputed.record, { resolutionStatus }),
    )
    expect(result.state.status).toBe(resolutionStatus)
  })

  it('rejects any attempted transition from a terminal purged record', () => {
    const active = buildStatus('active')
    const raw = JSON.parse(JSON.stringify(active.record)) as Record<string, unknown>
    delete raw['content']
    raw['lifecycle'] = {
      ...(raw['lifecycle'] as Record<string, unknown>),
      status: 'purged',
      transitionSequence: 4,
      lastTransitionAt: time(4),
    }
    raw['temporal'] = {
      ...(raw['temporal'] as Record<string, unknown>),
      updatedAt: time(4),
    }
    const purged = decodeMemoryRecordV1(raw)

    expectCode(() => applyRecordTransition(
      makeCommand('assess', active.state, purged),
      4,
    ), 'terminal-transition')
  })
})

function buildStatus(status: MemoryStatusV1): {
  state: MemoryLifecycleStateV1
  record: MemoryRecordV1
} {
  const expiresAt = status === 'expired' ? time(4) : undefined
  const captured = makeCapturedRecord(
    expiresAt === undefined ? {} : { expiresAt },
  )
  const capture = reduceMemoryCommandV1(undefined, makeCaptureCommand(captured))
  if (status === 'captured') return { state: capture.state, record: captured }

  const assess = reduceMemoryCommandV1(
    capture.state,
    makeCommand('assess', capture.state, captured),
  )
  const candidate = assess.records[0]!
  if (status === 'candidate') return { state: assess.state, record: candidate }

  if (status === 'review-required') {
    const review = reduceMemoryCommandV1(
      assess.state,
      makeCommand('require-review', assess.state, candidate),
    )
    return { state: review.state, record: review.records[0]! }
  }

  const promote = reduceMemoryCommandV1(
    assess.state,
    makeCommand('promote', assess.state, candidate),
  )
  const active = promote.records[0]!
  if (status === 'active') return { state: promote.state, record: active }

  if (status === 'disputed') {
    const dispute = reduceMemoryCommandV1(
      promote.state,
      makeCommand('dispute', promote.state, active),
    )
    return { state: dispute.state, record: dispute.records[0]! }
  }

  if (status === 'superseded') {
    const replacement = makeReplacement(active, 'version-002', time(4), 4)
    const correction = reduceMemoryCommandV1(
      promote.state,
      makeCommand('correct', promote.state, active, { replacement }),
    )
    return { state: correction.state, record: correction.records[0]! }
  }

  if (status === 'expired') {
    const expire = reduceMemoryCommandV1(
      promote.state,
      makeCommand('expire', promote.state, active),
    )
    return { state: expire.state, record: expire.records[0]! }
  }

  if (status === 'revoked') {
    const revoke = reduceMemoryCommandV1(
      promote.state,
      makeCommand('revoke', promote.state, active),
    )
    return { state: revoke.state, record: revoke.records[0]! }
  }

  const reject = reduceMemoryCommandV1(
    promote.state,
    makeCommand('reject', promote.state, active),
  )
  if (status === 'rejected') return { state: reject.state, record: reject.records[0]! }

  const archive = reduceMemoryCommandV1(
    reject.state,
    makeCommand('archive', reject.state, reject.records[0]!, {
      archiveReceiptRef: ARCHIVE_RECEIPT_REF,
    }),
  )
  return { state: archive.state, record: archive.records[0]! }
}

function expectCode(operation: () => unknown, code: MemoryTransitionError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (cause) {
    expect(cause).toBeInstanceOf(MemoryTransitionError)
    expect((cause as MemoryTransitionError).code).toBe(code)
  }
}
