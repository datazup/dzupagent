/**
 * Unit tests for InMemoryAgentCluster.
 *
 * Covers: role management (add/remove/duplicates/not-found),
 * routeMail (happy path, unknown sender/recipient),
 * broadcast (delivers to all except sender, empty cluster),
 * and workspace access.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryAgentCluster } from '../in-memory-agent-cluster.js'
import { InMemoryMailboxStore } from '../../mailbox/in-memory-mailbox-store.js'
import type { ClusterRole } from '../cluster-types.js'

function makeRole(overrides: Partial<ClusterRole> = {}): ClusterRole {
  return {
    roleId: overrides.roleId ?? 'default-role',
    agentId: overrides.agentId ?? 'agent-default',
    capabilities: overrides.capabilities,
  }
}

describe('InMemoryAgentCluster', () => {
  let mailbox: InMemoryMailboxStore
  let cluster: InMemoryAgentCluster

  beforeEach(() => {
    mailbox = new InMemoryMailboxStore()
    cluster = new InMemoryAgentCluster({
      clusterId: 'test-cluster',
      workspace: { type: 'local', path: '/tmp/ws' },
      mailbox,
    })
  })

  // -------------------------------------------------------------------------
  // Role management
  // -------------------------------------------------------------------------

  describe('addRole()', () => {
    it('adds a role and exposes it in roles list', () => {
      const role = makeRole({ roleId: 'planner', agentId: 'agent-1' })
      cluster.addRole(role)

      expect(cluster.roles).toHaveLength(1)
      expect(cluster.roles[0]!.roleId).toBe('planner')
      expect(cluster.roles[0]!.agentId).toBe('agent-1')
    })

    it('supports multiple roles', () => {
      cluster.addRole(makeRole({ roleId: 'planner', agentId: 'a1' }))
      cluster.addRole(makeRole({ roleId: 'coder', agentId: 'a2' }))
      cluster.addRole(makeRole({ roleId: 'reviewer', agentId: 'a3' }))

      expect(cluster.roles).toHaveLength(3)
    })

    it('throws on duplicate roleId', () => {
      cluster.addRole(makeRole({ roleId: 'planner', agentId: 'a1' }))

      expect(() => {
        cluster.addRole(makeRole({ roleId: 'planner', agentId: 'a2' }))
      }).toThrow('Role "planner" already exists in cluster "test-cluster"')
    })

    it('stores capabilities', () => {
      cluster.addRole(makeRole({ roleId: 'coder', agentId: 'a1', capabilities: ['typescript', 'rust'] }))
      expect(cluster.roles[0]!.capabilities).toEqual(['typescript', 'rust'])
    })

    it('does not mutate the original role object', () => {
      const role = makeRole({ roleId: 'planner', agentId: 'a1' })
      cluster.addRole(role)
      role.agentId = 'mutated'

      expect(cluster.roles[0]!.agentId).toBe('a1')
    })
  })

  describe('removeRole()', () => {
    it('removes an existing role', () => {
      cluster.addRole(makeRole({ roleId: 'planner', agentId: 'a1' }))
      cluster.addRole(makeRole({ roleId: 'coder', agentId: 'a2' }))

      cluster.removeRole('planner')

      expect(cluster.roles).toHaveLength(1)
      expect(cluster.roles[0]!.roleId).toBe('coder')
    })

    it('throws when role not found', () => {
      expect(() => {
        cluster.removeRole('nonexistent')
      }).toThrow('Role "nonexistent" not found in cluster "test-cluster"')
    })
  })

  describe('initial roles via constructor', () => {
    it('accepts roles in config', () => {
      const c = new InMemoryAgentCluster({
        clusterId: 'c1',
        workspace: {},
        mailbox,
        roles: [
          makeRole({ roleId: 'a', agentId: 'agent-a' }),
          makeRole({ roleId: 'b', agentId: 'agent-b' }),
        ],
      })

      expect(c.roles).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // routeMail
  // -------------------------------------------------------------------------

  describe('routeMail()', () => {
    beforeEach(() => {
      cluster.addRole(makeRole({ roleId: 'planner', agentId: 'agent-planner' }))
      cluster.addRole(makeRole({ roleId: 'coder', agentId: 'agent-coder' }))
    })

    it('delivers a message from one role to another', async () => {
      const msg = await cluster.routeMail('planner', 'coder', {
        subject: 'Task assignment',
        body: { task: 'implement feature X' },
      })

      expect(msg.from).toBe('agent-planner')
      expect(msg.to).toBe('agent-coder')
      expect(msg.subject).toBe('Task assignment')
      expect(msg.body).toEqual({ task: 'implement feature X' })
      expect(msg.id).toBeTruthy()
      expect(msg.createdAt).toBeGreaterThan(0)
    })

    it('message is persisted in the mailbox store', async () => {
      await cluster.routeMail('planner', 'coder', {
        subject: 'hello',
        body: { x: 1 },
      })

      const stored = await mailbox.findByRecipient('agent-coder')
      expect(stored).toHaveLength(1)
      expect(stored[0]!.from).toBe('agent-planner')
    })

    it('preserves optional ttl', async () => {
      const msg = await cluster.routeMail('planner', 'coder', {
        subject: 'urgent',
        body: {},
        ttl: 60,
      })

      expect(msg.ttl).toBe(60)
    })

    it('throws when sender role is not found', async () => {
      await expect(
        cluster.routeMail('nonexistent', 'coder', {
          subject: 'test',
          body: {},
        }),
      ).rejects.toThrow('Sender role "nonexistent" not found in cluster "test-cluster"')
    })

    it('throws when recipient role is not found', async () => {
      await expect(
        cluster.routeMail('planner', 'nonexistent', {
          subject: 'test',
          body: {},
        }),
      ).rejects.toThrow('Recipient role "nonexistent" not found in cluster "test-cluster"')
    })
  })

  // -------------------------------------------------------------------------
  // broadcast
  // -------------------------------------------------------------------------

  describe('broadcast()', () => {
    beforeEach(() => {
      cluster.addRole(makeRole({ roleId: 'planner', agentId: 'agent-planner' }))
      cluster.addRole(makeRole({ roleId: 'coder', agentId: 'agent-coder' }))
      cluster.addRole(makeRole({ roleId: 'reviewer', agentId: 'agent-reviewer' }))
    })

    it('sends to all roles except the sender', async () => {
      const messages = await cluster.broadcast('planner', {
        subject: 'standup',
        body: { status: 'on track' },
      })

      expect(messages).toHaveLength(2)
      const recipients = messages.map((m) => m.to).sort()
      expect(recipients).toEqual(['agent-coder', 'agent-reviewer'])

      // All messages come from the sender
      for (const m of messages) {
        expect(m.from).toBe('agent-planner')
        expect(m.subject).toBe('standup')
      }
    })

    it('persists all broadcast messages in the store', async () => {
      await cluster.broadcast('planner', {
        subject: 'announcement',
        body: {},
      })

      const coderMsgs = await mailbox.findByRecipient('agent-coder')
      const reviewerMsgs = await mailbox.findByRecipient('agent-reviewer')
      expect(coderMsgs).toHaveLength(1)
      expect(reviewerMsgs).toHaveLength(1)
    })

    it('returns empty array when sender is the only role', async () => {
      const solo = new InMemoryAgentCluster({
        clusterId: 'solo',
        workspace: {},
        mailbox,
        roles: [makeRole({ roleId: 'alone', agentId: 'agent-alone' })],
      })

      const messages = await solo.broadcast('alone', {
        subject: 'echo',
        body: {},
      })

      expect(messages).toHaveLength(0)
    })

    it('throws when sender role is not found', async () => {
      await expect(
        cluster.broadcast('ghost', {
          subject: 'test',
          body: {},
        }),
      ).rejects.toThrow('Sender role "ghost" not found in cluster "test-cluster"')
    })
  })

  // -------------------------------------------------------------------------
  // Workspace access
  // -------------------------------------------------------------------------

  describe('workspace', () => {
    it('exposes the workspace passed at construction', () => {
      const ws = { type: 'local', path: '/tmp/ws' }
      const c = new InMemoryAgentCluster({
        clusterId: 'c1',
        workspace: ws,
        mailbox,
      })

      expect(c.workspace).toBe(ws)
    })
  })

  // -------------------------------------------------------------------------
  // Cluster metadata
  // -------------------------------------------------------------------------

  describe('clusterId', () => {
    it('exposes the cluster id', () => {
      expect(cluster.clusterId).toBe('test-cluster')
    })
  })
})
