import { describe, it, expect } from 'vitest'
import { applyHubDampening, getAccessCount } from '../retrieval/hub-dampening.js'
import type { HubDampeningConfig } from '../retrieval/hub-dampening.js'

function makeResult(key: string, score: number, value: Record<string, unknown> = {}) {
  return { key, score, value }
}

describe('getAccessCount', () => {
  it('reads from _decay.accessCount', () => {
    expect(getAccessCount({ _decay: { accessCount: 5 } })).toBe(5)
  })

  it('reads from _accessCount when no _decay', () => {
    expect(getAccessCount({ _accessCount: 3 })).toBe(3)
  })

  it('prefers _decay.accessCount over _accessCount', () => {
    expect(getAccessCount({ _decay: { accessCount: 7 }, _accessCount: 3 })).toBe(7)
  })

  it('returns 0 when neither field exists', () => {
    expect(getAccessCount({})).toBe(0)
  })

  it('returns 0 for negative _accessCount', () => {
    expect(getAccessCount({ _accessCount: -1 })).toBe(0)
  })

  it('returns 0 when _decay is not an object', () => {
    expect(getAccessCount({ _decay: 'invalid' })).toBe(0)
  })

  it('returns 0 when _decay.accessCount is not a number', () => {
    expect(getAccessCount({ _decay: { accessCount: 'five' } })).toBe(0)
  })

  it('falls back to _accessCount when _decay.accessCount is invalid', () => {
    expect(getAccessCount({ _decay: { accessCount: 'bad' }, _accessCount: 4 })).toBe(4)
  })
})

describe('applyHubDampening', () => {
  it('applies no dampening for 0-access memories (default config)', () => {
    const results = [makeResult('a', 1.0)]
    const dampened = applyHubDampening(results)
    // log2(2 + 0) = log2(2) = 1.0
    expect(dampened[0].score).toBeCloseTo(1.0, 5)
    expect(dampened[0].dampeningFactor).toBeCloseTo(1.0, 5)
    expect(dampened[0].originalScore).toBe(1.0)
    expect(dampened[0].accessCount).toBe(0)
  })

  it('dampens 1-access memory correctly', () => {
    const results = [makeResult('a', 1.0, { _decay: { accessCount: 1 } })]
    const dampened = applyHubDampening(results)
    // log2(2 + 1) = log2(3) ~ 1.585
    expect(dampened[0].dampeningFactor).toBeCloseTo(Math.log2(3), 3)
    expect(dampened[0].score).toBeCloseTo(1.0 / Math.log2(3), 3)
  })

  it('dampens 5-access memory correctly', () => {
    const results = [makeResult('a', 1.0, { _accessCount: 5 })]
    const dampened = applyHubDampening(results)
    // log2(2 + 5) = log2(7) ~ 2.807
    expect(dampened[0].dampeningFactor).toBeCloseTo(Math.log2(7), 3)
    expect(dampened[0].score).toBeCloseTo(1.0 / Math.log2(7), 3)
  })

  it('dampens 10-access memory correctly', () => {
    const results = [makeResult('a', 1.0, { _decay: { accessCount: 10 } })]
    const dampened = applyHubDampening(results)
    // log2(12) ~ 3.585
    expect(dampened[0].dampeningFactor).toBeCloseTo(Math.log2(12), 3)
    expect(dampened[0].score).toBeCloseTo(1.0 / Math.log2(12), 3)
  })

  it('dampens 50-access memory correctly', () => {
    const results = [makeResult('a', 1.0, { _decay: { accessCount: 50 } })]
    const dampened = applyHubDampening(results)
    // log2(52) ~ 5.700
    expect(dampened[0].dampeningFactor).toBeCloseTo(Math.log2(52), 3)
    expect(dampened[0].score).toBeCloseTo(1.0 / Math.log2(52), 3)
  })

  it('preserves original score and value in output', () => {
    const value = { text: 'hello', _accessCount: 3 }
    const results = [makeResult('k1', 0.9, value)]
    const dampened = applyHubDampening(results)
    expect(dampened[0].originalScore).toBe(0.9)
    expect(dampened[0].key).toBe('k1')
    expect(dampened[0].value).toBe(value)
  })

  it('handles multiple results and preserves input order', () => {
    const results = [
      makeResult('low', 0.5, { _accessCount: 0 }),
      makeResult('high', 0.9, { _accessCount: 50 }),
    ]
    const dampened = applyHubDampening(results)
    expect(dampened).toHaveLength(2)
    // low: 0.5 / 1.0 = 0.5
    expect(dampened[0].score).toBeCloseTo(0.5, 5)
    // high: 0.9 / log2(52) ~ 0.158
    expect(dampened[1].score).toBeCloseTo(0.9 / Math.log2(52), 3)
  })

  it('dampened scores can re-order results (hub node drops below less-accessed node)', () => {
    // 'hub' has higher raw score but very high access count
    // 'fresh' has lower raw score but zero accesses
    const results = [
      makeResult('hub', 0.8, { _accessCount: 50 }),
      makeResult('fresh', 0.5, { _accessCount: 0 }),
    ]
    const dampened = applyHubDampening(results)
    // hub: 0.8 / log2(52) ~ 0.140
    // fresh: 0.5 / 1.0 = 0.5
    expect(dampened[0].score).toBeLessThan(dampened[1].score)
    // Caller can re-sort by dampened score:
    const sorted = [...dampened].sort((a, b) => b.score - a.score)
    expect(sorted[0].key).toBe('fresh')
    expect(sorted[1].key).toBe('hub')
  })

  it('returns empty array for empty input', () => {
    expect(applyHubDampening([])).toEqual([])
  })

  describe('config: minAccessCount', () => {
    it('skips dampening when accessCount < minAccessCount', () => {
      const cfg: HubDampeningConfig = { minAccessCount: 5 }
      const results = [makeResult('a', 1.0, { _accessCount: 3 })]
      const dampened = applyHubDampening(results, cfg)
      expect(dampened[0].score).toBe(1.0)
      expect(dampened[0].dampeningFactor).toBe(1)
    })

    it('applies dampening when accessCount >= minAccessCount', () => {
      const cfg: HubDampeningConfig = { minAccessCount: 5 }
      const results = [makeResult('a', 1.0, { _accessCount: 5 })]
      const dampened = applyHubDampening(results, cfg)
      expect(dampened[0].dampeningFactor).toBeCloseTo(Math.log2(7), 3)
    })
  })

  describe('config: custom logBase and offset', () => {
    it('uses custom logBase', () => {
      const cfg: HubDampeningConfig = { logBase: 10 }
      const results = [makeResult('a', 1.0, { _accessCount: 8 })]
      const dampened = applyHubDampening(results, cfg)
      // log10(2 + 8) = log10(10) = 1.0
      expect(dampened[0].dampeningFactor).toBeCloseTo(1.0, 5)
      expect(dampened[0].score).toBeCloseTo(1.0, 5)
    })

    it('uses custom offset', () => {
      const cfg: HubDampeningConfig = { offset: 4 }
      const results = [makeResult('a', 1.0, { _accessCount: 0 })]
      const dampened = applyHubDampening(results, cfg)
      // log2(4 + 0) = log2(4) = 2.0
      expect(dampened[0].dampeningFactor).toBeCloseTo(2.0, 5)
      expect(dampened[0].score).toBeCloseTo(0.5, 5)
    })
  })
})
