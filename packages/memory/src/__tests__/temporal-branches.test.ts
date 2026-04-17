import { describe, it, expect, vi } from 'vitest'
import {
  isActive,
  wasActiveAsOf,
  wasValidAt,
  filterByTemporal,
  createTemporalMeta,
  TemporalMemoryService,
} from '../temporal.js'
import type { MemoryService } from '../memory-service.js'
import type { TemporalMetadata } from '../temporal.js'

function withMeta(meta: Partial<TemporalMetadata> | null): Record<string, unknown> {
  if (meta === null) return { text: 'x' }
  const full: TemporalMetadata = {
    systemCreatedAt: 1000,
    systemExpiredAt: null,
    validFrom: 1000,
    validUntil: null,
    ...meta,
  }
  return { text: 'x', _temporal: full }
}

describe('temporal — branch edges', () => {
  describe('isActive / wasActiveAsOf / wasValidAt — missing or malformed meta', () => {
    it('isActive returns true when meta is missing', () => {
      expect(isActive({ text: 'no meta' })).toBe(true)
    })

    it('isActive returns true when _temporal is not an object', () => {
      expect(isActive({ _temporal: 'not-an-object' })).toBe(true)
    })

    it('isActive returns true when systemCreatedAt is not a number', () => {
      expect(isActive({ _temporal: { systemCreatedAt: 'nope', validFrom: 1 } })).toBe(true)
    })

    it('isActive returns true when validFrom is not a number', () => {
      expect(isActive({ _temporal: { systemCreatedAt: 1, validFrom: 'nope' } })).toBe(true)
    })

    it('wasActiveAsOf returns false when asOf < systemCreatedAt', () => {
      const rec = withMeta({ systemCreatedAt: 2000 })
      expect(wasActiveAsOf(rec, 1000)).toBe(false)
    })

    it('wasActiveAsOf returns false when systemExpiredAt <= asOf', () => {
      const rec = withMeta({ systemCreatedAt: 500, systemExpiredAt: 1000 })
      expect(wasActiveAsOf(rec, 1000)).toBe(false)
      expect(wasActiveAsOf(rec, 1500)).toBe(false)
    })

    it('wasActiveAsOf returns true when asOf within active window', () => {
      const rec = withMeta({ systemCreatedAt: 500, systemExpiredAt: null })
      expect(wasActiveAsOf(rec, 1500)).toBe(true)
    })

    it('wasActiveAsOf defaults true when no temporal meta present', () => {
      expect(wasActiveAsOf({ text: 'hi' }, 1000)).toBe(true)
    })

    it('wasValidAt defaults true when no temporal meta', () => {
      expect(wasValidAt({ text: 'hi' }, 1000)).toBe(true)
    })

    it('wasValidAt returns false when validAt < validFrom', () => {
      const rec = withMeta({ validFrom: 2000 })
      expect(wasValidAt(rec, 1000)).toBe(false)
    })

    it('wasValidAt returns false when validUntil <= validAt', () => {
      const rec = withMeta({ validFrom: 500, validUntil: 1000 })
      expect(wasValidAt(rec, 1000)).toBe(false)
    })

    it('wasValidAt returns true when validUntil is null (still valid)', () => {
      const rec = withMeta({ validFrom: 0, validUntil: null })
      expect(wasValidAt(rec, 99999999)).toBe(true)
    })
  })

  describe('filterByTemporal', () => {
    it('asOf filter drops records with future systemCreatedAt', () => {
      const recs = [
        withMeta({ systemCreatedAt: 500 }),
        withMeta({ systemCreatedAt: 2000 }),
      ]
      const filtered = filterByTemporal(recs, { asOf: 1000 })
      expect(filtered).toHaveLength(1)
    })

    it('validAt filter drops records invalid at that time', () => {
      const recs = [
        withMeta({ validFrom: 500, validUntil: null }),
        withMeta({ validFrom: 500, validUntil: 800 }),
      ]
      const filtered = filterByTemporal(recs, { validAt: 1000 })
      expect(filtered).toHaveLength(1)
    })

    it('combines asOf and validAt filters (AND)', () => {
      const recs = [
        withMeta({ systemCreatedAt: 500, validFrom: 500 }),
        withMeta({ systemCreatedAt: 2000, validFrom: 500 }),
        withMeta({ systemCreatedAt: 500, validFrom: 2000 }),
      ]
      const filtered = filterByTemporal(recs, { asOf: 1000, validAt: 1000 })
      expect(filtered).toHaveLength(1)
    })

    it('empty query returns all records', () => {
      const recs = [withMeta({}), withMeta({ validFrom: 9000 })]
      const filtered = filterByTemporal(recs, {})
      expect(filtered).toHaveLength(2)
    })
  })

  describe('createTemporalMeta', () => {
    it('uses provided validFrom', () => {
      const meta = createTemporalMeta(12345)
      expect(meta.validFrom).toBe(12345)
    })

    it('defaults validFrom to now when not provided', () => {
      const before = Date.now()
      const meta = createTemporalMeta()
      const after = Date.now()
      expect(meta.validFrom).toBeGreaterThanOrEqual(before)
      expect(meta.validFrom).toBeLessThanOrEqual(after)
    })
  })

  describe('TemporalMemoryService — error paths and branches', () => {
    function makeInner(overrides: Partial<MemoryService> = {}) {
      return {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue([]),
        formatForPrompt: vi.fn(),
        ...overrides,
      } as unknown as MemoryService
    }

    it('put merges provided temporal meta with defaults', async () => {
      const inner = makeInner()
      const svc = new TemporalMemoryService(inner)
      await svc.put('ns', { x: 'y' }, 'k', { text: 'hi' }, { validFrom: 500 })
      const call = (inner.put as ReturnType<typeof vi.fn>).mock.calls[0]
      const enriched = call![3] as Record<string, unknown>
      const t = enriched['_temporal'] as TemporalMetadata
      expect(t.validFrom).toBe(500)
      expect(t.systemExpiredAt).toBeNull()
    })

    it('put swallows errors', async () => {
      const inner = makeInner({
        put: vi.fn().mockRejectedValue(new Error('boom')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await expect(svc.put('ns', {}, 'k', { text: 'hi' })).resolves.toBeUndefined()
    })

    it('supersede skips expire step if no existing record', async () => {
      const inner = makeInner({ get: vi.fn().mockResolvedValue([]) } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await svc.supersede('ns', {}, 'old', 'new', { text: 'v' })
      // Only the new record is written
      expect((inner.put as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    })

    it('supersede expires existing and writes new', async () => {
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([withMeta({})]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await svc.supersede('ns', {}, 'old', 'new', { text: 'fresh' })
      expect((inner.put as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
    })

    it('supersede with no previous temporal meta still expires old record', async () => {
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([{ text: 'no-meta' }]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await svc.supersede('ns', {}, 'old', 'new', { text: 'fresh' })
      const firstCall = (inner.put as ReturnType<typeof vi.fn>).mock.calls[0]
      const oldRec = firstCall![3] as Record<string, unknown>
      expect((oldRec['_temporal'] as TemporalMetadata).systemExpiredAt).not.toBeNull()
    })

    it('supersede swallows errors', async () => {
      const inner = makeInner({
        get: vi.fn().mockRejectedValue(new Error('x')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await expect(svc.supersede('ns', {}, 'o', 'n', {})).resolves.toBeUndefined()
    })

    it('search applies temporal filter when provided', async () => {
      const inner = makeInner({
        search: vi.fn().mockResolvedValue([
          withMeta({ systemCreatedAt: 500 }),
          withMeta({ systemCreatedAt: 5000 }),
        ]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      const results = await svc.search('ns', {}, 'q', 5, { asOf: 1000 })
      expect(results).toHaveLength(1)
    })

    it('search default-filters out expired records when no temporal query', async () => {
      const inner = makeInner({
        search: vi.fn().mockResolvedValue([
          withMeta({ systemExpiredAt: 999 }),
          withMeta({ systemExpiredAt: null }),
        ]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      const results = await svc.search('ns', {}, 'q', 5)
      expect(results).toHaveLength(1)
    })

    it('search returns [] on inner error', async () => {
      const inner = makeInner({
        search: vi.fn().mockRejectedValue(new Error('boom')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      const r = await svc.search('ns', {}, 'q')
      expect(r).toEqual([])
    })

    it('getActive filters expired records', async () => {
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([
          withMeta({ systemExpiredAt: 100 }),
          withMeta({ systemExpiredAt: null }),
        ]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      const r = await svc.getActive('ns', {})
      expect(r).toHaveLength(1)
    })

    it('getActive returns [] on error', async () => {
      const inner = makeInner({
        get: vi.fn().mockRejectedValue(new Error('x')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      expect(await svc.getActive('ns', {})).toEqual([])
    })

    it('getHistory sorts newest-first and dedupes', async () => {
      const older = withMeta({ systemCreatedAt: 100 })
      const newer = withMeta({ systemCreatedAt: 500 })
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([older, newer]),
        search: vi.fn().mockResolvedValue([newer]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      const history = await svc.getHistory('ns', {}, 'k')
      expect(history).toHaveLength(2)
      const first = history[0]!['_temporal'] as TemporalMetadata
      expect(first.systemCreatedAt).toBe(500)
    })

    it('getHistory returns [] on error', async () => {
      const inner = makeInner({
        get: vi.fn().mockRejectedValue(new Error('x')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      expect(await svc.getHistory('ns', {}, 'k')).toEqual([])
    })

    it('expire no-ops when record missing', async () => {
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await svc.expire('ns', {}, 'k')
      expect((inner.put as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    })

    it('expire updates existing record', async () => {
      const inner = makeInner({
        get: vi.fn().mockResolvedValue([withMeta({ validFrom: 100 })]),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await svc.expire('ns', {}, 'k')
      const putCall = (inner.put as ReturnType<typeof vi.fn>).mock.calls[0]
      const rec = putCall![3] as Record<string, unknown>
      const t = rec['_temporal'] as TemporalMetadata
      expect(t.systemExpiredAt).not.toBeNull()
      expect(t.validUntil).not.toBeNull()
    })

    it('expire swallows errors', async () => {
      const inner = makeInner({
        get: vi.fn().mockRejectedValue(new Error('x')),
      } as Partial<MemoryService>)
      const svc = new TemporalMemoryService(inner)
      await expect(svc.expire('ns', {}, 'k')).resolves.toBeUndefined()
    })
  })
})
