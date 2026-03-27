import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TenantScopedStore } from '../tenant-scoped-store.js'
import type { BaseStore } from '@langchain/langgraph'

// ---------------------------------------------------------------------------
// Mock store factory (same pattern as lesson-pipeline.test.ts)
// ---------------------------------------------------------------------------

function createMockStore() {
  // Composite key: "ns-joined|key" → value
  const data = new Map<string, Record<string, unknown>>()

  function compositeKey(ns: string[], key: string): string {
    return `${ns.join('/')}|${key}`
  }

  const store = {
    put: vi.fn().mockImplementation((ns: string[], key: string, value: Record<string, unknown>) => {
      data.set(compositeKey(ns, key), value)
      return Promise.resolve()
    }),
    get: vi.fn().mockImplementation((ns: string[], key: string) => {
      const ck = compositeKey(ns, key)
      const value = data.get(ck)
      return Promise.resolve(value ? { key, value } : undefined)
    }),
    delete: vi.fn().mockImplementation((ns: string[], key: string) => {
      data.delete(compositeKey(ns, key))
      return Promise.resolve()
    }),
    search: vi.fn().mockImplementation((ns: string[], opts?: { query?: string; limit?: number }) => {
      const prefix = ns.join('/') + '|'
      const items: Array<{ key: string; value: Record<string, unknown>; namespace: string[] }> = []
      for (const [ck, value] of data.entries()) {
        if (ck.startsWith(prefix)) {
          const key = ck.slice(prefix.length)
          items.push({ key, value, namespace: ns })
        }
      }
      return Promise.resolve(items.slice(0, opts?.limit ?? items.length))
    }),
    list: vi.fn().mockImplementation((ns: string[]) => {
      const prefix = ns.join('/') + '|'
      const keys: string[] = []
      for (const ck of data.keys()) {
        if (ck.startsWith(prefix)) {
          keys.push(ck.slice(prefix.length))
        }
      }
      return Promise.resolve(keys)
    }),
    _data: data,
  }

  return store as unknown as BaseStore & {
    _data: Map<string, Record<string, unknown>>
    put: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TenantScopedStore', () => {
  let underlying: ReturnType<typeof createMockStore>
  let scopedA: TenantScopedStore
  let scopedB: TenantScopedStore

  beforeEach(() => {
    underlying = createMockStore()
    scopedA = new TenantScopedStore({ store: underlying, tenantId: 'tenant-a' })
    scopedB = new TenantScopedStore({ store: underlying, tenantId: 'tenant-b' })
  })

  // ---- Getters -------------------------------------------------------------

  describe('getters', () => {
    it('should return tenantId', () => {
      expect(scopedA.tenantId).toBe('tenant-a')
      expect(scopedB.tenantId).toBe('tenant-b')
    })

    it('should return namespacePrefix for tenant-only config', () => {
      expect(scopedA.namespacePrefix).toEqual(['tenant-a'])
    })

    it('should return namespacePrefix with projectId', () => {
      const scoped = new TenantScopedStore({
        store: underlying,
        tenantId: 'tenant-x',
        projectId: 'proj-1',
      })
      expect(scoped.namespacePrefix).toEqual(['tenant-x', 'proj-1'])
    })

    it('should return a copy from namespacePrefix (not mutable reference)', () => {
      const prefix = scopedA.namespacePrefix
      prefix.push('mutated')
      expect(scopedA.namespacePrefix).toEqual(['tenant-a'])
    })

    it('should return the underlying store via unwrapped', () => {
      expect(scopedA.unwrapped).toBe(underlying)
    })
  })

  // ---- put / get -----------------------------------------------------------

  describe('put and get', () => {
    it('should store with tenant prefix and retrieve correctly', async () => {
      await scopedA.put(['lessons'], 'lesson-1', { summary: 'test lesson' })

      // Verify underlying store was called with prefixed namespace
      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a', 'lessons'],
        'lesson-1',
        { summary: 'test lesson' },
      )

      // Should be retrievable via the scoped store
      const result = await scopedA.get(['lessons'], 'lesson-1')
      expect(result).toEqual({ summary: 'test lesson' })
    })

    it('should return undefined for non-existent key', async () => {
      const result = await scopedA.get(['lessons'], 'nonexistent')
      expect(result).toBeUndefined()
    })

    it('should work with empty namespace', async () => {
      await scopedA.put([], 'root-key', { data: 'root' })

      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a'],
        'root-key',
        { data: 'root' },
      )

      const result = await scopedA.get([], 'root-key')
      expect(result).toEqual({ data: 'root' })
    })

    it('should work with deeply nested namespace', async () => {
      await scopedA.put(['a', 'b', 'c'], 'deep-key', { deep: true })

      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a', 'a', 'b', 'c'],
        'deep-key',
        { deep: true },
      )
    })
  })

  // ---- Tenant isolation ----------------------------------------------------

  describe('tenant isolation', () => {
    it('should isolate data between tenants on the same underlying store', async () => {
      await scopedA.put(['lessons'], 'shared-key', { tenant: 'A' })
      await scopedB.put(['lessons'], 'shared-key', { tenant: 'B' })

      const resultA = await scopedA.get(['lessons'], 'shared-key')
      const resultB = await scopedB.get(['lessons'], 'shared-key')

      expect(resultA).toEqual({ tenant: 'A' })
      expect(resultB).toEqual({ tenant: 'B' })
    })

    it('should not see other tenant data in search', async () => {
      await scopedA.put(['rules'], 'rule-1', { content: 'A rule' })
      await scopedA.put(['rules'], 'rule-2', { content: 'Another A rule' })
      await scopedB.put(['rules'], 'rule-1', { content: 'B rule' })

      const searchA = await scopedA.search(['rules'])
      const searchB = await scopedB.search(['rules'])

      expect(searchA).toHaveLength(2)
      expect(searchB).toHaveLength(1)
      expect(searchA.every(r => (r.value as Record<string, unknown>)['content']?.toString().includes('A'))).toBe(true)
      expect(searchB[0]!.value['content']).toBe('B rule')
    })

    it('should not see other tenant data in list', async () => {
      await scopedA.put(['skills'], 'skill-1', { name: 'A skill' })
      await scopedA.put(['skills'], 'skill-2', { name: 'Another A skill' })
      await scopedB.put(['skills'], 'skill-1', { name: 'B skill' })

      const listA = await scopedA.list(['skills'])
      const listB = await scopedB.list(['skills'])

      expect(listA).toHaveLength(2)
      expect(listA).toContain('skill-1')
      expect(listA).toContain('skill-2')
      expect(listB).toHaveLength(1)
      expect(listB).toContain('skill-1')
    })
  })

  // ---- delete --------------------------------------------------------------

  describe('delete', () => {
    it('should delete with tenant prefix', async () => {
      await scopedA.put(['lessons'], 'to-delete', { data: 'temp' })
      expect(await scopedA.get(['lessons'], 'to-delete')).toBeDefined()

      await scopedA.delete(['lessons'], 'to-delete')

      expect(underlying.delete).toHaveBeenCalledWith(
        ['tenant-a', 'lessons'],
        'to-delete',
      )
      expect(await scopedA.get(['lessons'], 'to-delete')).toBeUndefined()
    })

    it('should not affect other tenant data when deleting', async () => {
      await scopedA.put(['lessons'], 'key', { tenant: 'A' })
      await scopedB.put(['lessons'], 'key', { tenant: 'B' })

      await scopedA.delete(['lessons'], 'key')

      expect(await scopedA.get(['lessons'], 'key')).toBeUndefined()
      expect(await scopedB.get(['lessons'], 'key')).toEqual({ tenant: 'B' })
    })
  })

  // ---- search --------------------------------------------------------------

  describe('search', () => {
    it('should search with tenant prefix and strip namespace from results', async () => {
      await scopedA.put(['lessons'], 'l1', { summary: 'first' })
      await scopedA.put(['lessons'], 'l2', { summary: 'second' })

      const results = await scopedA.search(['lessons'])

      expect(results).toHaveLength(2)
      // Namespace should be stripped of tenant prefix
      for (const r of results) {
        expect(r.namespace).toEqual(['lessons'])
      }
    })

    it('should pass options through to underlying search', async () => {
      await scopedA.put(['rules'], 'r1', { content: 'rule 1' })
      await scopedA.put(['rules'], 'r2', { content: 'rule 2' })
      await scopedA.put(['rules'], 'r3', { content: 'rule 3' })

      const results = await scopedA.search(['rules'], { limit: 2 })
      expect(results).toHaveLength(2)
    })

    it('should return empty array when underlying store lacks search', async () => {
      const bareStore = {
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        // No search method
      } as unknown as BaseStore

      const scoped = new TenantScopedStore({ store: bareStore, tenantId: 'tenant-bare' })
      const results = await scoped.search(['lessons'])
      expect(results).toEqual([])
    })
  })

  // ---- list ----------------------------------------------------------------

  describe('list', () => {
    it('should list keys with tenant prefix', async () => {
      await scopedA.put(['skills'], 'sk1', { name: 'skill 1' })
      await scopedA.put(['skills'], 'sk2', { name: 'skill 2' })

      const keys = await scopedA.list(['skills'])
      expect(keys).toContain('sk1')
      expect(keys).toContain('sk2')
    })

    it('should fall back to search when list is not available', async () => {
      const noListStore = {
        put: vi.fn().mockImplementation((_ns: string[], key: string, value: Record<string, unknown>) => {
          underlying._data.set(`${_ns.join('/')}|${key}`, value)
          return Promise.resolve()
        }),
        get: vi.fn(),
        delete: vi.fn(),
        search: vi.fn().mockImplementation((ns: string[]) => {
          const prefix = ns.join('/') + '|'
          const items: Array<{ key: string; value: Record<string, unknown> }> = []
          for (const [ck, value] of underlying._data.entries()) {
            if (ck.startsWith(prefix)) {
              items.push({ key: ck.slice(prefix.length), value })
            }
          }
          return Promise.resolve(items)
        }),
        // No list method
      } as unknown as BaseStore

      const scoped = new TenantScopedStore({ store: noListStore, tenantId: 'tenant-nol' })
      await scoped.put(['ns'], 'k1', { v: 1 })
      await scoped.put(['ns'], 'k2', { v: 2 })

      const keys = await scoped.list(['ns'])
      expect(keys).toContain('k1')
      expect(keys).toContain('k2')
    })

    it('should return empty array when neither list nor search is available', async () => {
      const bareStore = {
        put: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        // No list, no search
      } as unknown as BaseStore

      const scoped = new TenantScopedStore({ store: bareStore, tenantId: 'tenant-bare' })
      const keys = await scoped.list(['ns'])
      expect(keys).toEqual([])
    })
  })

  // ---- scope() -------------------------------------------------------------

  describe('scope', () => {
    it('should create a further-scoped store', async () => {
      const projectScoped = scopedA.scope('project-42')

      expect(projectScoped.tenantId).toBe('tenant-a')
      expect(projectScoped.namespacePrefix).toEqual(['tenant-a', 'project-42'])
    })

    it('should scope data further within the tenant', async () => {
      const proj1 = scopedA.scope('proj-1')
      const proj2 = scopedA.scope('proj-2')

      await proj1.put(['lessons'], 'l1', { project: '1' })
      await proj2.put(['lessons'], 'l1', { project: '2' })

      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a', 'proj-1', 'lessons'],
        'l1',
        { project: '1' },
      )
      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a', 'proj-2', 'lessons'],
        'l1',
        { project: '2' },
      )

      const result1 = await proj1.get(['lessons'], 'l1')
      const result2 = await proj2.get(['lessons'], 'l1')

      expect(result1).toEqual({ project: '1' })
      expect(result2).toEqual({ project: '2' })
    })

    it('should support chaining scope() calls', async () => {
      const deep = scopedA.scope('project').scope('feature').scope('sub')
      expect(deep.namespacePrefix).toEqual(['tenant-a', 'project', 'feature', 'sub'])

      await deep.put([], 'key', { deep: true })
      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-a', 'project', 'feature', 'sub'],
        'key',
        { deep: true },
      )
    })

    it('should share the same underlying store', () => {
      const scoped = scopedA.scope('proj')
      expect(scoped.unwrapped).toBe(underlying)
    })
  })

  // ---- projectId config ----------------------------------------------------

  describe('projectId in config', () => {
    it('should include projectId in namespace prefix', async () => {
      const scoped = new TenantScopedStore({
        store: underlying,
        tenantId: 'tenant-x',
        projectId: 'proj-99',
      })

      await scoped.put(['rules'], 'r1', { content: 'test' })

      expect(underlying.put).toHaveBeenCalledWith(
        ['tenant-x', 'proj-99', 'rules'],
        'r1',
        { content: 'test' },
      )
    })

    it('should further scope from projectId-configured store', () => {
      const scoped = new TenantScopedStore({
        store: underlying,
        tenantId: 'tenant-x',
        projectId: 'proj-99',
      })

      const featureScoped = scoped.scope('feature-1')
      expect(featureScoped.namespacePrefix).toEqual(['tenant-x', 'proj-99', 'feature-1'])
    })
  })
})
