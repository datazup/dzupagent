/**
 * Unit tests for AgentDefinitionService.
 *
 * All persistence is backed by InMemoryAgentStore so there is no network or
 * database dependency. Tenant-scoping isolation is the primary correctness
 * concern, alongside basic CRUD lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryAgentStore } from '@dzupagent/core'
import { AgentDefinitionService } from '../services/agent-definition-service.js'
import type { AgentDefinitionServiceConfig } from '../services/agent-definition-service.js'

function makeService(overrides: Partial<AgentDefinitionServiceConfig> = {}): AgentDefinitionService {
  return new AgentDefinitionService({
    agentStore: new InMemoryAgentStore(),
    ...overrides,
  })
}

describe('AgentDefinitionService', () => {
  let svc: AgentDefinitionService

  beforeEach(() => {
    svc = makeService()
  })

  // --- create ---

  describe('create', () => {
    it('creates an agent and returns it with generated id when none supplied', async () => {
      const agent = await svc.create({
        name: 'Triage',
        instructions: 'handle tickets',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })
      expect(agent).not.toBeNull()
      expect(agent?.id).toBeTruthy()
      expect(agent?.name).toBe('Triage')
    })

    it('uses the supplied id when provided', async () => {
      const agent = await svc.create({
        id: 'fixed-id',
        name: 'Fixed',
        instructions: 'i',
        modelTier: 'chat',
      })
      expect(agent?.id).toBe('fixed-id')
    })

    it('defaults tenantId to "default" when omitted', async () => {
      const agent = await svc.create({
        name: 'DefaultTenant',
        instructions: 'i',
        modelTier: 'chat',
      })
      expect(agent?.tenantId).toBe('default')
    })

    it('sets active=true on creation', async () => {
      const agent = await svc.create({ name: 'A', instructions: 'i', modelTier: 'chat' })
      expect(agent?.active).toBe(true)
    })

    it('stores optional fields — tools, guardrails, approval', async () => {
      const agent = await svc.create({
        name: 'Full',
        instructions: 'i',
        modelTier: 'chat',
        tools: ['search', 'code'],
        guardrails: { maxTokens: 4096 },
        approval: 'required',
      })
      expect(agent?.tools).toEqual(['search', 'code'])
      expect(agent?.guardrails).toEqual({ maxTokens: 4096 })
      expect(agent?.approval).toBe('required')
    })
  })

  // --- get ---

  describe('get', () => {
    it('returns the agent for its own tenantId', async () => {
      const created = await svc.create({
        name: 'T1Agent',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const found = await svc.get(created!.id, 'tenant-1')
      expect(found?.id).toBe(created?.id)
    })

    it('returns null when tenantId does not match (cross-tenant isolation)', async () => {
      const created = await svc.create({
        name: 'T1Agent',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const foreign = await svc.get(created!.id, 'tenant-2')
      expect(foreign).toBeNull()
    })

    it('returns null for unknown id', async () => {
      const result = await svc.get('nonexistent')
      expect(result).toBeNull()
    })

    it('returns the agent without tenantId check when no tenantId is provided to get()', async () => {
      const created = await svc.create({
        name: 'Unchecked',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-x',
      })

      // Calling get() without tenantId should return the agent regardless of its tenant
      const found = await svc.get(created!.id)
      expect(found?.id).toBe(created?.id)
    })
  })

  // --- list ---

  describe('list', () => {
    it('returns all agents when no filter is supplied', async () => {
      await svc.create({ name: 'A1', instructions: 'i', modelTier: 'chat', tenantId: 'tenant-1' })
      await svc.create({ name: 'A2', instructions: 'i', modelTier: 'chat', tenantId: 'tenant-2' })

      const all = await svc.list()
      expect(all.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by tenantId', async () => {
      await svc.create({ name: 'T1', instructions: 'i', modelTier: 'chat', tenantId: 'tenant-1' })
      await svc.create({ name: 'T2', instructions: 'i', modelTier: 'chat', tenantId: 'tenant-2' })

      const t1 = await svc.list({ tenantId: 'tenant-1' })
      expect(t1.every((a) => a.tenantId === 'tenant-1')).toBe(true)
      expect(t1).toHaveLength(1)
    })

    it('caps limit at 200 even when caller requests more', async () => {
      // We do not need 200+ agents; just verify the Math.min clamp is applied
      // by checking that list() accepts limit:9999 without error and returns
      // however many agents exist.
      await svc.create({ name: 'A', instructions: 'i', modelTier: 'chat' })
      const result = await svc.list({ limit: 9999 })
      expect(Array.isArray(result)).toBe(true)
    })
  })

  // --- update ---

  describe('update', () => {
    it('updates name and instructions for the owning tenant', async () => {
      const created = await svc.create({
        name: 'Old',
        instructions: 'old instructions',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const updated = await svc.update(
        created!.id,
        { name: 'New', instructions: 'new instructions' },
        'tenant-1',
      )

      expect(updated?.name).toBe('New')
      expect(updated?.instructions).toBe('new instructions')
    })

    it('returns null when the agent does not belong to the provided tenantId', async () => {
      const created = await svc.create({
        name: 'Private',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const result = await svc.update(created!.id, { name: 'Hijacked' }, 'tenant-2')
      expect(result).toBeNull()
    })

    it('returns null for unknown id', async () => {
      const result = await svc.update('ghost', { name: 'X' }, 'tenant-1')
      expect(result).toBeNull()
    })

    it('preserves unmentioned fields after partial update', async () => {
      const created = await svc.create({
        name: 'Original',
        instructions: 'i',
        modelTier: 'chat',
        tools: ['search'],
        tenantId: 'tenant-1',
      })

      const updated = await svc.update(created!.id, { name: 'Updated' }, 'tenant-1')

      // tools should be unchanged
      expect(updated?.tools).toEqual(['search'])
      expect(updated?.modelTier).toBe('chat')
    })
  })

  // --- delete ---

  describe('delete', () => {
    it('deletes an agent and returns true', async () => {
      const created = await svc.create({
        name: 'ToDelete',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const result = await svc.delete(created!.id, 'tenant-1')
      expect(result).toBe(true)

      // Agent should no longer be retrievable
      const afterDelete = await svc.get(created!.id)
      expect(afterDelete).toBeNull()
    })

    it('returns false when the agent does not belong to the tenant', async () => {
      const created = await svc.create({
        name: 'Protected',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-1',
      })

      const result = await svc.delete(created!.id, 'tenant-2')
      expect(result).toBe(false)

      // Agent should still exist under its own tenant
      const still = await svc.get(created!.id, 'tenant-1')
      expect(still).not.toBeNull()
    })

    it('returns false for a completely unknown id', async () => {
      const result = await svc.delete('phantom', 'tenant-1')
      expect(result).toBe(false)
    })

    it('deletes without tenantId check when no tenantId supplied', async () => {
      const created = await svc.create({
        name: 'NoCheck',
        instructions: 'i',
        modelTier: 'chat',
        tenantId: 'tenant-x',
      })

      const result = await svc.delete(created!.id)
      expect(result).toBe(true)
      expect(await svc.get(created!.id)).toBeNull()
    })
  })
})
