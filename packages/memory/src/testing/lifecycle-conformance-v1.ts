import {
  projectMemoryVersionChainV1,
  reduceMemoryCommandV1,
} from '../lifecycle/index.js'
import { digestLifecycleValue } from '../lifecycle/validation.js'
import type {
  InternalMemoryReducerResultV1,
} from '../lifecycle/types.js'
import type { MemoryRecordV1 } from '../records/types.js'
import type { MemoryBenchmarkProfileV1 } from './benchmark-profile-v1.js'
import {
  createMemoryConformanceSuiteV1,
  type MemoryConformanceSuiteV1,
} from './conformance-core-v1.js'
import {
  conformanceInstant,
  createCaptureCommand,
  createCapturedConformanceRecord,
  createReplacementConformanceRecord,
  createTransitionCommand,
  currentRecordForDigest,
  MEMORY_CONFORMANCE_FIXTURE_VERSION,
} from './fixtures-v1.js'

/** Build the deterministic pure-lifecycle conformance suite. */
export function createMemoryLifecycleConformanceSuite(
  profile: MemoryBenchmarkProfileV1,
): MemoryConformanceSuiteV1 {
  return createMemoryConformanceSuiteV1({
    suiteId: 'memory-lifecycle-conformance',
    suiteVersion: 'v1',
    domain: 'lifecycle',
    fixtureSetId: 'invented-lifecycle-contracts',
    fixtureVersion: MEMORY_CONFORMANCE_FIXTURE_VERSION,
    profile,
    cases: [{
      id: 'lifecycle.legal-sequence-and-replay',
      capability: 'idempotent-transitions',
      expected: 'pass',
      run: async () => legalSequenceAndReplay(),
    }, {
      id: 'lifecycle.conflicting-replay-rejected',
      capability: 'idempotency-conflict',
      expected: 'pass',
      run: async () => conflictingReplayRejected(),
    }, {
      id: 'lifecycle.correction-preserves-branches',
      capability: 'branch-preservation',
      expected: 'pass',
      run: async () => correctionPreservesBranches(),
    }, {
      id: 'lifecycle.revoke-excludes-immediately',
      capability: 'logical-revocation',
      expected: 'pass',
      run: async () => revokeExcludesImmediately(),
    }, {
      id: 'lifecycle.purge-remains-proposal',
      capability: 'purge-truthfulness',
      expected: 'pass',
      run: async () => purgeRemainsProposal(),
    }, {
      id: 'lifecycle.reorder-gap-and-time-reversal',
      capability: 'ordered-replay',
      expected: 'pass',
      run: async () => invalidOrderingRejected(),
    }, {
      id: 'lifecycle.archive-preserves-custody',
      capability: 'archive-truthfulness',
      expected: 'pass',
      run: async () => archivePreservesCustody(),
    }, {
      id: 'lifecycle.bounded-generated-sequences',
      capability: 'bounded-transition-generation',
      expected: 'pass',
      run: async () => boundedGeneratedSequences(),
    }],
  })
}

function legalSequenceAndReplay() {
  const active = prepareActive('memory-lifecycle-replay')
  const replay = reduceMemoryCommandV1(active.promoted.state, active.promoteCommand)
  const passed = replay.replayed
    && replay.event === undefined
    && digestLifecycleValue(replay.receipt)
      === digestLifecycleValue(active.promoted.receipt)
    && active.promoted.state.sequence === 3
    && active.promoted.state.retrievalEligible
  return {
    passed,
    reasonCode: passed ? 'legal-sequence-replayed' : 'legal-sequence-mismatch',
    evidenceDigests: [active.promoted.receipt.resultStateDigest],
  }
}

function conflictingReplayRejected() {
  const active = prepareActive('memory-lifecycle-conflict')
  const conflicting = {
    ...active.promoteCommand,
    reasonCode: 'human-confirmed',
  }
  const passed = rejects(() =>
    reduceMemoryCommandV1(active.promoted.state, conflicting))
  return {
    passed,
    reasonCode: passed ? 'conflicting-replay-rejected' : 'conflicting-replay-admitted',
  }
}

function correctionPreservesBranches() {
  const active = prepareActive('memory-lifecycle-branches')
  const base = active.record
  const firstReplacement = createReplacementConformanceRecord(
    base,
    'version-branch-a',
    conformanceInstant(4),
    4,
  )
  const first = reduceMemoryCommandV1(
    active.promoted.state,
    createTransitionCommand('correct', active.promoted.state, base, {
      replacement: firstReplacement,
    }),
  )
  const secondReplacement = createReplacementConformanceRecord(
    base,
    'version-branch-b',
    conformanceInstant(5),
    5,
  )
  const second = reduceMemoryCommandV1(
    first.state,
    createTransitionCommand('correct', first.state, base, {
      commandId: 'command-branch-b',
      eventId: 'event-branch-b',
      receiptId: 'receipt-branch-b',
      idempotencyKey: 'idempotency-branch-b',
      transitionAt: conformanceInstant(5),
      replacement: secondReplacement,
    }),
  )
  const chain = projectMemoryVersionChainV1(second.state.events)
  const passed = chain.activeVersionIds.join(',') === 'version-branch-a,version-branch-b'
    && chain.conflicts.length === 1
    && chain.conflicts[0]?.resolved === false
    && chain.versions.find(entry => entry.versionId === base.versionId)?.status === 'superseded'
  return {
    passed,
    reasonCode: passed ? 'correction-branches-preserved' : 'correction-branch-lost',
    evidenceDigests: [first.receipt.resultStateDigest, second.receipt.resultStateDigest],
  }
}

function revokeExcludesImmediately() {
  const active = prepareActive('memory-lifecycle-revoke')
  const revoked = reduceMemoryCommandV1(
    active.promoted.state,
    createTransitionCommand('revoke', active.promoted.state, active.record),
  )
  const chain = projectMemoryVersionChainV1(revoked.state.events)
  const head = chain.versions.find(entry => entry.versionId === active.record.versionId)
  const passed = revoked.state.status === 'revoked'
    && !revoked.state.retrievalEligible
    && head?.retrievalEligible === false
    && chain.activeVersionIds.length === 0
  return {
    passed,
    reasonCode: passed ? 'revocation-immediate' : 'revocation-still-eligible',
    evidenceDigests: [revoked.receipt.resultStateDigest],
  }
}

function purgeRemainsProposal() {
  const active = prepareActive('memory-lifecycle-purge')
  const revoked = reduceMemoryCommandV1(
    active.promoted.state,
    createTransitionCommand('revoke', active.promoted.state, active.record),
  )
  const revokedRecord = currentRecord(revoked)
  const proposed = reduceMemoryCommandV1(
    revoked.state,
    createTransitionCommand('propose-purge', revoked.state, revokedRecord, {
      purgeTargetRefs: [{
        owner: 'invented-store',
        id: 'purge-target-001',
        digest: `sha256:${'6'.repeat(64)}`,
      }],
    }),
  )
  const effect = proposed.event?.effect
  const passed = effect?.kind === 'purge-proposed'
    && proposed.state.status === 'revoked'
    && !proposed.state.retrievalEligible
    && proposed.receipt.effectStatus === 'proposed'
  return {
    passed,
    reasonCode: passed ? 'purge-remains-proposed' : 'purge-falsely-completed',
    evidenceDigests: [proposed.receipt.resultStateDigest],
  }
}

function invalidOrderingRejected() {
  const active = prepareActive('memory-lifecycle-order')
  const gap = createTransitionCommand('dispute', active.promoted.state, active.record, {
    expectedSequence: active.promoted.state.sequence + 2,
  })
  const reorder = createTransitionCommand('dispute', active.promoted.state, active.record, {
    expectedSequence: active.promoted.state.sequence - 1,
  })
  const reverse = createTransitionCommand('dispute', active.promoted.state, active.record, {
    transitionAt: conformanceInstant(1),
  })
  const passed = rejects(() => reduceMemoryCommandV1(active.promoted.state, gap))
    && rejects(() => reduceMemoryCommandV1(active.promoted.state, reorder))
    && rejects(() => reduceMemoryCommandV1(active.promoted.state, reverse))
  return {
    passed,
    reasonCode: passed ? 'invalid-ordering-rejected' : 'invalid-ordering-admitted',
  }
}

function archivePreservesCustody() {
  const active = prepareActive('memory-lifecycle-archive')
  const revoked = reduceMemoryCommandV1(
    active.promoted.state,
    createTransitionCommand('revoke', active.promoted.state, active.record),
  )
  const revokedRecord = currentRecord(revoked)
  const archived = reduceMemoryCommandV1(
    revoked.state,
    createTransitionCommand('archive', revoked.state, revokedRecord, {
      archiveReceiptRef: {
        owner: 'invented-evidence-archive',
        id: 'archive-receipt-001',
        digest: `sha256:${'7'.repeat(64)}`,
      },
    }),
  )
  const chain = projectMemoryVersionChainV1(archived.state.events)
  const version = chain.versions.find(entry => entry.versionId === active.record.versionId)
  const passed = archived.state.status === 'archived'
    && !archived.state.retrievalEligible
    && archived.event?.effect.kind === 'archive-recorded'
    && archived.receipt.effectStatus === 'recorded'
    && version?.archiveRecorded === true
  return {
    passed,
    reasonCode: passed ? 'archive-custody-recorded' : 'archive-custody-mismatch',
    evidenceDigests: [archived.receipt.resultStateDigest],
  }
}

function boundedGeneratedSequences() {
  const evidenceDigests: `sha256:${string}`[] = []
  let passed = true
  for (let index = 0; index < 8; index += 1) {
    const active = prepareActive(`memory-generated-${index}`)
    let previous = active.promoted
    let record = active.record
    for (let step = 0; step < 4; step += 1) {
      const type = record.lifecycle.status === 'active' ? 'dispute' : 'resolve'
      const next = reduceMemoryCommandV1(
        previous.state,
        createTransitionCommand(type, previous.state, record, {
          ...(type === 'resolve' ? { resolutionStatus: 'active' } : {}),
        }),
      )
      passed = passed
        && next.state.sequence === previous.state.sequence + 1
        && next.receipt.previousStateDigest === previous.receipt.resultStateDigest
        && next.receipt.sequence === next.state.sequence
      previous = next
      record = currentRecord(next)
    }
    evidenceDigests.push(previous.receipt.resultStateDigest)

    const captured = createCapturedConformanceRecord({
      memoryId: `memory-generated-invalid-${index}`,
    })
    const capture = reduceMemoryCommandV1(undefined, createCaptureCommand(captured))
    passed = passed && rejects(() => reduceMemoryCommandV1(
      capture.state,
      createTransitionCommand('promote', capture.state, captured),
    ))
  }
  return {
    passed,
    reasonCode: passed ? 'bounded-sequences-continuous' : 'generated-sequence-mismatch',
    evidenceDigests,
  }
}

function prepareActive(memoryId: string): {
  readonly record: MemoryRecordV1
  readonly promoteCommand: ReturnType<typeof createTransitionCommand>
  readonly promoted: InternalMemoryReducerResultV1
} {
  const capturedRecord = createCapturedConformanceRecord({ memoryId })
  const captured = reduceMemoryCommandV1(undefined, createCaptureCommand(capturedRecord))
  const capturedCurrent = currentRecord(captured)
  const assessed = reduceMemoryCommandV1(
    captured.state,
    createTransitionCommand('assess', captured.state, capturedCurrent),
  )
  const candidate = currentRecord(assessed)
  const promoteCommand = createTransitionCommand('promote', assessed.state, candidate)
  const promoted = reduceMemoryCommandV1(assessed.state, promoteCommand)
  return {
    record: currentRecord(promoted),
    promoteCommand,
    promoted,
  }
}

function currentRecord(result: InternalMemoryReducerResultV1): MemoryRecordV1 {
  const digest = result.event?.currentRecordDigest ?? result.state.recordDigest
  return currentRecordForDigest(result.records, digest)
}

function rejects(operation: () => unknown): boolean {
  try {
    operation()
    return false
  } catch {
    return true
  }
}
