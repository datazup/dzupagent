import { describe, expect, it } from 'vitest'
import type { ItemBudgetLifecycleDeps } from '../loop-executor/for-each-item-budget-release.js'
import type { LoopBudgetReconcileOutcome } from '../loop-executor/types.js'
import { admitPredicateIteration, releasePredicateIteration, settlePredicateIteration, deriveIterationReservationId } from '../loop-executor/predicate-loop-economics.js'

const loopNode: ItemBudgetLifecycleDeps['loopNode'] = { id: 'loop', type: 'loop', bodyNodeIds: [], maxIterations: 1, continuePredicateName: 'fixture', typedWhile: { conditionSchema: 'dzupagent.flowTypedCondition/v1', condition: {}, onExhausted: 'fail', iterationBudgetCents: 10 } }
const input: Parameters<typeof admitPredicateIteration>[0] = { loopNode, bodyNodes: [], state: {}, resume: undefined, iteration: 1, completedIterations: 0, bodyComplete: false }
const held = { iteration: 1, reservationId: deriveIterationReservationId({ loopNodeId: 'loop', iteration: 1 }), reservedCostCents: 10 }

describe('predicate loop budget restore', () => {
  it('refuses contradictory retained ownership, charges and outcomes', async () => {
    for (const economics of [{ ...held, reservationId: 'foreign' }, { ...held, reservedCostCents: -1 }, { ...held, reservedCostCents: 11 }, { ...held, settledCostCents: -1 }, { ...held, settledCostCents: 1.5 }]) {
      expect((await admitPredicateIteration({ ...input, retainedOutcome: 'reserved', retainedEconomics: economics })).status).toBe('blocked')
    }
    for (const outcome of ['failed', 'cancelled', 'denied', 'completed'] as const) expect((await admitPredicateIteration({ ...input, retainedOutcome: outcome, retainedEconomics: held })).status).toBe('blocked')
    expect((await admitPredicateIteration({ ...input, retainedEconomics: held })).status).toBe('blocked')
    expect((await admitPredicateIteration({ ...input, retainedOutcome: 'reserved' })).status).toBe('blocked')
  })

  it('blocks admission, settlement and release on non-authoritative host reconciliations', async () => {
    const reconciliations: LoopBudgetReconcileOutcome[] = [{ status: 'unknown' }, { status: 'conflict', heldBy: 'foreign' }, { status: 'released' }, { status: 'absent' }, { status: 'reserved', reservedCostCents: 11 }, { status: 'settled', cost: { status: 'unknown' } }, { status: 'settled', cost: { status: 'known', costCents: -1 } }, { status: 'settled', cost: { status: 'known', costCents: 5 } }]
    for (const reconciliation of reconciliations) {
      const resume = { reconcileIterationBudget: async () => reconciliation }
      expect((await admitPredicateIteration({ ...input, resume, retainedOutcome: 'reserved', retainedEconomics: held })).status).toBe('blocked')
      const fresh = await admitPredicateIteration({ ...input, resume: { ...resume, reserveIterationBudget: async () => ({ status: 'unknown' as const }) } })
      expect(fresh.status).toBe('blocked')
      const uncertain = { ...resume, measureItemCost: async () => ({ status: 'known' as const, costCents: 5 }), settleIterationBudget: async () => { throw new Error('uncertain') }, releaseIterationBudget: async () => { throw new Error('uncertain') } }
      const settlement = await settlePredicateIteration({ loopNode, resume: uncertain, completedIterations: 0, held, bodyResults: {} })
      if (reconciliation.status === 'settled' && reconciliation.cost.status === 'known' && reconciliation.cost.costCents >= 0) expect(settlement).toMatchObject({ status: 'settled', settledCostCents: reconciliation.cost.costCents })
      else expect(settlement.status).toBe('blocked')
      const release = await releasePredicateIteration({ loopNode, resume: uncertain, completedIterations: 0, held, outcome: 'failed', reason: 'failed' })
      expect(release.status).toBe(['absent', 'released'].includes(reconciliation.status) ? 'released' : 'blocked')
    }
  })

  it('retries release and settlement exactly once while the reservation is still held', async () => {
    const stillHeld: LoopBudgetReconcileOutcome = { status: 'reserved', reservedCostCents: 10 }
    for (const retrySucceeds of [true, false]) {
      let releaseAttempts = 0
      let settleAttempts = 0
      const resume = { reconcileIterationBudget: async () => stillHeld, measureItemCost: async () => ({ status: 'known' as const, costCents: 5 }), releaseIterationBudget: async () => { if (++releaseAttempts === 1 || !retrySucceeds) throw 'uncertain' }, settleIterationBudget: async () => { if (++settleAttempts === 1 || !retrySucceeds) throw 'uncertain' } }
      expect((await releasePredicateIteration({ loopNode, resume, completedIterations: 0, held, outcome: 'failed', reason: 'failed' })).status).toBe(retrySucceeds ? 'released' : 'blocked')
      expect((await settlePredicateIteration({ loopNode, resume, completedIterations: 0, held, bodyResults: {} })).status).toBe(retrySucceeds ? 'settled' : 'blocked')
      expect([releaseAttempts, settleAttempts]).toEqual([2, 2])
    }
  })

  it('blocks on host transport failures during reservation and release', async () => {
    for (const thrown of [new Error('transport'), 'transport']) {
      expect((await admitPredicateIteration({ ...input, resume: { reserveIterationBudget: async () => { throw thrown }, reconcileIterationBudget: async () => { throw thrown } } })).status).toBe('blocked')
      const release = await releasePredicateIteration({ loopNode, resume: { releaseIterationBudget: async () => { throw thrown }, reconcileIterationBudget: async () => { throw thrown } }, held, completedIterations: 0, outcome: 'failed', reason: 'failed' })
      expect(release.status).toBe('blocked')
    }
  })

  it('blocks settlement when the measured cost is unknown or not a non-negative integer', async () => {
    for (const cost of [{ status: 'unknown' as const }, { status: 'known' as const, costCents: -1 }, { status: 'known' as const, costCents: 1.5 }]) {
      const result = await settlePredicateIteration({ loopNode, resume: { measureItemCost: async () => cost }, held, completedIterations: 0, bodyResults: {} })
      expect(result.status).toBe('blocked')
    }
  })
})
