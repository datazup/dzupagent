import { describe, expect, it, vi } from 'vitest'
import {
  calculateBackoff,
  type BackoffConfig,
} from '../../utils/backoff.js'

describe('calculateBackoff', () => {
  const baseConfig = {
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    multiplier: 2,
  }

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
    expect(calculateBackoff(0, baseConfig)).toBe(1_000)
    expect(calculateBackoff(1, baseConfig)).toBe(2_000)
    expect(calculateBackoff(2, baseConfig)).toBe(4_000)
    expect(calculateBackoff(3, baseConfig)).toBe(8_000)
    // Capped:
    expect(calculateBackoff(4, baseConfig)).toBe(8_000)
    expect(calculateBackoff(10, baseConfig)).toBe(8_000)
    expect(calculateBackoff(Number.MAX_SAFE_INTEGER, baseConfig)).toBe(8_000)
  })

  it('saturates overflow at the configured cap', () => {
    expect(
      calculateBackoff(Number.MAX_SAFE_INTEGER, {
        initialBackoffMs: Number.MAX_VALUE,
        maxBackoffMs: 30_000,
        multiplier: Number.MAX_VALUE,
      }),
    ).toBe(30_000)
  })

  it('keeps a zero initial delay at zero when exponentiation overflows', () => {
    const result = calculateBackoff(Number.MAX_SAFE_INTEGER, {
      initialBackoffMs: 0,
      maxBackoffMs: 30_000,
      multiplier: Number.MAX_VALUE,
    })

    expect(result).toBe(0)
    expect(Number.isNaN(result)).toBe(false)
  })

  it('supports zero, decaying, constant, and growing multipliers', () => {
    expect(calculateBackoff(0, { ...baseConfig, multiplier: 0 })).toBe(1_000)
    expect(calculateBackoff(1, { ...baseConfig, multiplier: 0 })).toBe(0)
    expect(calculateBackoff(3, { ...baseConfig, multiplier: 0.5 })).toBe(125)
    expect(calculateBackoff(3, { ...baseConfig, multiplier: 1 })).toBe(1_000)
    expect(calculateBackoff(3, { ...baseConfig, multiplier: 1.5 })).toBe(3_375)
  })

  it('allows arithmetic underflow to a bounded zero delay', () => {
    expect(
      calculateBackoff(Number.MAX_SAFE_INTEGER, {
        initialBackoffMs: Number.MIN_VALUE,
        maxBackoffMs: 1,
        multiplier: 0.5,
      }),
    ).toBe(0)
  })

  it('handles zero maxima and initial delays greater than the cap', () => {
    expect(calculateBackoff(0, { ...baseConfig, maxBackoffMs: 0 })).toBe(0)
    expect(
      calculateBackoff(0, {
        initialBackoffMs: 10_000,
        maxBackoffMs: 250,
        multiplier: 2,
      }),
    ).toBe(250)
  })

  it('preserves finite fractional values', () => {
    expect(
      calculateBackoff(2, {
        initialBackoffMs: 0.5,
        maxBackoffMs: 10.25,
        multiplier: 1.5,
      }),
    ).toBe(1.125)
  })

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid attempt %s with a stable bounded diagnostic', (attempt) => {
    const invoke = (): number => calculateBackoff(attempt, baseConfig)

    expect(invoke).toThrowError(RangeError)
    expect(invoke).toThrowError('attempt must be a non-negative safe integer')
    try {
      invoke()
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(128)
    }
  })

  it.each([
    ['initialBackoffMs', -1],
    ['initialBackoffMs', Number.NaN],
    ['initialBackoffMs', Number.POSITIVE_INFINITY],
    ['maxBackoffMs', -1],
    ['maxBackoffMs', Number.NaN],
    ['maxBackoffMs', Number.NEGATIVE_INFINITY],
    ['multiplier', -1],
    ['multiplier', Number.NaN],
    ['multiplier', Number.POSITIVE_INFINITY],
  ] as const)('rejects invalid %s value %s synchronously', (field, value) => {
    const config = { ...baseConfig, [field]: value }
    const invoke = (): number => calculateBackoff(0, config)

    expect(invoke).toThrowError(RangeError)
    expect(invoke).toThrowError(`${field} must be a finite non-negative number`)
  })

  it('rejects a missing runtime config with a stable diagnostic', () => {
    const invoke = (): number =>
      calculateBackoff(0, null as unknown as BackoffConfig)

    expect(invoke).toThrowError(TypeError)
    expect(invoke).toThrowError('config must be an object')
  })

  it('normalizes accepted negative zero fields to a positive zero result', () => {
    const result = calculateBackoff(1, {
      initialBackoffMs: -0,
      maxBackoffMs: -0,
      multiplier: -0,
    })

    expect(Object.is(result, 0)).toBe(true)
  })

  it.each([
    [0, 2_000],
    [0.25, 2_500],
    [1, 4_000],
  ] as const)(
    'applies equal jitter for accepted sample %s',
    (sample, expected) => {
      expect(
        calculateBackoff(2, {
          ...baseConfig,
          jitter: true,
          random: () => sample,
        }),
      ).toBe(expected)
    },
  )

  it('does not call the random source when jitter is disabled', () => {
    const random = vi.fn(() => 0.5)

    expect(calculateBackoff(2, { ...baseConfig, random })).toBe(4_000)
    expect(random).not.toHaveBeenCalled()
  })

  it('calls the random source exactly once when jitter is enabled', () => {
    const random = vi.fn(() => 0.5)

    expect(
      calculateBackoff(2, { ...baseConfig, jitter: true, random }),
    ).toBe(3_000)
    expect(random).toHaveBeenCalledTimes(1)
  })

  it('retains Math.random as the compatibility default', () => {
    const result = calculateBackoff(2, { ...baseConfig, jitter: true })

    expect(result).toBeGreaterThanOrEqual(2_000)
    expect(result).toBeLessThanOrEqual(4_000)
  })

  it.each([
    -Number.EPSILON,
    1 + Number.EPSILON,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects invalid random sample %s', (sample) => {
    const invoke = (): number =>
      calculateBackoff(2, {
        ...baseConfig,
        jitter: true,
        random: () => sample,
      })

    expect(invoke).toThrowError(RangeError)
    expect(invoke).toThrowError(
      'random must return a finite number in the inclusive range [0, 1]',
    )
  })

  it('propagates a throwing random source without wrapping it', () => {
    const failure = new Error('deterministic random failure')

    expect(() =>
      calculateBackoff(2, {
        ...baseConfig,
        jitter: true,
        random: () => {
          throw failure
        },
      }),
    ).toThrow(failure)
  })

  it('rejects a non-function random source only when jitter is enabled', () => {
    const config = {
      ...baseConfig,
      random: 0.5 as unknown as () => number,
    }

    expect(calculateBackoff(2, config)).toBe(4_000)
    expect(() => calculateBackoff(2, { ...config, jitter: true })).toThrowError(
      'random must be a function when jitter is enabled',
    )
  })
})
