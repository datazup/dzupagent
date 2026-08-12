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
  T20,
  admitted,
  claimInput,
  consolidationResult,
  prepareInput,
  reconcileInput,
  reconciliationResult,
  runInput,
} from './fixtures.js'

function preparedClaimed() {
  const outbox = createInMemoryMemoryOutbox()
  const envelope = outbox.prepare(prepareInput())
  outbox.enqueue(envelope)
  const lease = outbox.claim(claimInput()).lease!
  return { outbox, envelope, lease }
}

describe('ambiguous delivery reconciliation', () => {
  it('never blindly retries a timed-out consolidation', async () => {
    const { outbox, lease } = preparedClaimed()
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async () => await new Promise(() => undefined),
      reconcile: vi.fn(),
    }
    const outcome = await outbox.runClaimed({ ...runInput(lease), deadlineMs: 1 }, port)

    expect(outcome).toMatchObject({
      status: 'ambiguous',
      reasonCode: 'execution-timeout',
      providerCostMicrousd: 0,
      providerCostState: 'unknown',
    })
    expect(outbox.inspect().counts).toMatchObject({ ambiguous: 1, pending: 0 })
    expect(outbox.claim(claimInput(T3)).status).toBe('idle')
  })

  it('retries only after reconciliation proves the effect was not applied', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const ambiguousPort: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'ambiguous'),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed(runInput(lease), ambiguousPort)
    expect(ambiguous.status).toBe('ambiguous')

    const reconcilePort: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: vi.fn(),
      reconcile: async request => reconciliationResult(request, 'proven-not-applied'),
    }
    const reconciled = await outbox.reconcile(
      reconcileInput(envelope, ambiguous.generation),
      reconcilePort,
    )
    expect(reconciled).toMatchObject({
      status: 'retry-scheduled',
      reasonCode: 'reconciliation-proved-not-applied',
      providerCostMicrousd: 9,
      providerCostState: 'known',
    })
    expect(outbox.inspect().entries[0]).toMatchObject({ state: 'pending', nextAvailableAt: '2026-08-11T10:00:06.000Z' })
    expect(reconcilePort.execute).not.toHaveBeenCalled()
  })

  it('accepts proven completion as reviewed candidates without canonical promotion', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const firstPort: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'ambiguous'),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed(runInput(lease), firstPort)
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: vi.fn(),
      reconcile: async request => reconciliationResult(request, 'proven-complete'),
    }
    const outcome = await outbox.reconcile(
      reconcileInput(envelope, ambiguous.generation),
      port,
    )

    expect(outcome).toMatchObject({
      status: 'reconciled',
      candidateReview: 'required',
      canonicalPromotion: 'not-performed',
      effectAuthority: 'none',
      providerCostState: 'known',
    })
    expect(outbox.inspect().counts.completed).toBe(1)
  })

  it('generation-fences stale reconciliation requests', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const firstPort: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'ambiguous'),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed(runInput(lease), firstPort)
    const port: MemoryConsolidationPort = {
      admit: vi.fn(),
      execute: vi.fn(),
      reconcile: vi.fn(),
    }
    const outcome = await outbox.reconcile(
      reconcileInput(envelope, ambiguous.generation + 1),
      port,
    )

    expect(outcome).toMatchObject({ status: 'rejected', reasonCode: 'stale-generation' })
    expect(port.admit).not.toHaveBeenCalled()
    expect(outbox.inspect().counts.ambiguous).toBe(1)
  })

  it('discards a late result after lease expiry changes retained state', async () => {
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
    const pending = outbox.runClaimed(runInput(lease), port)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

    const expiry = outbox.claim(claimInput(T20, 'worker-002'))
    expect(expiry.status).toBe('ambiguous')
    release(consolidationResult(executionRequest, 'completed', T3))
    const late = await pending

    expect(late).toMatchObject({ status: 'rejected', reasonCode: 'stale-lease' })
    expect(outbox.inspect().counts).toMatchObject({ ambiguous: 1, completed: 0 })
  })

  it('keeps ambiguous state when reconciliation itself times out', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const initial: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async request => consolidationResult(request, 'ambiguous'),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed(runInput(lease), initial)
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: vi.fn(),
      reconcile: async () => await new Promise(() => undefined),
    }
    const outcome = await outbox.reconcile({
      ...reconcileInput(envelope, ambiguous.generation, T4),
      deadlineMs: 1,
    }, port)

    expect(outcome).toMatchObject({
      status: 'ambiguous',
      reasonCode: 'reconciliation-timeout',
      providerCostMicrousd: 0,
      providerCostState: 'unknown',
    })
    expect(outbox.inspect().counts).toMatchObject({ ambiguous: 1, pending: 0 })
  })

  it('preserves unknown cost when reconciliation admission is denied', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const initial: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async () => await new Promise(() => undefined),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed({ ...runInput(lease), deadlineMs: 1 }, initial)
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
      execute: vi.fn(),
      reconcile: vi.fn(),
    }
    const outcome = await outbox.reconcile(
      reconcileInput(envelope, ambiguous.generation, T4),
      port,
    )

    expect(outcome).toMatchObject({
      status: 'dead-lettered',
      providerCostMicrousd: 0,
      providerCostState: 'unknown',
    })
  })

  it('resolves unknown timeout cost only when reconciliation establishes a cumulative total', async () => {
    const { outbox, envelope, lease } = preparedClaimed()
    const initial: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: async () => await new Promise(() => undefined),
      reconcile: vi.fn(),
    }
    const ambiguous = await outbox.runClaimed({ ...runInput(lease), deadlineMs: 1 }, initial)
    const port: MemoryConsolidationPort = {
      admit: async request => admitted(request),
      execute: vi.fn(),
      reconcile: async request => reconciliationResult(request, 'proven-complete'),
    }
    const outcome = await outbox.reconcile(
      reconcileInput(envelope, ambiguous.generation, T4),
      port,
    )

    expect(outcome).toMatchObject({
      status: 'reconciled',
      providerCostMicrousd: 9,
      providerCostState: 'known',
    })
  })
})
