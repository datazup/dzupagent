import { describe, it, expect, vi } from 'vitest'
import { waitForCondition } from '../test-helpers.js'

describe('waitForCondition', () => {
  it('resolves immediately when predicate is already true', async () => {
    const predicate = vi.fn(() => true)

    await expect(waitForCondition(predicate, { timeoutMs: 50, intervalMs: 5 })).resolves.toBeUndefined()
    expect(predicate).toHaveBeenCalledTimes(1)
  })

  it('supports async predicates and polls until true', async () => {
    let attempts = 0

    await expect(waitForCondition(async () => {
      attempts++
      await Promise.resolve()
      return attempts >= 3
    }, { timeoutMs: 200, intervalMs: 5 })).resolves.toBeUndefined()

    expect(attempts).toBeGreaterThanOrEqual(3)
  })

  it('throws configured timeout message when condition is never met', async () => {
    await expect(waitForCondition(
      () => false,
      {
        timeoutMs: 30,
        intervalMs: 5,
        description: 'custom timeout',
      },
    )).rejects.toThrow('custom timeout')
  })
})
