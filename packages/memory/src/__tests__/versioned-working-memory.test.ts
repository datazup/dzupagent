import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { VersionedWorkingMemory } from '../versioned-working-memory.js'
import type { VersionedWorkingMemoryConfig, WorkingMemoryDiff } from '../versioned-working-memory.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TestSchema = z.object({
  stack: z.string().default(''),
  features: z.array(z.string()).default([]),
  count: z.number().default(0),
})

type TestState = z.infer<typeof TestSchema>

/**
 * In-memory mock of MemoryService that stores records in a Map
 * keyed by `${namespace}::${JSON.stringify(scope)}::${key}`.
 */
function createMockStore(): {
  service: MemoryService
  data: Map<string, Record<string, unknown>>
} {
  const data = new Map<string, Record<string, unknown>>()

  const makeKey = (ns: string, scope: Record<string, string>, key: string) =>
    `${ns}::${JSON.stringify(scope)}::${key}`

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        data.set(makeKey(ns, scope, key), structuredClone(value))
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        if (key) {
          const val = data.get(makeKey(ns, scope, key))
          return Promise.resolve(val ? [structuredClone(val)] : [])
        }
        // List all in namespace+scope prefix
        const prefix = `${ns}::${JSON.stringify(scope)}::`
        const results: Record<string, unknown>[] = []
        for (const [k, v] of data) {
          if (k.startsWith(prefix)) results.push(structuredClone(v))
        }
        return Promise.resolve(results)
      },
    ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, data }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }

function createVMem(
  overrides?: Partial<VersionedWorkingMemoryConfig<typeof TestSchema>>,
  store?: MemoryService,
) {
  const mock = store ?? createMockStore().service
  return new VersionedWorkingMemory({
    schema: TestSchema,
    store: mock,
    namespace: 'working',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VersionedWorkingMemory', () => {
  let mock: ReturnType<typeof createMockStore>
  let vmem: VersionedWorkingMemory<typeof TestSchema>

  beforeEach(() => {
    mock = createMockStore()
    vmem = new VersionedWorkingMemory({
      schema: TestSchema,
      store: mock.service,
      namespace: 'working',
    })
  })

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('initializes with schema defaults', () => {
      const state = vmem.get()
      expect(state).toEqual({ stack: '', features: [], count: 0 })
    })

    it('starts at version 0', () => {
      expect(vmem.currentVersion).toBe(0)
    })

    it('is not loaded and not dirty initially', () => {
      expect(vmem.isLoaded()).toBe(false)
      expect(vmem.isDirty()).toBe(false)
    })

    it('throws for schema with required fields and no defaults', () => {
      const RequiredSchema = z.object({ name: z.string() })
      const mem = new VersionedWorkingMemory({
        schema: RequiredSchema,
        store: mock.service,
        namespace: 'working',
      })
      expect(() => mem.get()).toThrow('not initialized')
    })
  })

  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------

  describe('load', () => {
    it('returns schema defaults when store is empty', async () => {
      const state = await vmem.load(SCOPE)
      expect(state).toEqual({ stack: '', features: [], count: 0 })
      expect(vmem.isLoaded()).toBe(true)
    })

    it('restores persisted state and version', async () => {
      // Pre-populate store with saved state
      await mock.service.put('working', SCOPE, 'working-state', {
        data: { stack: 'vue3', features: ['auth'], count: 5 },
        text: '{}',
        updatedAt: 1000,
        _versionMeta: { version: 3, minVersion: 0 },
      })

      const state = await vmem.load(SCOPE)
      expect(state.stack).toBe('vue3')
      expect(state.features).toEqual(['auth'])
      expect(state.count).toBe(5)
      expect(vmem.currentVersion).toBe(3)
    })

    it('keeps defaults if stored data is invalid', async () => {
      await mock.service.put('working', SCOPE, 'working-state', {
        data: 'not-an-object',
        text: '{}',
        updatedAt: 1000,
      })

      const state = await vmem.load(SCOPE)
      expect(state).toEqual({ stack: '', features: [], count: 0 })
    })
  })

  // -----------------------------------------------------------------------
  // Update + diff tracking
  // -----------------------------------------------------------------------

  describe('update', () => {
    beforeEach(async () => {
      await vmem.load(SCOPE)
    })

    it('updates state and increments version', async () => {
      const state = await vmem.update(SCOPE, { stack: 'react' })
      expect(state.stack).toBe('react')
      expect(vmem.currentVersion).toBe(1)
    })

    it('records diff in history namespace', async () => {
      await vmem.update(SCOPE, { stack: 'react' }, 'chose react')

      const history = await vmem.getHistory(SCOPE)
      expect(history).toHaveLength(1)
      expect(history[0].version).toBe(1)
      expect(history[0].reason).toBe('chose react')
      expect(history[0].changes).toContainEqual(
        expect.objectContaining({ path: 'stack', oldValue: '', newValue: 'react' }),
      )
    })

    it('stores snapshot alongside diff', async () => {
      await vmem.update(SCOPE, { stack: 'vue3' })
      const snapKey = `working-history::${JSON.stringify(SCOPE)}::snap-1`
      const snap = mock.data.get(snapKey)
      expect(snap).toBeDefined()
      expect((snap as Record<string, unknown>)['data']).toMatchObject({ stack: 'vue3' })
    })

    it('does not increment version if nothing changed', async () => {
      // State starts as { stack: '', features: [], count: 0 }
      await vmem.update(SCOPE, { stack: '' })
      expect(vmem.currentVersion).toBe(0)
    })

    it('tracks multiple updates sequentially', async () => {
      await vmem.update(SCOPE, { stack: 'vue3' }, 'step 1')
      await vmem.update(SCOPE, { count: 10 }, 'step 2')
      await vmem.update(SCOPE, { features: ['auth', 'billing'] }, 'step 3')

      expect(vmem.currentVersion).toBe(3)
      const history = await vmem.getHistory(SCOPE)
      expect(history).toHaveLength(3)
      // Most recent first
      expect(history[0].version).toBe(3)
      expect(history[2].version).toBe(1)
    })

    it('auto-saves by default', async () => {
      await vmem.update(SCOPE, { stack: 'vue3' })
      expect(vmem.isDirty()).toBe(false)
    })

    it('does not auto-save when disabled', async () => {
      const noAutoSave = new VersionedWorkingMemory({
        schema: TestSchema,
        store: mock.service,
        namespace: 'working',
        autoSave: false,
      })
      await noAutoSave.load(SCOPE)
      await noAutoSave.update(SCOPE, { stack: 'react' })
      expect(noAutoSave.isDirty()).toBe(true)

      await noAutoSave.save(SCOPE)
      expect(noAutoSave.isDirty()).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // getHistory
  // -----------------------------------------------------------------------

  describe('getHistory', () => {
    beforeEach(async () => {
      await vmem.load(SCOPE)
    })

    it('returns empty array when no updates have been made', async () => {
      const history = await vmem.getHistory(SCOPE)
      expect(history).toEqual([])
    })

    it('respects limit parameter', async () => {
      await vmem.update(SCOPE, { stack: 'a' })
      await vmem.update(SCOPE, { stack: 'b' })
      await vmem.update(SCOPE, { stack: 'c' })

      const history = await vmem.getHistory(SCOPE, 2)
      expect(history).toHaveLength(2)
      expect(history[0].version).toBe(3)
      expect(history[1].version).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // diff (between versions)
  // -----------------------------------------------------------------------

  describe('diff', () => {
    beforeEach(async () => {
      await vmem.load(SCOPE)
      await vmem.update(SCOPE, { stack: 'vue3' }, 'step 1')
      await vmem.update(SCOPE, { count: 5 }, 'step 2')
      await vmem.update(SCOPE, { features: ['auth'] }, 'step 3')
    })

    it('returns diffs between two versions', async () => {
      const diffs = await vmem.diff(SCOPE, 1, 3)
      expect(diffs).toHaveLength(2) // versions 2 and 3
      expect(diffs[0].version).toBe(2)
      expect(diffs[1].version).toBe(3)
    })

    it('returns empty when fromVersion equals toVersion', async () => {
      const diffs = await vmem.diff(SCOPE, 2, 2)
      expect(diffs).toEqual([])
    })

    it('throws when fromVersion > toVersion', async () => {
      await expect(vmem.diff(SCOPE, 3, 1)).rejects.toThrow('must be <=')
    })
  })

  // -----------------------------------------------------------------------
  // revertTo
  // -----------------------------------------------------------------------

  describe('revertTo', () => {
    beforeEach(async () => {
      await vmem.load(SCOPE)
      await vmem.update(SCOPE, { stack: 'vue3' }, 'step 1')
      await vmem.update(SCOPE, { count: 10 }, 'step 2')
      await vmem.update(SCOPE, { features: ['auth'] }, 'step 3')
    })

    it('reverts to a specific version snapshot', async () => {
      expect(vmem.currentVersion).toBe(3)

      const state = await vmem.revertTo(SCOPE, 1)
      expect(state.stack).toBe('vue3')
      expect(state.count).toBe(0) // was 0 at version 1
      expect(state.features).toEqual([]) // was [] at version 1
    })

    it('creates a new version for the revert', async () => {
      await vmem.revertTo(SCOPE, 1)
      expect(vmem.currentVersion).toBe(4) // 3 updates + 1 revert
    })

    it('throws for version out of range', async () => {
      await expect(vmem.revertTo(SCOPE, 999)).rejects.toThrow('Valid range')
    })

    it('throws for negative version below minVersion', async () => {
      await expect(vmem.revertTo(SCOPE, -1)).rejects.toThrow('Valid range')
    })

    it('reverts to version 0 (schema defaults)', async () => {
      const state = await vmem.revertTo(SCOPE, 0)
      expect(state).toEqual({ stack: '', features: [], count: 0 })
    })
  })

  // -----------------------------------------------------------------------
  // toPromptContext
  // -----------------------------------------------------------------------

  describe('toPromptContext', () => {
    it('includes version number in header', async () => {
      await vmem.load(SCOPE)
      await vmem.update(SCOPE, { stack: 'vue3' })
      const ctx = vmem.toPromptContext()
      expect(ctx).toContain('(v1)')
      expect(ctx).toContain('"stack": "vue3"')
    })

    it('returns empty string when state is null', () => {
      const RequiredSchema = z.object({ name: z.string() })
      const mem = new VersionedWorkingMemory({
        schema: RequiredSchema,
        store: mock.service,
        namespace: 'working',
      })
      expect(mem.toPromptContext()).toBe('')
    })

    it('accepts custom header', async () => {
      await vmem.load(SCOPE)
      const ctx = vmem.toPromptContext('## Custom')
      expect(ctx.startsWith('## Custom (v0)')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Pruning
  // -----------------------------------------------------------------------

  describe('pruning', () => {
    it('prunes history beyond maxHistory', async () => {
      const small = new VersionedWorkingMemory({
        schema: TestSchema,
        store: mock.service,
        namespace: 'working',
        maxHistory: 3,
      })
      await small.load(SCOPE)

      // Create 5 versions
      for (let i = 1; i <= 5; i++) {
        await small.update(SCOPE, { count: i }, `update ${i}`)
      }

      expect(small.currentVersion).toBe(5)

      // Only 3 most recent should be retrievable
      const history = await small.getHistory(SCOPE)
      expect(history).toHaveLength(3)
      expect(history[0].version).toBe(5)
      expect(history[2].version).toBe(3)
    })

    it('pruned entries are overwritten with tombstones', async () => {
      const small = new VersionedWorkingMemory({
        schema: TestSchema,
        store: mock.service,
        namespace: 'working',
        maxHistory: 2,
      })
      await small.load(SCOPE)

      await small.update(SCOPE, { count: 1 })
      await small.update(SCOPE, { count: 2 })
      await small.update(SCOPE, { count: 3 })

      // v-1 should be tombstoned
      const tombKey = `working-history::${JSON.stringify(SCOPE)}::v-1`
      const tomb = mock.data.get(tombKey)
      expect(tomb).toBeDefined()
      expect((tomb as Record<string, unknown>)['_pruned']).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Non-fatal history failures
  // -----------------------------------------------------------------------

  describe('non-fatal history', () => {
    it('update succeeds even if history write fails', async () => {
      const failStore = {
        put: vi.fn().mockImplementation(
          (ns: string, _scope: Record<string, string>, _key: string, _value: Record<string, unknown>) => {
            if (ns === 'working-history') {
              return Promise.reject(new Error('history write failed'))
            }
            return Promise.resolve()
          },
        ),
        get: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue([]),
        formatForPrompt: vi.fn().mockReturnValue(''),
      } as unknown as MemoryService

      const mem = new VersionedWorkingMemory({
        schema: TestSchema,
        store: failStore,
        namespace: 'working',
      })
      await mem.load(SCOPE)

      // Should not throw despite history write failure
      const state = await mem.update(SCOPE, { stack: 'vue3' })
      expect(state.stack).toBe('vue3')
    })
  })

  // -----------------------------------------------------------------------
  // historyNamespace config
  // -----------------------------------------------------------------------

  describe('custom historyNamespace', () => {
    it('uses custom history namespace', async () => {
      const mem = new VersionedWorkingMemory({
        schema: TestSchema,
        store: mock.service,
        namespace: 'working',
        historyNamespace: 'custom-hist',
      })
      await mem.load(SCOPE)
      await mem.update(SCOPE, { stack: 'vue3' })

      const histKey = `custom-hist::${JSON.stringify(SCOPE)}::v-1`
      expect(mock.data.has(histKey)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // save skips when not dirty
  // -----------------------------------------------------------------------

  describe('save', () => {
    it('skips write when not dirty', async () => {
      await vmem.load(SCOPE)
      const callsBefore = (mock.service.put as ReturnType<typeof vi.fn>).mock.calls.length
      await vmem.save(SCOPE)
      const callsAfter = (mock.service.put as ReturnType<typeof vi.fn>).mock.calls.length
      expect(callsAfter).toBe(callsBefore)
    })
  })
})
