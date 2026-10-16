import { describe, expect, it } from 'vitest'
import { createReleaseAndReconcile, type ItemBudgetLifecycleDeps } from '../loop-executor/for-each-item-budget-release.js'
import type { LoopBudgetReconcileOutcome } from '../loop-executor/types.js'

const held = { itemIndex: 0, attempt: 1, reservationId: 'fixture', reservedCostCents: 10 }
const deps: ItemBudgetLifecycleDeps = { loopNode: { id: 'loop', type: 'loop', bodyNodeIds: [], maxIterations: 1, continuePredicateName: 'fixture' }, bodyNodes: [], itemBudgetCents: 10, resume: undefined }

describe('for-each item budget release and reconciliation', () => {
  it('blocks reconciliation when the host has no budget lifecycle', async () => {
    const absentHost = createReleaseAndReconcile(deps)
    expect(await absentHost.releaseItem(undefined, 'failed')).toBeUndefined()
    expect(await absentHost.reconcileUnknownReservation(0, 0, 'transport', 'reserve')).toMatchObject({ status: 'blocked' })
  })

  it('preserves unknown outcomes and only retries an authoritatively retained reservation', async () => {
    const outcomes: LoopBudgetReconcileOutcome[] = [{ status: 'unknown' }, { status: 'conflict', heldBy: 'another-writer' }, { status: 'absent' }, { status: 'released' }, { status: 'reserved', reservedCostCents: 11 }, { status: 'reserved', reservedCostCents: 10 }, { status: 'settled', cost: { status: 'unknown' } }, { status: 'settled', cost: { status: 'known', costCents: -1 } }, { status: 'settled', cost: { status: 'known', costCents: 5 } }, { status: 'settled', cost: { status: 'known', costCents: 11 } }]
    for (const outcome of outcomes) {
      let released = 0
      let settled = 0
      const lifecycle = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { released++ }, settleIterationBudget: async () => { settled++ }, reconcileIterationBudget: async () => outcome } })
      const release = await lifecycle.resolveUnknownRelease(held, 'aborted', 'transport')
      const settlement = await lifecycle.resolveUnknownSettlement(held, 5, 'transport')
      if (outcome.status === 'absent' || outcome.status === 'released') {
        expect(release.status).toBe('released')
        expect(settlement.status).toBe('blocked')
      } else if (outcome.status === 'reserved' && outcome.reservedCostCents === 10) {
        expect(release.status).toBe('released')
        expect(settlement.status).toBe('settled')
        expect([released, settled]).toEqual([1, 1])
      } else if (outcome.status === 'settled' && outcome.cost.status === 'known' && outcome.cost.costCents >= 0) {
        expect(release.status).toBe('settled')
        expect(settlement).toMatchObject({ status: 'settled', settledCostCents: outcome.cost.costCents })
        if (outcome.cost.costCents > 10) expect(settlement).toHaveProperty('overrun')
      } else {
        expect(release.status).toBe('blocked')
        expect(settlement.status).toBe('blocked')
      }
      if (outcome.status !== 'reserved' || outcome.reservedCostCents !== 10) expect([released, settled]).toEqual([0, 0])
    }
  })

  it('reports host transport failures as an unknown outcome and blocks recovery', async () => {
    for (const thrown of [new Error('fixture transport'), 'fixture transport']) {
      const lifecycle = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { throw thrown }, settleIterationBudget: async () => { throw thrown }, reconcileIterationBudget: async () => { throw thrown } } })
      expect(await lifecycle.releaseItem(held, 'failed')).toEqual({ outcomeUnknown: 'fixture transport' })
      expect(await lifecycle.resolveUnknownRelease(held, 'failed', 'transport')).toMatchObject({ status: 'blocked' })
    }
  })

  it('blocks when the retry against a retained reservation is itself uncertain', async () => {
    const retrying = createReleaseAndReconcile({ ...deps, resume: { releaseIterationBudget: async () => { throw new Error('uncertain') }, settleIterationBudget: async () => { throw new Error('uncertain') }, reconcileIterationBudget: async () => ({ status: 'reserved', reservedCostCents: 10 }) } })
    expect(await retrying.resolveUnknownRelease(held, 'failed', 'transport')).toMatchObject({ status: 'blocked' })
    expect(await retrying.resolveUnknownSettlement(held, 5, 'transport')).toMatchObject({ status: 'blocked' })
  })
})
