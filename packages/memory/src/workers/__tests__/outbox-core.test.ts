import { describe, expect, it, vi } from 'vitest'

import { createInMemoryMemoryOutbox } from '../index.js'
import { digestWorkerValue } from '../snapshot.js'
import type {
  InternalMemoryWorkerExecutionRequestV1,
  MemoryConsolidationPort,
} from '../types.js'
import {
  T3,
  T4,
  admitted,
  budgetRef,
  claimInput,
  completingPort,
  consolidationResult,
  policyRef,
  prepareInput,
  ref,
  runInput,
  schedulerRef,
  scope,
} from './fixtures.js'

function preparedClaimed() {
  const outbox = createInMemoryMemoryOutbox()
  const envelope = outbox.prepare(prepareInput())
  expect(outbox.enqueue(envelope).status).toBe('enqueued')
  const claim = outbox.claim(claimInput())
  expect(claim.status).toBe('claimed')
  return { outbox, envelope, lease: claim.lease! }
}

describe('in-memory memory outbox', () => {
  it('retains only reference envelopes and completes with review-required candidates', async () => {
    const { outbox, lease } = preparedClaimed()
    const outcome = await outbox.runClaimed(runInput(lease), completingPort())

    expect(outcome).toMatchObject({
      status: 'completed',
      candidateReview: 'required',
      canonicalPromotion: 'not-performed',
      effectAuthority: 'none',
      providerCostMicrousd: 7,
      providerCostState: 'known',
    })
    expect(outcome.candidateRefs).toHaveLength(1)
    expect(outbox.inspect().counts).toMatchObject({ completed: 1, executing: 0 })
    expect(JSON.stringify(outbox.inspect())).not.toContain('memory text')
  })

  it('provides exact scoped idempotency without merging tenants', () => {
    const outbox = createInMemoryMemoryOutbox()
    const first = outbox.prepare(prepareInput())
    expect(outbox.enqueue(first).status).toBe('enqueued')
    expect(outbox.enqueue(first).status).toBe('replayed')

    const conflict = outbox.prepare(prepareInput({
      job: { ...prepareInput().job as object, sourceRevision: 4 },
    }))
    expect(outbox.enqueue(conflict)).toMatchObject({
      status: 'rejected',
      reasonCode: 'envelope-identity-conflict',
    })

    const otherScope = { tenantId: 'tenant-002', namespace: 'semantic' }
    const scoped = outbox.prepare(prepareInput({
      job: { ...prepareInput().job as object, scope: otherScope },
    }))
    expect(outbox.enqueue(scoped).status).toBe('enqueued')
    expect(outbox.inspect().entries.map(entry => entry.scopeDigest)).toHaveLength(2)
  })

  it('rechecks exact admission references and never invokes a port on mismatch', async () => {
    const { outbox, lease } = preparedClaimed()
    const port = completingPort()
    const execute = vi.spyOn(port, 'execute')
    const outcome = await outbox.runClaimed({
      ...runInput(lease),
      policyRef: ref('wrong-policy', '9'),
    }, port)

    expect(outcome).toMatchObject({ status: 'rejected', reasonCode: 'admission-reference-mismatch' })
    expect(execute).not.toHaveBeenCalled()
    expect(outbox.inspect().counts.leased).toBe(1)
  })

  it('dead-letters denied admission without invoking consolidation', async () => {
    const { outbox, lease } = preparedClaimed()
    const execute = vi.fn()
    const port: MemoryConsolidationPort = {
      async admit(request) {
        const base = {
          schema: 'datazup.memory.worker-admission-result/v1' as const,
          status: 'denied' as const,
          reasonCode: 'policy-denied',
          checkedAt: request.checkedAt,
          requestDigest: request.requestDigest,
          dispatchAuthority: 'not-conveyed' as const,
        }
        return { ...base, resultDigest: digestWorkerValue(base) }
      },
      execute,
      reconcile: vi.fn(),
    }
    const outcome = await outbox.runClaimed(runInput(lease), port)

    expect(outcome).toMatchObject({ status: 'dead-lettered', reasonCode: 'admission-denied' })
    expect(execute).not.toHaveBeenCalled()
    expect(outbox.inspect().deadLetters).toHaveLength(1)
  })

  it('applies finite deterministic retry backoff and attempt fencing', async () => {
    const { outbox, lease } = preparedClaimed()
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'retryable'),
      reconcile: vi.fn(),
    }
    const outcome = await outbox.runClaimed(runInput(lease), port)

    expect(outcome).toMatchObject({
      status: 'retry-scheduled',
      attempt: 1,
      providerCostMicrousd: 7,
      providerCostState: 'known',
    })
    expect(outbox.inspect().entries[0]).toMatchObject({ state: 'pending', nextAvailableAt: T4 })
    expect(outbox.claim(claimInput(T3)).status).toBe('idle')
    expect(outbox.claim(claimInput(T4))).toMatchObject({ status: 'claimed', attempt: 2 })
  })

  it('permits only one invocation for a lease even under concurrent calls', async () => {
    const { outbox, lease } = preparedClaimed()
    let release!: (value: unknown) => void
    let executionRequest!: InternalMemoryWorkerExecutionRequestV1
    const execute = vi.fn((request: InternalMemoryWorkerExecutionRequestV1) => {
      executionRequest = request
      return new Promise(resolve => { release = resolve })
    })
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute,
      reconcile: vi.fn(),
    }
    const first = outbox.runClaimed(runInput(lease), port)
    const second = await outbox.runClaimed(runInput(lease), port)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    release(consolidationResult(executionRequest))

    expect(second).toMatchObject({ status: 'rejected', reasonCode: 'execution-already-started' })
    expect((await first).status).toBe('completed')
  })

  it('dead-letters only a proven not-applied terminal result and retains cumulative cost', async () => {
    const { outbox, lease } = preparedClaimed()
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'terminal'),
      reconcile: vi.fn(),
    }
    const outcome = await outbox.runClaimed(runInput(lease), port)

    expect(outcome).toMatchObject({
      status: 'dead-lettered',
      providerCostMicrousd: 7,
      providerCostState: 'known',
    })
  })

  it('uses caller timestamps and rejects unknown fields or content-bearing envelopes', () => {
    const outbox = createInMemoryMemoryOutbox()
    expect(() => outbox.prepare({ ...prepareInput(), content: 'memory text' })).toThrow(/unknown-field/)
    expect(() => outbox.prepare({
      ...prepareInput(),
      job: { ...prepareInput().job as object, requestedAt: 'not-a-time' },
    })).toThrow()
    expect(() => outbox.claim({ ...claimInput(), now: Date.now() })).toThrow(/unknown-field/)
  })

  it('binds scheduler, policy, budget, job, and envelope digests', () => {
    const outbox = createInMemoryMemoryOutbox()
    const envelope = outbox.prepare(prepareInput())
    expect(envelope).toMatchObject({ schedulerRef, policyRef, budgetRef })
    expect(envelope.jobDigest).toBe(digestWorkerValue(envelope.job))
    const { envelopeDigest, ...base } = envelope
    expect(envelopeDigest).toBe(digestWorkerValue(base))
    expect(envelope.job.scope).toEqual(scope)
  })
})
