import { describe, expect, it, vi } from 'vitest'

import { createInMemoryMemoryOutbox } from '../index.js'
import {
  T1,
  T2,
  T20,
  claimInput,
  completingPort,
  prepareInput,
  runInput,
} from './fixtures.js'

describe('memory outbox retained state', () => {
  it('exports and restores an exactly digest-bound bounded state', async () => {
    const first = createInMemoryMemoryOutbox()
    const envelope = first.prepare(prepareInput())
    first.enqueue(envelope)
    const lease = first.claim(claimInput()).lease!
    await first.runClaimed(runInput(lease), completingPort())

    const exported = first.exportState()
    const restored = createInMemoryMemoryOutbox({ seed: exported })
    expect(restored.exportState()).toEqual(exported)
    expect(restored.inspect()).toEqual(first.inspect())
    expect(Object.isFrozen(exported)).toBe(true)
    expect(Object.isFrozen(exported.entries)).toBe(true)
  })

  it('rejects state tampering and stale digests before accepting a seed', () => {
    const outbox = createInMemoryMemoryOutbox()
    outbox.enqueue(outbox.prepare(prepareInput()))
    const tampered = JSON.parse(JSON.stringify(outbox.exportState())) as {
      entries: { attempt: number }[]
    }
    tampered.entries[0]!.attempt = 9
    expect(() => createInMemoryMemoryOutbox({ seed: tampered })).toThrow(/invalid-value/)
  })

  it('rejects numeric values that cannot survive a stable JSON snapshot', () => {
    const outbox = createInMemoryMemoryOutbox()
    expect(() => outbox.prepare(prepareInput({
      job: {
        ...prepareInput().job as object,
        sourceRevision: Number.MAX_SAFE_INTEGER,
      },
    }))).toThrow(/invalid-value/)
  })

  it('checkpoints only an exact revision and digest without evicting history', () => {
    const outbox = createInMemoryMemoryOutbox({
      limits: { entries: 2, deadLetters: 2, checkpoints: 1 },
    })
    outbox.enqueue(outbox.prepare(prepareInput()))
    const before = outbox.exportState()
    const checkpoint = outbox.checkpoint({
      schema: 'datazup.memory.outbox-checkpoint-request/v1',
      checkpointId: 'checkpoint-001',
      checkpointedAt: T2,
      expectedRevision: before.revision,
      expectedStateDigest: before.stateDigest,
    })

    expect(checkpoint.status).toBe('checkpointed')
    expect(outbox.exportState().checkpoints[0]).toMatchObject({
      revision: before.revision,
      priorStateDigest: before.stateDigest,
    })
    expect(outbox.checkpoint({
      schema: 'datazup.memory.outbox-checkpoint-request/v1',
      checkpointId: 'checkpoint-002',
      checkpointedAt: T20,
      expectedRevision: outbox.exportState().revision,
      expectedStateDigest: outbox.exportState().stateDigest,
    })).toMatchObject({ status: 'idle', reasonCode: 'checkpoint-capacity-exhausted' })
  })

  it('rejects stale checkpoint preconditions without mutation', () => {
    const outbox = createInMemoryMemoryOutbox()
    const before = outbox.exportState()
    const outcome = outbox.checkpoint({
      schema: 'datazup.memory.outbox-checkpoint-request/v1',
      checkpointId: 'checkpoint-stale',
      checkpointedAt: T1,
      expectedRevision: before.revision + 1,
      expectedStateDigest: before.stateDigest,
    })
    expect(outcome).toMatchObject({ status: 'idle', reasonCode: 'stale-checkpoint-precondition' })
    expect(outbox.exportState()).toBe(before)
  })

  it('fails closed at configured capacity and retains every terminal record', () => {
    const outbox = createInMemoryMemoryOutbox({
      limits: { entries: 1, deadLetters: 1, checkpoints: 0 },
    })
    const first = outbox.prepare(prepareInput())
    outbox.enqueue(first)
    const second = outbox.prepare(prepareInput({
      envelopeId: 'envelope-002',
      idempotencyKey: 'idempotency-002',
      job: { ...prepareInput().job as object, jobId: 'job-002' },
    }))
    expect(outbox.enqueue(second)).toMatchObject({
      status: 'idle',
      reasonCode: 'outbox-capacity-exhausted',
    })
    expect(outbox.inspect().entries).toHaveLength(1)
  })

  it('requires an explicit provider route only for external jobs', () => {
    const outbox = createInMemoryMemoryOutbox()
    expect(() => outbox.prepare(prepareInput({
      job: { ...prepareInput().job as object, providerMode: 'external' },
    }))).toThrow(/providerRouteRef/)
    expect(() => outbox.prepare(prepareInput({
      providerRouteRef: {
        owner: 'route-owner',
        id: 'route-001',
        digest: `sha256:${'9'.repeat(64)}`,
      },
    }))).toThrow(/providerRouteRef/)
  })

  it('snapshots untrusted input without invoking accessors', () => {
    const getter = vi.fn(() => 'memory text')
    const input = prepareInput()
    Object.defineProperty(input, 'content', { enumerable: true, get: getter })
    const outbox = createInMemoryMemoryOutbox()
    expect(() => outbox.prepare(input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it('returns immutable reference-only inspections rather than job payloads', () => {
    const outbox = createInMemoryMemoryOutbox()
    outbox.enqueue(outbox.prepare(prepareInput()))
    const inspection = outbox.inspect()
    expect(Object.isFrozen(inspection)).toBe(true)
    expect(Object.keys(inspection.entries[0]!).sort()).toEqual([
      'attempt',
      'envelopeDigest',
      'envelopeId',
      'generation',
      'jobDigest',
      'jobId',
      'nextAvailableAt',
      'scopeDigest',
      'state',
    ])
    expect(JSON.stringify(inspection)).not.toContain('sourceRefs')
  })
})
