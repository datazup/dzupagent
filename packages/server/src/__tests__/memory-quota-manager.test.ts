import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryQuotaManager } from '../runtime/memory-quota-manager.js'
import { QuotaExceededError } from '../runtime/resource-quota.js'

describe('InMemoryQuotaManager.reserve()', () => {
  let manager: InMemoryQuotaManager

  beforeEach(() => {
    manager = new InMemoryQuotaManager()
  })

  it('succeeds when under quota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 5 })

    const reservation = await manager.reserve('t1', 'concurrentRuns', 3)

    expect(reservation).toBeDefined()
    expect(reservation.tenantId).toBe('t1')
    expect(reservation.dimension).toBe('concurrentRuns')
    expect(reservation.amount).toBe(3)
    expect(reservation.released).toBe(false)
  })

  it('throws QuotaExceededError when over quota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 2 })

    await expect(
      manager.reserve('t1', 'concurrentRuns', 5),
    ).rejects.toThrow(QuotaExceededError)
  })

  it('throws QuotaExceededError when cumulative reservations exceed quota', async () => {
    await manager.setQuota('t1', { concurrentRuns: 3 })

    // First reservation takes 2
    await manager.reserve('t1', 'concurrentRuns', 2)

    // Second reservation of 2 would push total to 4, exceeding limit of 3
    await expect(
      manager.reserve('t1', 'concurrentRuns', 2),
    ).rejects.toThrow(QuotaExceededError)
  })

  it('respects released reservations (released space is available)', async () => {
    await manager.setQuota('t1', { concurrentRuns: 3 })

    const res1 = await manager.reserve('t1', 'concurrentRuns', 2)
    await manager.release(res1.id)

    // After releasing, the 2 units are free again — reserving 3 should work
    const res2 = await manager.reserve('t1', 'concurrentRuns', 3)
    expect(res2).toBeDefined()
    expect(res2.amount).toBe(3)
  })

  it('sequential reservations that cumulatively exceed quota — second must throw', async () => {
    await manager.setQuota('t1', { concurrentRuns: 3 })

    // First reservation takes 2 of 3
    const res1 = await manager.reserve('t1', 'concurrentRuns', 2)
    expect(res1).toBeDefined()

    // Second reservation of 2 would push total to 4, exceeding limit of 3
    await expect(
      manager.reserve('t1', 'concurrentRuns', 2),
    ).rejects.toThrow(QuotaExceededError)

    // But reserving just 1 more (total=3) should succeed
    const res2 = await manager.reserve('t1', 'concurrentRuns', 1)
    expect(res2).toBeDefined()
  })

  it('succeeds without any quota set (unlimited)', async () => {
    // No setQuota call — tenant has no limits
    const reservation = await manager.reserve('t1', 'concurrentRuns', 1000)

    expect(reservation).toBeDefined()
    expect(reservation.amount).toBe(1000)
  })

  it('succeeds on a dimension without a limit', async () => {
    // Set quota only for concurrentRuns, not tokensPerMinute
    await manager.setQuota('t1', { concurrentRuns: 5 })

    const reservation = await manager.reserve('t1', 'tokensPerMinute', 999999)

    expect(reservation).toBeDefined()
    expect(reservation.dimension).toBe('tokensPerMinute')
    expect(reservation.amount).toBe(999999)
  })
})
