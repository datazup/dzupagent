import { describe, expect, it, vi } from 'vitest'
import { calculateBackoff } from '../../utils/backoff.js'

describe('calculateBackoff', () => {
  it('returns initialBackoffMs for attempt=0 with no jitter', () => {
    expect(
      calculateBackoff(0, {
        initialBackoffMs: 500,
        maxBackoffMs: 10_000,
        multiplier: 2,
      }),
    ).toBe(500)
  })

  it('doubles each attempt until it hits the cap', () => {
    const config = { initialBackoffMs: 1_000, maxBackoffMs: 8_000, multiplier: 2 }
    expect(calculateBackoff(0, config)).toBe(1_000)
    expect(calculateBackoff(1, config)).toBe(2_000)
    expect(calculateBackoff(2, config)).toBe(4_000)
    expect(calculateBackoff(3, config)).toBe(8_000)
    // Capped:
    expect(calculateBackoff(4, config)).toBe(8_000)
    expect(calculateBackoff(10, config)).toBe(8_000)
  })

  it('applies equal-jitter (50%-100% of capped delay) when jitter=true', () => {
    // Stub Math.random so the jitter factor is deterministic.
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0) // jitter=0 -> 0.5×
    try {
      const low = calculateBackoff(2, {
        initialBackoffMs: 1_000,
        maxBackoffMs: 8_000,
        multiplier: 2,
        jitter: true,
      })
      // attempt=2 -> capped=4_000, 4_000 * 0.5 = 2_000
      expect(low).toBe(2_000)

      rng.mockReturnValue(1) // jitter=1 -> 1.0×
      const high = calculateBackoff(2, {
        initialBackoffMs: 1_000,
        maxBackoffMs: 8_000,
        multiplier: 2,
        jitter: true,
      })
      expect(high).toBe(4_000)
    } finally {
      rng.mockRestore()
    }
  })
})
