import { describe, expect, it } from 'vitest'

import {
  MemoryTransitionError,
  projectMemoryVersionChainV1,
  reduceMemoryCommandV1,
} from '../index.js'
import type { MemoryEventV1 } from '../types.js'
import {
  makeCaptureCommand,
  makeCapturedRecord,
  makeCommand,
  makeReplacement,
  time,
} from './fixtures.js'

describe('Memory version-chain projection', () => {
  it('preserves competing correction branches and a reviewed resolution', () => {
    const base = activeBase()
    const replacementA = makeReplacement(base.record, 'version-002', time(4), 4, 'Branch A')
    const branchA = reduceMemoryCommandV1(
      base.state,
      makeCommand('correct', base.state, base.record, { replacement: replacementA }),
    )
    const replacementB = makeReplacement(base.record, 'version-003', time(5), 5, 'Branch B')
    const branchB = reduceMemoryCommandV1(
      branchA.state,
      makeCommand('correct', branchA.state, base.record, {
        replacement: replacementB,
        transitionAt: time(5),
      }),
    )

    const unresolved = projectMemoryVersionChainV1(branchB.state.events)
    expect(unresolved.activeVersionIds).toEqual(['version-002', 'version-003'])
    expect(unresolved.conflicts).toEqual([{
      baseVersionId: 'version-001',
      headVersionIds: ['version-002', 'version-003'],
      resolved: false,
    }])

    const disputeB = reduceMemoryCommandV1(
      branchB.state,
      makeCommand('dispute', branchB.state, replacementB),
    )
    const disputedB = disputeB.records[0]!
    const disputed = projectMemoryVersionChainV1(disputeB.state.events)
    expect(disputed.activeVersionIds).toEqual(['version-002'])
    expect(disputed.conflicts[0]?.resolved).toBe(false)
    const resolveB = reduceMemoryCommandV1(
      disputeB.state,
      makeCommand('resolve', disputeB.state, disputedB, {
        resolutionStatus: 'superseded',
        supersededByVersionId: replacementA.versionId,
        supersedingRecordDigest: branchA.state.recordDigest,
      }),
    )
    const resolved = projectMemoryVersionChainV1(resolveB.state.events)

    expect(resolved.activeVersionIds).toEqual(['version-002'])
    expect(resolved.conflicts).toEqual([{
      baseVersionId: 'version-001',
      headVersionIds: ['version-002'],
      resolved: true,
    }])
    expect(resolved.versions.find(version => version.versionId === 'version-003')).toMatchObject({
      status: 'superseded',
      successorVersionIds: ['version-002'],
      retrievalEligible: false,
    })
  })

  it('is deterministic across property insertion order and deeply immutable', () => {
    const base = activeBase()
    const reversed = base.state.events.map(event =>
      Object.fromEntries(Object.entries(event).reverse()) as unknown as MemoryEventV1)

    const first = projectMemoryVersionChainV1(base.state.events)
    const second = projectMemoryVersionChainV1(reversed)

    expect(second).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.versions)).toBe(true)
    expect(Object.isFrozen(first.versions[0])).toBe(true)
  })

  it('fails closed on gaps, reorder, duplicate sequence, and stale digests', () => {
    const base = activeBase()
    const replacement = makeReplacement(base.record, 'version-002', time(4), 4)
    const correction = reduceMemoryCommandV1(
      base.state,
      makeCommand('correct', base.state, base.record, { replacement }),
    )
    const event = correction.event!

    expectCode(() => projectMemoryVersionChainV1([
      ...base.state.events,
      copyEvent(event, { sequence: 5 }),
    ]), 'sequence-gap')
    expectCode(() => projectMemoryVersionChainV1([
      ...base.state.events,
      copyEvent(event, { sequence: 3 }),
    ]), 'sequence-conflict')
    expectCode(() => projectMemoryVersionChainV1([
      base.state.events[1]!,
      base.state.events[0]!,
    ]), 'sequence-gap')

    const copied = copyEvent(event)
    const stale = {
      ...copied,
      recordEffects: copied.recordEffects.map((effect, index) => index === 0
        ? {
            ...effect,
            priorDigest: `sha256:${'f'.repeat(64)}` as `sha256:${string}`,
          }
        : effect),
    }
    expectCode(() => projectMemoryVersionChainV1([
      ...base.state.events,
      stale,
    ]), 'stale-digest')
  })

  it('strictly validates event references and keeps error paths value-free', () => {
    const base = activeBase()
    expectCode(() => projectMemoryVersionChainV1([
      copyEvent(base.state.events[0]!, { actorRef: 'invalid reference' }),
    ]), 'invalid-event')

    const marker = 'sensitive-version-marker'
    const invalid = copyEvent(base.state.events[1]!, {
      currentVersionId: marker,
      recordEffects: [{
        ...base.state.events[1]!.recordEffects[0]!,
        versionId: marker,
      }],
    })
    try {
      projectMemoryVersionChainV1([base.state.events[0]!, invalid])
      throw new Error('expected projection failure')
    } catch (cause) {
      expect(cause).toBeInstanceOf(MemoryTransitionError)
      expect((cause as Error).message).not.toContain(marker)
    }
  })

  it('rejects second roots, revoked-branch reopening, and cyclic relations', () => {
    const base = activeBase()
    const otherRecord = makeCapturedRecord({ versionId: 'version-other' })
    const otherCapture = reduceMemoryCommandV1(undefined, makeCaptureCommand(otherRecord, {
      commandId: 'command-other',
      eventId: 'event-other',
      receiptId: 'receipt-other',
      idempotencyKey: 'idempotency-other',
    }))
    expectCode(() => projectMemoryVersionChainV1([
      ...base.state.events,
      copyEvent(otherCapture.event!, { sequence: 4, occurredAt: time(4) }),
    ]), 'illegal-transition')

    const revoke = reduceMemoryCommandV1(
      base.state,
      makeCommand('revoke', base.state, base.record),
    )
    const replacement = makeReplacement(base.record, 'version-002', time(4), 4)
    const correction = reduceMemoryCommandV1(
      base.state,
      makeCommand('correct', base.state, base.record, { replacement }),
    )
    expectCode(() => projectMemoryVersionChainV1([
      ...revoke.state.events,
      copyEvent(correction.event!, {
        sequence: 5,
        occurredAt: time(5),
        commandId: 'command-reopen',
        eventId: 'event-reopen',
        idempotencyKey: 'idempotency-reopen',
      }),
    ]), 'stale-digest')

    const dispute = reduceMemoryCommandV1(
      correction.state,
      makeCommand('dispute', correction.state, replacement),
    )
    const baseVersion = projectMemoryVersionChainV1(dispute.state.events)
      .versions.find(version => version.versionId === base.record.versionId)!
    const cycleEvent = copyEvent(dispute.event!, {
      sequence: 6,
      type: 'resolve',
      occurredAt: time(6),
      commandId: 'command-cycle',
      eventId: 'event-cycle',
      idempotencyKey: 'idempotency-cycle',
      commandDigest: `sha256:${'a'.repeat(64)}`,
      reasonCode: 'review-resolved',
      currentVersionId: replacement.versionId,
      currentRecordDigest: `sha256:${'b'.repeat(64)}`,
      currentStatus: 'superseded',
      recordEffects: [{
        versionId: replacement.versionId,
        priorDigest: dispute.state.recordDigest,
        resultDigest: `sha256:${'b'.repeat(64)}`,
        statusFrom: 'disputed',
        statusTo: 'superseded',
        supersededByVersionId: base.record.versionId,
        supersedingRecordDigest: baseVersion.recordDigests.at(-1)!,
      }],
    })
    expectCode(() => projectMemoryVersionChainV1([
      ...dispute.state.events,
      cycleEvent,
    ]), 'projection-conflict')
  })

  it('maps hostile projection containers to stable lifecycle errors', () => {
    const base = activeBase()
    const proxy = new Proxy([...base.state.events], {})
    expectCode(() => projectMemoryVersionChainV1(proxy), 'unsafe-input')

    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expectCode(
      () => projectMemoryVersionChainV1(cyclic as MemoryEventV1[]),
      'unsafe-input',
    )
  })
})

function activeBase() {
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
  return { state: promote.state, record: promote.records[0]! }
}

function copyEvent(
  event: MemoryEventV1,
  overrides: Partial<MemoryEventV1> = {},
): MemoryEventV1 & { recordEffects: MemoryEventV1['recordEffects'] } {
  return {
    ...JSON.parse(JSON.stringify(event)) as MemoryEventV1,
    ...overrides,
  }
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
