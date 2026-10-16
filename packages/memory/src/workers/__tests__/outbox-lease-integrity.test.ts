import { test, expect } from 'vitest'
import { createInMemoryMemoryOutbox } from '../../workers/in-memory-outbox.js'
import { claimInput, prepareInput, runInput, completingPort, ref, T0, T2, T20 } from '../../workers/__tests__/fixtures.js'
import { sealMemoryWorkerLeaseV1 } from '../../workers/validation-contracts.js'
import { decodeMemoryConsolidationResultV1, decodeMemoryReconciliationResultV1 } from '../../workers/validation-results.js'
import { digestWorkerValue } from '../../workers/snapshot.js'

test('outbox renewal supersedes old generations and fails closed at expiry or before acquisition', () => {
  const outbox = createInMemoryMemoryOutbox()
  outbox.enqueue(outbox.prepare(prepareInput()))
  const lease = outbox.claim(claimInput()).lease!
  const renew = (renewedAt: string) => outbox.renew({ schema: 'datazup.memory.outbox-renew/v1', lease, renewedAt, extendByMs: 5000 })
  expect(renew(T0).reasonCode).toBe('renewal-precedes-lease')
  const next = renew(T2)
  expect(next.lease!.generation).toBe(lease.generation + 1)
  expect(renew(T2).status).toBe('rejected')
  expect(outbox.renew({ schema: 'datazup.memory.outbox-renew/v1', lease: next.lease, renewedAt: T20, extendByMs: 5000 }).reasonCode).toBe('lease-expired-before-renewal')
})

test('outbox restore rejects stale leases, contradictory terminal states and reordered identities', async () => {
  const outbox = createInMemoryMemoryOutbox()
  outbox.enqueue(outbox.prepare(prepareInput()))
  const pending = outbox.exportState()
  const lease = outbox.claim(claimInput()).lease!
  const leased = outbox.exportState()
  await outbox.runClaimed(runInput(lease), completingPort())
  const completed = outbox.exportState()
  for (const seed of [pending, leased, completed]) {
    expect(createInMemoryMemoryOutbox({ seed }).exportState()).toEqual(seed)
    for (const state of ['executing', 'reconciling', 'ambiguous', 'dead-lettered']) {
      const invalid = structuredClone(seed)
      Object.assign(invalid.entries[0]!, { state })
      expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
    }
    for (const change of [{ attempt: 99 }, { generation: 99 }, { nextAvailableAt: '2026-08-01T00:00:00.000Z' }, { nextAvailableAt: '2027-08-01T00:00:00.000Z' }]) {
      const invalid = structuredClone(seed)
      Object.assign(invalid.entries[0]!, change)
      expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
    }
    expect(() => createInMemoryMemoryOutbox({ seed: { ...seed, entries: [...seed.entries, seed.entries[0]] } })).toThrow()
    expect(() => createInMemoryMemoryOutbox({ seed: { ...seed, revision: seed.revision + 1 } })).toThrow()
  }
  for (const change of [{ envelopeId: 'foreign' }, { envelopeDigest: `sha256:${'a'.repeat(64)}` }, { attempt: 2 }, { generation: 2 }]) {
    const { leaseDigest: _digest, ...base } = lease
    const changed = sealMemoryWorkerLeaseV1({ ...base, ...change } as typeof base)
    const invalid = structuredClone(leased)
    Object.assign(invalid.entries[0]!, { lease: changed })
    expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
  }
  for (const state of ['pending', 'leased', 'ambiguous', 'dead-lettered']) {
    const invalid = structuredClone(completed)
    Object.assign(invalid.entries[0]!, { state })
    expect(() => createInMemoryMemoryOutbox({ seed: invalid })).toThrow()
  }
})

test('provider and reconciliation results cannot assert an effect that contradicts their terminal status', () => {
  const requestDigest = `sha256:${'a'.repeat(64)}` as const
  const seal = (base: Record<string, unknown>) => ({ ...base, resultDigest: digestWorkerValue(base) })
  for (const status of ['completed', 'partial', 'retryable', 'terminal', 'ambiguous'] as const) {
    const base = { schema: 'datazup.memory.consolidation-result/v1', status, reasonCode: 'fixture', finishedAt: T2, requestDigest, candidateRefs: status === 'completed' || status === 'partial' ? [ref('candidate')] : [], ...(status === 'ambiguous' ? { reconciliationRef: ref('reconcile') } : {}), providerCostMicrousd: 0, effectState: status === 'ambiguous' ? 'unknown' : status === 'completed' || status === 'partial' ? 'applied' : 'not-applied' }
    expect(decodeMemoryConsolidationResultV1(seal(base), requestDigest, 1).status).toBe(status)
    for (const effectState of ['applied', 'not-applied', 'unknown']) if (effectState !== base.effectState) expect(() => decodeMemoryConsolidationResultV1(seal({ ...base, effectState }), requestDigest, 1)).toThrow()
    expect(() => decodeMemoryConsolidationResultV1(seal({ ...base, requestDigest: `sha256:${'b'.repeat(64)}` }), requestDigest, 1)).toThrow()
  }
  for (const status of ['proven-complete', 'proven-not-applied', 'ambiguous'] as const) {
    const base = { schema: 'datazup.memory.reconciliation-result/v1', status, reasonCode: 'fixture', finishedAt: T2, requestDigest, candidateRefs: status === 'proven-complete' ? [ref('candidate')] : [], ...(status === 'ambiguous' ? { reconciliationRef: ref('reconcile') } : {}), providerCostMicrousd: 0, effectState: status === 'ambiguous' ? 'unknown' : status === 'proven-complete' ? 'applied' : 'not-applied' }
    expect(decodeMemoryReconciliationResultV1(seal(base), requestDigest, 1).status).toBe(status)
    for (const effectState of ['applied', 'not-applied', 'unknown']) if (effectState !== base.effectState) expect(() => decodeMemoryReconciliationResultV1(seal({ ...base, effectState }), requestDigest, 1)).toThrow()
    expect(() => decodeMemoryReconciliationResultV1(seal({ ...base, requestDigest: `sha256:${'b'.repeat(64)}` }), requestDigest, 1)).toThrow()
  }
})
