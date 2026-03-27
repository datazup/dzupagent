import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createTemporalMeta,
  isActive,
  wasActiveAsOf,
  wasValidAt,
  filterByTemporal,
  TemporalMemoryService,
} from '../temporal.js'
import type { TemporalMetadata, TemporalQuery } from '../temporal.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(temporal?: TemporalMetadata | null): Record<string, unknown> {
  const rec: Record<string, unknown> = { text: 'test-data' }
  if (temporal !== null && temporal !== undefined) {
    rec['_temporal'] = temporal
  }
  return rec
}

function makeTemporal(overrides?: Partial<TemporalMetadata>): TemporalMetadata {
  return {
    systemCreatedAt: 1000,
    systemExpiredAt: null,
    validFrom: 1000,
    validUntil: null,
    ...overrides,
  }
}

function createMockMemoryService(): {
  svc: MemoryService
  putSpy: ReturnType<typeof vi.fn>
  getSpy: ReturnType<typeof vi.fn>
  searchSpy: ReturnType<typeof vi.fn>
} {
  const putSpy = vi.fn().mockResolvedValue(undefined)
  const getSpy = vi.fn().mockResolvedValue([])
  const searchSpy = vi.fn().mockResolvedValue([])

  const svc = {
    put: putSpy,
    get: getSpy,
    search: searchSpy,
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { svc, putSpy, getSpy, searchSpy }
}

// ---------------------------------------------------------------------------
// createTemporalMeta
// ---------------------------------------------------------------------------

describe('createTemporalMeta', () => {
  it('returns correct defaults with timestamps near Date.now()', () => {
    const before = Date.now()
    const meta = createTemporalMeta()
    const after = Date.now()

    expect(meta.systemCreatedAt).toBeGreaterThanOrEqual(before)
    expect(meta.systemCreatedAt).toBeLessThanOrEqual(after)
    expect(meta.validFrom).toBe(meta.systemCreatedAt)
    expect(meta.systemExpiredAt).toBeNull()
    expect(meta.validUntil).toBeNull()
  })

  it('uses provided validFrom while systemCreatedAt defaults to now', () => {
    const before = Date.now()
    const meta = createTemporalMeta(5000)
    const after = Date.now()

    expect(meta.validFrom).toBe(5000)
    expect(meta.systemCreatedAt).toBeGreaterThanOrEqual(before)
    expect(meta.systemCreatedAt).toBeLessThanOrEqual(after)
  })

  it('accepts validFrom = 0', () => {
    const meta = createTemporalMeta(0)
    expect(meta.validFrom).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// isActive
// ---------------------------------------------------------------------------

describe('isActive', () => {
  it('returns true when systemExpiredAt is null', () => {
    const rec = makeRecord(makeTemporal({ systemExpiredAt: null }))
    expect(isActive(rec)).toBe(true)
  })

  it('returns false when systemExpiredAt is set', () => {
    const rec = makeRecord(makeTemporal({ systemExpiredAt: 2000 }))
    expect(isActive(rec)).toBe(false)
  })

  it('returns true for records without _temporal (backward compat)', () => {
    const rec = makeRecord(null)
    expect(isActive(rec)).toBe(true)
  })

  it('returns true when _temporal is not an object', () => {
    const rec: Record<string, unknown> = { _temporal: 'invalid' }
    expect(isActive(rec)).toBe(true)
  })

  it('returns true when _temporal is structurally invalid (missing systemCreatedAt)', () => {
    const rec: Record<string, unknown> = { _temporal: { validFrom: 1000 } }
    expect(isActive(rec)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// wasActiveAsOf
// ---------------------------------------------------------------------------

describe('wasActiveAsOf', () => {
  it('returns true when queried after creation and before expiry', () => {
    const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: 3000 }))
    expect(wasActiveAsOf(rec, 2000)).toBe(true)
  })

  it('returns false when queried before creation', () => {
    const rec = makeRecord(makeTemporal({ systemCreatedAt: 2000 }))
    expect(wasActiveAsOf(rec, 1000)).toBe(false)
  })

  it('returns false when queried at or after expiry', () => {
    const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: 2000 }))
    expect(wasActiveAsOf(rec, 2000)).toBe(false)
    expect(wasActiveAsOf(rec, 3000)).toBe(false)
  })

  it('returns true when queried exactly at creation time', () => {
    const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: 3000 }))
    expect(wasActiveAsOf(rec, 1000)).toBe(true)
  })

  it('returns true when never expired and queried after creation', () => {
    const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: null }))
    expect(wasActiveAsOf(rec, 999999)).toBe(true)
  })

  it('returns true for records without _temporal (backward compat)', () => {
    expect(wasActiveAsOf({ text: 'no temporal' }, 1000)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// wasValidAt
// ---------------------------------------------------------------------------

describe('wasValidAt', () => {
  it('returns true when queried between validFrom and validUntil', () => {
    const rec = makeRecord(makeTemporal({ validFrom: 1000, validUntil: 3000 }))
    expect(wasValidAt(rec, 2000)).toBe(true)
  })

  it('returns false when queried before validFrom', () => {
    const rec = makeRecord(makeTemporal({ validFrom: 2000 }))
    expect(wasValidAt(rec, 1000)).toBe(false)
  })

  it('returns false when queried at or after validUntil', () => {
    const rec = makeRecord(makeTemporal({ validFrom: 1000, validUntil: 2000 }))
    expect(wasValidAt(rec, 2000)).toBe(false)
    expect(wasValidAt(rec, 3000)).toBe(false)
  })

  it('returns true when queried exactly at validFrom', () => {
    const rec = makeRecord(makeTemporal({ validFrom: 1000, validUntil: 3000 }))
    expect(wasValidAt(rec, 1000)).toBe(true)
  })

  it('returns true when validUntil is null (still valid)', () => {
    const rec = makeRecord(makeTemporal({ validFrom: 1000, validUntil: null }))
    expect(wasValidAt(rec, 999999)).toBe(true)
  })

  it('returns true for records without _temporal (backward compat)', () => {
    expect(wasValidAt({ text: 'no temporal' }, 1000)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// filterByTemporal
// ---------------------------------------------------------------------------

describe('filterByTemporal', () => {
  const active = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: null, validFrom: 1000, validUntil: null }))
  const expiredSystem = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: 2000, validFrom: 1000, validUntil: null }))
  const expiredValid = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: null, validFrom: 1000, validUntil: 2000 }))
  const noTemporal: Record<string, unknown> = { text: 'legacy' }

  const all = [active, expiredSystem, expiredValid, noTemporal]

  it('filters by asOf only', () => {
    const result = filterByTemporal(all, { asOf: 1500 })
    // active: created 1000, not expired -> pass
    // expiredSystem: created 1000, expired 2000 -> 1500 < 2000 -> pass
    // expiredValid: no system expiry check for asOf -> pass
    // noTemporal: backward compat -> pass
    expect(result).toHaveLength(4)
  })

  it('filters by asOf after system expiry', () => {
    const result = filterByTemporal(all, { asOf: 2500 })
    // expiredSystem: expired at 2000, 2500 >= 2000 -> filtered out
    expect(result).toHaveLength(3)
    expect(result).not.toContain(expiredSystem)
  })

  it('filters by validAt only', () => {
    const result = filterByTemporal(all, { validAt: 1500 })
    // active: validFrom 1000, no validUntil -> pass
    // expiredSystem: validFrom 1000, no validUntil -> pass
    // expiredValid: validFrom 1000, validUntil 2000 -> 1500 < 2000 -> pass
    // noTemporal: backward compat -> pass
    expect(result).toHaveLength(4)
  })

  it('filters by validAt after validUntil', () => {
    const result = filterByTemporal(all, { validAt: 2500 })
    // expiredValid: validUntil 2000, 2500 >= 2000 -> filtered out
    expect(result).toHaveLength(3)
    expect(result).not.toContain(expiredValid)
  })

  it('filters by both asOf and validAt', () => {
    const result = filterByTemporal(all, { asOf: 2500, validAt: 2500 })
    // expiredSystem filtered by asOf, expiredValid filtered by validAt
    expect(result).toHaveLength(2)
    expect(result).toContain(active)
    expect(result).toContain(noTemporal)
  })

  it('with empty query returns all records (no filtering)', () => {
    const result = filterByTemporal(all, {})
    expect(result).toHaveLength(4)
  })

  it('handles empty records array', () => {
    expect(filterByTemporal([], { asOf: 1000 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TemporalMemoryService
// ---------------------------------------------------------------------------

describe('TemporalMemoryService', () => {
  let mockMs: ReturnType<typeof createMockMemoryService>
  let sut: TemporalMemoryService

  beforeEach(() => {
    mockMs = createMockMemoryService()
    sut = new TemporalMemoryService(mockMs.svc)
  })

  const ns = 'facts'
  const scope = { projectId: 'p1' }

  // --- put ---

  describe('put', () => {
    it('stores value with _temporal metadata', async () => {
      await sut.put(ns, scope, 'key1', { text: 'hello' })

      expect(mockMs.putSpy).toHaveBeenCalledOnce()
      const [calledNs, calledScope, calledKey, calledValue] = mockMs.putSpy.mock.calls[0] as [string, Record<string, string>, string, Record<string, unknown>]
      expect(calledNs).toBe(ns)
      expect(calledScope).toBe(scope)
      expect(calledKey).toBe('key1')
      expect(calledValue['text']).toBe('hello')

      const temporal = calledValue['_temporal'] as TemporalMetadata
      expect(temporal.systemExpiredAt).toBeNull()
      expect(temporal.validUntil).toBeNull()
      expect(typeof temporal.systemCreatedAt).toBe('number')
      expect(typeof temporal.validFrom).toBe('number')
    })

    it('applies partial temporal overrides', async () => {
      await sut.put(ns, scope, 'key1', { text: 'hello' }, { validFrom: 5000 })

      const calledValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const temporal = calledValue['_temporal'] as TemporalMetadata
      expect(temporal.validFrom).toBe(5000)
    })

    it('swallows errors from inner.put (non-fatal)', async () => {
      mockMs.putSpy.mockRejectedValue(new Error('write failed'))
      // Should not throw
      await expect(sut.put(ns, scope, 'k', { text: 'x' })).resolves.toBeUndefined()
    })
  })

  // --- supersede ---

  describe('supersede', () => {
    it('expires old record and creates new one', async () => {
      const oldRecord: Record<string, unknown> = {
        text: 'old-fact',
        _temporal: makeTemporal({ systemCreatedAt: 1000 }),
      }
      mockMs.getSpy.mockResolvedValue([oldRecord])

      await sut.supersede(ns, scope, 'old-key', 'new-key', { text: 'new-fact' })

      // Two puts: one to expire old, one to create new
      expect(mockMs.putSpy).toHaveBeenCalledTimes(2)

      // First call: expire the old record
      const expiredValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const expiredTemporal = expiredValue['_temporal'] as TemporalMetadata
      expect(expiredTemporal.systemExpiredAt).toBeTypeOf('number')
      expect(expiredTemporal.validUntil).toBeTypeOf('number')
      expect(expiredTemporal.systemCreatedAt).toBe(1000)

      // Second call: create new record
      const newValue = mockMs.putSpy.mock.calls[1]![3] as Record<string, unknown>
      expect(newValue['text']).toBe('new-fact')
      const newTemporal = newValue['_temporal'] as TemporalMetadata
      expect(newTemporal.systemExpiredAt).toBeNull()
      expect(newTemporal.validUntil).toBeNull()
    })

    it('creates new record even if old key does not exist', async () => {
      mockMs.getSpy.mockResolvedValue([])

      await sut.supersede(ns, scope, 'missing', 'new-key', { text: 'new' })

      // Only the new record put, no expiry put
      expect(mockMs.putSpy).toHaveBeenCalledOnce()
      const newValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      expect(newValue['text']).toBe('new')
    })

    it('swallows errors (non-fatal)', async () => {
      mockMs.getSpy.mockRejectedValue(new Error('read failed'))
      await expect(sut.supersede(ns, scope, 'a', 'b', { text: 'x' })).resolves.toBeUndefined()
    })
  })

  // --- search ---

  describe('search', () => {
    it('default search returns only active records', async () => {
      const activeRec = makeRecord(makeTemporal({ systemExpiredAt: null }))
      const expiredRec = makeRecord(makeTemporal({ systemExpiredAt: 500 }))
      mockMs.searchSpy.mockResolvedValue([activeRec, expiredRec])

      const results = await sut.search(ns, scope, 'query')

      expect(results).toHaveLength(1)
      expect(results[0]).toBe(activeRec)
    })

    it('search with asOf temporal query filters by system time', async () => {
      const rec1 = makeRecord(makeTemporal({ systemCreatedAt: 100, systemExpiredAt: 200 }))
      const rec2 = makeRecord(makeTemporal({ systemCreatedAt: 100, systemExpiredAt: null }))
      mockMs.searchSpy.mockResolvedValue([rec1, rec2])

      // Query at time 150: rec1 not yet expired, rec2 active
      const results = await sut.search(ns, scope, 'q', 5, { asOf: 150 })
      expect(results).toHaveLength(2)

      // Query at time 250: rec1 expired
      const results2 = await sut.search(ns, scope, 'q', 5, { asOf: 250 })
      expect(results2).toHaveLength(1)
    })

    it('search with validAt filters by real-world time', async () => {
      const rec = makeRecord(makeTemporal({ validFrom: 100, validUntil: 200 }))
      mockMs.searchSpy.mockResolvedValue([rec])

      const results = await sut.search(ns, scope, 'q', 5, { validAt: 150 })
      expect(results).toHaveLength(1)

      const results2 = await sut.search(ns, scope, 'q', 5, { validAt: 250 })
      expect(results2).toHaveLength(0)
    })

    it('fetches 3x the limit for post-filtering headroom', async () => {
      mockMs.searchSpy.mockResolvedValue([])
      await sut.search(ns, scope, 'q', 4)
      expect(mockMs.searchSpy).toHaveBeenCalledWith(ns, scope, 'q', 12)
    })

    it('defaults to limit=5 when not provided', async () => {
      mockMs.searchSpy.mockResolvedValue([])
      await sut.search(ns, scope, 'q')
      expect(mockMs.searchSpy).toHaveBeenCalledWith(ns, scope, 'q', 15)
    })

    it('respects the limit on output', async () => {
      const records = Array.from({ length: 10 }, () =>
        makeRecord(makeTemporal({ systemExpiredAt: null })),
      )
      mockMs.searchSpy.mockResolvedValue(records)

      const results = await sut.search(ns, scope, 'q', 3)
      expect(results).toHaveLength(3)
    })

    it('returns empty on error (non-fatal)', async () => {
      mockMs.searchSpy.mockRejectedValue(new Error('search failed'))
      const results = await sut.search(ns, scope, 'q')
      expect(results).toEqual([])
    })

    it('treats records without _temporal as active in default search', async () => {
      const legacyRec: Record<string, unknown> = { text: 'legacy' }
      mockMs.searchSpy.mockResolvedValue([legacyRec])

      const results = await sut.search(ns, scope, 'q')
      expect(results).toHaveLength(1)
    })
  })

  // --- getActive ---

  describe('getActive', () => {
    it('returns only active records', async () => {
      const activeRec = makeRecord(makeTemporal({ systemExpiredAt: null }))
      const expiredRec = makeRecord(makeTemporal({ systemExpiredAt: 500 }))
      mockMs.getSpy.mockResolvedValue([activeRec, expiredRec])

      const results = await sut.getActive(ns, scope)
      expect(results).toHaveLength(1)
      expect(results[0]).toBe(activeRec)
    })

    it('includes records without _temporal (backward compat)', async () => {
      const legacy: Record<string, unknown> = { text: 'old' }
      mockMs.getSpy.mockResolvedValue([legacy])

      const results = await sut.getActive(ns, scope)
      expect(results).toHaveLength(1)
    })

    it('returns empty on error (non-fatal)', async () => {
      mockMs.getSpy.mockRejectedValue(new Error('get failed'))
      const results = await sut.getActive(ns, scope)
      expect(results).toEqual([])
    })
  })

  // --- getHistory ---

  describe('getHistory', () => {
    it('returns all versions sorted newest-first by systemCreatedAt', async () => {
      const v1 = makeRecord(makeTemporal({ systemCreatedAt: 1000, systemExpiredAt: 2000 }))
      const v2 = makeRecord(makeTemporal({ systemCreatedAt: 2000, systemExpiredAt: 3000 }))
      const v3 = makeRecord(makeTemporal({ systemCreatedAt: 3000, systemExpiredAt: null }))

      mockMs.getSpy.mockResolvedValue([v1, v2, v3])
      mockMs.searchSpy.mockResolvedValue([])

      const history = await sut.getHistory(ns, scope, 'some-key')
      expect(history).toHaveLength(3)
      // Newest first
      expect(history[0]).toBe(v3)
      expect(history[1]).toBe(v2)
      expect(history[2]).toBe(v1)
    })

    it('deduplicates records from get and search', async () => {
      const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000 }))
      // Same record returned from both get and search
      mockMs.getSpy.mockResolvedValue([rec])
      mockMs.searchSpy.mockResolvedValue([rec])

      const history = await sut.getHistory(ns, scope, 'key')
      expect(history).toHaveLength(1)
    })

    it('combines unique records from get and search', async () => {
      const fromGet = makeRecord(makeTemporal({ systemCreatedAt: 1000 }))
      const fromSearch = makeRecord(makeTemporal({ systemCreatedAt: 2000 }))
      // Different text so JSON.stringify dedup distinguishes them
      ;(fromGet as Record<string, unknown>)['id'] = 'a'
      ;(fromSearch as Record<string, unknown>)['id'] = 'b'

      mockMs.getSpy.mockResolvedValue([fromGet])
      mockMs.searchSpy.mockResolvedValue([fromSearch])

      const history = await sut.getHistory(ns, scope, 'key')
      expect(history).toHaveLength(2)
      // Newest first
      expect(history[0]).toBe(fromSearch)
    })

    it('places records without _temporal last (systemCreatedAt = 0)', async () => {
      const withTemporal = makeRecord(makeTemporal({ systemCreatedAt: 5000 }))
      const legacy: Record<string, unknown> = { text: 'legacy' }

      mockMs.getSpy.mockResolvedValue([legacy, withTemporal])
      mockMs.searchSpy.mockResolvedValue([])

      const history = await sut.getHistory(ns, scope, 'key')
      expect(history[0]).toBe(withTemporal)
      expect(history[1]).toBe(legacy)
    })

    it('returns empty on error (non-fatal)', async () => {
      mockMs.getSpy.mockRejectedValue(new Error('fail'))
      const results = await sut.getHistory(ns, scope, 'key')
      expect(results).toEqual([])
    })
  })

  // --- expire ---

  describe('expire', () => {
    it('sets systemExpiredAt and validUntil to now', async () => {
      const rec = makeRecord(makeTemporal({ systemCreatedAt: 1000 }))
      mockMs.getSpy.mockResolvedValue([rec])

      const before = Date.now()
      await sut.expire(ns, scope, 'key1')
      const after = Date.now()

      expect(mockMs.putSpy).toHaveBeenCalledOnce()
      const updatedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const temporal = updatedValue['_temporal'] as TemporalMetadata
      expect(temporal.systemExpiredAt).toBeGreaterThanOrEqual(before)
      expect(temporal.systemExpiredAt).toBeLessThanOrEqual(after)
      expect(temporal.validUntil).toBeGreaterThanOrEqual(before)
      expect(temporal.validUntil).toBeLessThanOrEqual(after)
      expect(temporal.systemCreatedAt).toBe(1000)
    })

    it('does nothing when record does not exist', async () => {
      mockMs.getSpy.mockResolvedValue([])
      await sut.expire(ns, scope, 'missing')
      expect(mockMs.putSpy).not.toHaveBeenCalled()
    })

    it('handles records without _temporal by creating fresh metadata', async () => {
      const legacy: Record<string, unknown> = { text: 'no temporal' }
      mockMs.getSpy.mockResolvedValue([legacy])

      await sut.expire(ns, scope, 'legacy-key')

      expect(mockMs.putSpy).toHaveBeenCalledOnce()
      const updatedValue = mockMs.putSpy.mock.calls[0]![3] as Record<string, unknown>
      const temporal = updatedValue['_temporal'] as TemporalMetadata
      expect(temporal.systemExpiredAt).toBeTypeOf('number')
      expect(temporal.validUntil).toBeTypeOf('number')
    })

    it('swallows errors (non-fatal)', async () => {
      mockMs.getSpy.mockRejectedValue(new Error('fail'))
      await expect(sut.expire(ns, scope, 'key')).resolves.toBeUndefined()
    })
  })
})
