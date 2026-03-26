import { describe, it, expect, beforeEach } from 'vitest'
import { SharedMemoryNamespace } from '../shared-namespace.js'
import type { SharedNamespaceConfig } from '../shared-namespace.js'

describe('SharedMemoryNamespace', () => {
  let ns: SharedMemoryNamespace

  beforeEach(() => {
    ns = new SharedMemoryNamespace({
      namespace: ['shared', 'project-123'],
    })
  })

  // -------------------------------------------------------------------------
  // Basic CRUD
  // -------------------------------------------------------------------------

  describe('put / get / delete', () => {
    it('stores and retrieves an entry', () => {
      const entry = ns.put('agent-a', 'greeting', { text: 'hello' })
      expect(entry.key).toBe('greeting')
      expect(entry.value).toEqual({ text: 'hello' })
      expect(entry.writtenBy).toBe('agent-a')

      const fetched = ns.get('greeting')
      expect(fetched).toEqual(entry)
    })

    it('returns null for a missing key', () => {
      expect(ns.get('nonexistent')).toBeNull()
    })

    it('deletes an existing entry and returns true', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      expect(ns.delete('agent-a', 'k1')).toBe(true)
      expect(ns.get('k1')).toBeNull()
    })

    it('returns false when deleting a non-existent key', () => {
      expect(ns.delete('agent-a', 'nope')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Version tracking
  // -------------------------------------------------------------------------

  describe('version tracking', () => {
    it('starts at version 1 for a new key', () => {
      const entry = ns.put('agent-a', 'k', { x: 1 })
      expect(entry.version).toBe(1)
    })

    it('increments version on successive puts', () => {
      ns.put('agent-a', 'k', { x: 1 })
      const v2 = ns.put('agent-a', 'k', { x: 2 })
      expect(v2.version).toBe(2)

      const v3 = ns.put('agent-b', 'k', { x: 3 })
      expect(v3.version).toBe(3)
    })

    it('preserves createdAt across updates', () => {
      const first = ns.put('agent-a', 'k', { x: 1 })
      const second = ns.put('agent-a', 'k', { x: 2 })
      expect(second.createdAt).toBe(first.createdAt)
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    })
  })

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------

  describe('access control', () => {
    let restricted: SharedMemoryNamespace

    beforeEach(() => {
      restricted = new SharedMemoryNamespace({
        namespace: ['restricted'],
        allowedWriters: ['agent-a', 'agent-b'],
      })
    })

    it('allows writes from permitted agents', () => {
      expect(() => restricted.put('agent-a', 'k', { v: 1 })).not.toThrow()
      expect(() => restricted.put('agent-b', 'k2', { v: 2 })).not.toThrow()
    })

    it('rejects writes from non-permitted agents', () => {
      expect(() => restricted.put('agent-c', 'k', { v: 1 })).toThrow(
        'Agent "agent-c" is not allowed to write',
      )
    })

    it('rejects deletes from non-permitted agents', () => {
      restricted.put('agent-a', 'k', { v: 1 })
      expect(() => restricted.delete('agent-c', 'k')).toThrow(
        'Agent "agent-c" is not allowed to write',
      )
    })

    it('canWrite returns correct boolean', () => {
      expect(restricted.canWrite('agent-a')).toBe(true)
      expect(restricted.canWrite('agent-c')).toBe(false)
    })

    it('allows all writers when allowedWriters is empty', () => {
      const open = new SharedMemoryNamespace({
        namespace: ['open'],
        allowedWriters: [],
      })
      expect(open.canWrite('anyone')).toBe(true)
    })

    it('allows all writers when allowedWriters is undefined', () => {
      expect(ns.canWrite('anyone')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  describe('audit trail', () => {
    let audited: SharedMemoryNamespace

    beforeEach(() => {
      audited = new SharedMemoryNamespace({
        namespace: ['audited'],
        enableAudit: true,
      })
    })

    it('records put operations', () => {
      audited.put('agent-a', 'k1', { v: 1 })
      const trail = audited.getAudit()
      expect(trail).toHaveLength(1)
      expect(trail[0].action).toBe('put')
      expect(trail[0].key).toBe('k1')
      expect(trail[0].agentId).toBe('agent-a')
      expect(trail[0].previousVersion).toBeUndefined()
    })

    it('records previousVersion on updates', () => {
      audited.put('agent-a', 'k1', { v: 1 })
      audited.put('agent-b', 'k1', { v: 2 })
      const trail = audited.getAudit('k1')
      expect(trail).toHaveLength(2)
      expect(trail[1].previousVersion).toBe(1)
    })

    it('records delete operations with previousVersion', () => {
      audited.put('agent-a', 'k1', { v: 1 })
      audited.delete('agent-a', 'k1')
      const trail = audited.getAudit('k1')
      expect(trail).toHaveLength(2)
      expect(trail[1].action).toBe('delete')
      expect(trail[1].previousVersion).toBe(1)
    })

    it('filters audit by key', () => {
      audited.put('agent-a', 'k1', { v: 1 })
      audited.put('agent-a', 'k2', { v: 2 })
      expect(audited.getAudit('k1')).toHaveLength(1)
      expect(audited.getAudit('k2')).toHaveLength(1)
    })

    it('returns empty array when audit is disabled', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      expect(ns.getAudit()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // maxEntries eviction
  // -------------------------------------------------------------------------

  describe('maxEntries eviction', () => {
    it('evicts oldest entries when maxEntries is exceeded', () => {
      const small = new SharedMemoryNamespace({
        namespace: ['small'],
        maxEntries: 3,
      })

      small.put('a', 'k1', { order: 1 })
      small.put('a', 'k2', { order: 2 })
      small.put('a', 'k3', { order: 3 })
      // k1 is oldest, should be evicted
      small.put('a', 'k4', { order: 4 })

      expect(small.list()).toHaveLength(3)
      expect(small.get('k1')).toBeNull()
      expect(small.get('k2')).not.toBeNull()
      expect(small.get('k4')).not.toBeNull()
    })

    it('defaults maxEntries to 1000', () => {
      // Just verify it does not throw when adding many entries
      for (let i = 0; i < 50; i++) {
        ns.put('a', `key-${i}`, { i })
      }
      expect(ns.list()).toHaveLength(50)
    })
  })

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      ns.put('a', 'user-preferences', { theme: 'dark', language: 'typescript' })
      ns.put('a', 'project-config', { framework: 'vue', bundler: 'vite' })
      ns.put('a', 'deployment-notes', { env: 'production', region: 'us-east' })
    })

    it('matches on key substring', () => {
      const results = ns.search('project')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('project-config')
    })

    it('matches on value content', () => {
      const results = ns.search('typescript')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('user-preferences')
    })

    it('is case-insensitive', () => {
      const results = ns.search('VUE')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('project-config')
    })

    it('respects limit parameter', () => {
      // All three entries contain some text
      ns.put('a', 'extra', { note: 'production data' })
      const results = ns.search('', 2)
      expect(results).toHaveLength(2)
    })

    it('returns empty array when no match', () => {
      expect(ns.search('nonexistent-query')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('returns all entries', () => {
      ns.put('a', 'k1', { v: 1 })
      ns.put('b', 'k2', { v: 2 })
      const all = ns.list()
      expect(all).toHaveLength(2)
      const keys = all.map((e) => e.key)
      expect(keys).toContain('k1')
      expect(keys).toContain('k2')
    })

    it('returns empty array when namespace is empty', () => {
      expect(ns.list()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('reports correct counts', () => {
      ns.put('agent-a', 'k1', { v: 1 })
      ns.put('agent-b', 'k2', { v: 2 })
      ns.put('agent-a', 'k3', { v: 3 })

      const s = ns.stats()
      expect(s.entryCount).toBe(3)
      expect(s.writerCount).toBe(2)
      expect(s.lastWriteAt).toBeGreaterThan(0)
      expect(s.auditSize).toBe(0) // audit disabled by default
    })

    it('reports null lastWriteAt when empty', () => {
      const s = ns.stats()
      expect(s.lastWriteAt).toBeNull()
    })

    it('includes audit size when enabled', () => {
      const audited = new SharedMemoryNamespace({
        namespace: ['a'],
        enableAudit: true,
      })
      audited.put('x', 'k1', { v: 1 })
      audited.put('x', 'k1', { v: 2 })
      audited.delete('x', 'k1')

      const s = audited.stats()
      expect(s.auditSize).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // Multiple agents writing same key (last-writer-wins)
  // -------------------------------------------------------------------------

  describe('last-writer-wins', () => {
    it('the last put wins regardless of agent', () => {
      ns.put('agent-a', 'shared-key', { owner: 'a' })
      ns.put('agent-b', 'shared-key', { owner: 'b' })

      const entry = ns.get('shared-key')
      expect(entry).not.toBeNull()
      expect(entry!.value).toEqual({ owner: 'b' })
      expect(entry!.writtenBy).toBe('agent-b')
      expect(entry!.version).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all entries', () => {
      ns.put('a', 'k1', { v: 1 })
      ns.put('a', 'k2', { v: 2 })
      ns.clear()
      expect(ns.list()).toEqual([])
      expect(ns.get('k1')).toBeNull()
    })

    it('clears audit trail as well', () => {
      const audited = new SharedMemoryNamespace({
        namespace: ['a'],
        enableAudit: true,
      })
      audited.put('x', 'k', { v: 1 })
      audited.clear()
      expect(audited.getAudit()).toEqual([])
      expect(audited.stats().auditSize).toBe(0)
    })
  })
})
