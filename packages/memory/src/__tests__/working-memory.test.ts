import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { WorkingMemory } from '../working-memory.js'
import type { MemoryService } from '../memory-service.js'

function createMockService(): {
  svc: MemoryService
  put: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
} {
  const put = vi.fn().mockResolvedValue(undefined)
  const get = vi.fn().mockResolvedValue([])
  const svc = {
    put,
    get,
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn(),
  } as unknown as MemoryService
  return { svc, put, get }
}

describe('WorkingMemory', () => {
  describe('constructor initialization', () => {
    it('derives defaults from schema when {} is valid', () => {
      const { svc } = createMockService()
      const schema = z.object({
        completedFeatures: z.array(z.string()).default([]),
        preferredStack: z.string().optional(),
      })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = m.get()
      expect(state.completedFeatures).toEqual([])
    })

    it('falls back to schema.parse(undefined) when {} fails but undefined works', () => {
      const { svc } = createMockService()
      // A schema that accepts undefined via default but not {}
      const schema = z.string().default('initial')
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      expect(m.get()).toBe('initial')
    })

    it('state = null when schema rejects both {} and undefined', () => {
      const { svc } = createMockService()
      const schema = z.object({ required: z.string() })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      expect(() => m.get()).toThrow(/not initialized/)
    })

    it('reports loaded=false and dirty=false initially', () => {
      const { svc } = createMockService()
      const schema = z.object({ count: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      expect(m.isLoaded()).toBe(false)
      expect(m.isDirty()).toBe(false)
    })
  })

  describe('load', () => {
    it('populates state from stored "data" field', async () => {
      const { svc, get } = createMockService()
      get.mockResolvedValueOnce([{ data: { count: 42 } }])
      const schema = z.object({ count: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = await m.load({ tenantId: 't1' })
      expect(state.count).toBe(42)
      expect(m.isLoaded()).toBe(true)
    })

    it('falls back to the raw record when "data" is absent', async () => {
      const { svc, get } = createMockService()
      get.mockResolvedValueOnce([{ count: 7 }])
      const schema = z.object({ count: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = await m.load({ tenantId: 't1' })
      expect(state.count).toBe(7)
    })

    it('keeps defaults when stored data fails schema validation', async () => {
      const { svc, get } = createMockService()
      get.mockResolvedValueOnce([{ data: { count: 'not a number' } }])
      const schema = z.object({ count: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = await m.load({ tenantId: 't1' })
      expect(state.count).toBe(0)
    })

    it('marks as loaded + not dirty', async () => {
      const { svc } = createMockService()
      const schema = z.object({ count: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      await m.load({ tenantId: 't1' })
      expect(m.isLoaded()).toBe(true)
      expect(m.isDirty()).toBe(false)
    })

    it('no records -> still loaded but defaults preserved', async () => {
      const { svc, get } = createMockService()
      get.mockResolvedValueOnce([])
      const schema = z.object({ count: z.number().default(5) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = await m.load({ tenantId: 't1' })
      expect(state.count).toBe(5)
    })
  })

  describe('update', () => {
    it('merges partial updates', async () => {
      const { svc } = createMockService()
      const schema = z.object({
        a: z.number().default(1),
        b: z.number().default(2),
      })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = await m.update({}, { b: 99 })
      expect(state.a).toBe(1)
      expect(state.b).toBe(99)
    })

    it('persists when autoSave is not false', async () => {
      const { svc, put } = createMockService()
      const schema = z.object({ n: z.number().default(0) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      await m.update({ tenantId: 't1' }, { n: 1 })
      expect(put).toHaveBeenCalled()
      expect(m.isDirty()).toBe(false)
    })

    it('does NOT persist when autoSave=false', async () => {
      const { svc, put } = createMockService()
      const schema = z.object({ n: z.number().default(0) })
      const m = new WorkingMemory({
        schema,
        store: svc,
        namespace: 'ns',
        autoSave: false,
      })
      await m.update({ tenantId: 't1' }, { n: 1 })
      expect(put).not.toHaveBeenCalled()
      expect(m.isDirty()).toBe(true)
    })

    it('throws on invalid partial update', async () => {
      const { svc } = createMockService()
      const schema = z.object({ n: z.number().default(0) })
      const m = new WorkingMemory({
        schema,
        store: svc,
        namespace: 'ns',
        autoSave: false,
      })
      await expect(
        m.update({}, { n: 'not a number' as unknown as number }),
      ).rejects.toThrow()
    })
  })

  describe('save', () => {
    it('is a no-op when not dirty', async () => {
      const { svc, put } = createMockService()
      const schema = z.object({ n: z.number().default(0) })
      const m = new WorkingMemory({
        schema,
        store: svc,
        namespace: 'ns',
        autoSave: false,
      })
      await m.save({})
      expect(put).not.toHaveBeenCalled()
    })

    it('writes and clears dirty flag', async () => {
      const { svc, put } = createMockService()
      const schema = z.object({ n: z.number().default(0) })
      const m = new WorkingMemory({
        schema,
        store: svc,
        namespace: 'ns',
        autoSave: false,
      })
      await m.update({}, { n: 5 })
      expect(m.isDirty()).toBe(true)
      await m.save({ tenantId: 't1' })
      expect(put).toHaveBeenCalledWith(
        'ns',
        { tenantId: 't1' },
        'working-state',
        expect.objectContaining({
          data: expect.objectContaining({ n: 5 }),
          text: expect.any(String),
          updatedAt: expect.any(Number),
        }),
      )
      expect(m.isDirty()).toBe(false)
    })
  })

  describe('toPromptContext', () => {
    it('returns empty string when state is null', () => {
      const { svc } = createMockService()
      const schema = z.object({ required: z.string() })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      expect(m.toPromptContext()).toBe('')
    })

    it('returns formatted markdown block', () => {
      const { svc } = createMockService()
      const schema = z.object({ a: z.number().default(1) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const out = m.toPromptContext()
      expect(out).toContain('## Working Memory')
      expect(out).toContain('```json')
      expect(out).toContain('"a": 1')
    })

    it('accepts a custom header', () => {
      const { svc } = createMockService()
      const schema = z.object({ a: z.number().default(1) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      expect(m.toPromptContext('### Custom')).toContain('### Custom')
    })
  })

  describe('get defensive clone', () => {
    it('mutations on returned state do not affect internal state', () => {
      const { svc } = createMockService()
      const schema = z.object({ items: z.array(z.string()).default([]) })
      const m = new WorkingMemory({ schema, store: svc, namespace: 'ns' })
      const state = m.get()
      state.items.push('mutated')
      const again = m.get()
      expect(again.items).toEqual([])
    })
  })
})
