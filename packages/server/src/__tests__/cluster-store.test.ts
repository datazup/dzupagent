/**
 * Unit tests for InMemoryClusterStore.
 *
 * Covers: create, findById, delete, addRole, removeRole, listRoles,
 * duplicate cluster, duplicate role, not-found errors.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryClusterStore } from '../persistence/drizzle-cluster-store.js'

describe('InMemoryClusterStore', () => {
  let store: InMemoryClusterStore

  beforeEach(() => {
    store = new InMemoryClusterStore()
  })

  // ── create ────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a cluster and returns a record', async () => {
      const record = await store.create({ id: 'c1' })

      expect(record.id).toBe('c1')
      expect(record.workspaceType).toBe('local')
      expect(record.workspaceOptions).toEqual({})
      expect(record.roles).toEqual([])
      expect(record.createdAt).toBeInstanceOf(Date)
    })

    it('stores custom workspaceType and options', async () => {
      const record = await store.create({
        id: 'c2',
        workspaceType: 'sandboxed',
        workspaceOptions: { image: 'node:20' },
      })

      expect(record.workspaceType).toBe('sandboxed')
      expect(record.workspaceOptions).toEqual({ image: 'node:20' })
    })

    it('throws on duplicate cluster id', async () => {
      await store.create({ id: 'dup' })
      await expect(store.create({ id: 'dup' })).rejects.toThrow('Conflict:')
    })
  })

  // ── findById ──────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns the cluster with roles', async () => {
      await store.create({ id: 'c1' })
      await store.addRole('c1', { roleId: 'planner', agentId: 'a1' })

      const record = await store.findById('c1')
      expect(record).not.toBeNull()
      expect(record!.id).toBe('c1')
      expect(record!.roles).toHaveLength(1)
      expect(record!.roles[0]!.roleId).toBe('planner')
    })

    it('returns null for unknown cluster', async () => {
      const record = await store.findById('nonexistent')
      expect(record).toBeNull()
    })
  })

  // ── delete ────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('deletes an existing cluster and returns true', async () => {
      await store.create({ id: 'c1' })
      const result = await store.delete('c1')
      expect(result).toBe(true)

      const record = await store.findById('c1')
      expect(record).toBeNull()
    })

    it('returns false when cluster does not exist', async () => {
      const result = await store.delete('ghost')
      expect(result).toBe(false)
    })
  })

  // ── addRole ───────────────────────────────────────────────────────────

  describe('addRole()', () => {
    it('adds a role to a cluster', async () => {
      await store.create({ id: 'c1' })
      await store.addRole('c1', { roleId: 'coder', agentId: 'a2', capabilities: ['ts'] })

      const roles = await store.listRoles('c1')
      expect(roles).toHaveLength(1)
      expect(roles[0]).toEqual({ roleId: 'coder', agentId: 'a2', capabilities: ['ts'] })
    })

    it('throws when cluster does not exist', async () => {
      await expect(
        store.addRole('ghost', { roleId: 'x', agentId: 'y' }),
      ).rejects.toThrow('NotFound:')
    })

    it('throws on duplicate roleId within the same cluster', async () => {
      await store.create({ id: 'c1' })
      await store.addRole('c1', { roleId: 'coder', agentId: 'a1' })

      await expect(
        store.addRole('c1', { roleId: 'coder', agentId: 'a2' }),
      ).rejects.toThrow('Conflict:')
    })
  })

  // ── removeRole ────────────────────────────────────────────────────────

  describe('removeRole()', () => {
    it('removes an existing role and returns true', async () => {
      await store.create({ id: 'c1' })
      await store.addRole('c1', { roleId: 'coder', agentId: 'a1' })

      const result = await store.removeRole('c1', 'coder')
      expect(result).toBe(true)

      const roles = await store.listRoles('c1')
      expect(roles).toHaveLength(0)
    })

    it('returns false when role does not exist', async () => {
      await store.create({ id: 'c1' })
      const result = await store.removeRole('c1', 'nonexistent')
      expect(result).toBe(false)
    })

    it('throws when cluster does not exist', async () => {
      await expect(
        store.removeRole('ghost', 'x'),
      ).rejects.toThrow('NotFound:')
    })
  })

  // ── listRoles ─────────────────────────────────────────────────────────

  describe('listRoles()', () => {
    it('returns empty array for cluster with no roles', async () => {
      await store.create({ id: 'c1' })
      const roles = await store.listRoles('c1')
      expect(roles).toEqual([])
    })

    it('returns empty array for nonexistent cluster', async () => {
      const roles = await store.listRoles('ghost')
      expect(roles).toEqual([])
    })

    it('lists multiple roles', async () => {
      await store.create({ id: 'c1' })
      await store.addRole('c1', { roleId: 'a', agentId: 'a1' })
      await store.addRole('c1', { roleId: 'b', agentId: 'a2' })
      await store.addRole('c1', { roleId: 'c', agentId: 'a3' })

      const roles = await store.listRoles('c1')
      expect(roles).toHaveLength(3)
    })
  })
})
