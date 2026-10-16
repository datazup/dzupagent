import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryAgentStore } from '@dzupagent/core'
import { AgentDefinitionConflictError, AgentDefinitionService } from '../agent-definition-service.js'

describe('AgentDefinitionService', () => {
  let service: AgentDefinitionService
  let agentStore: InMemoryAgentStore

  beforeEach(() => {
    agentStore = new InMemoryAgentStore()
    service = new AgentDefinitionService({ agentStore })
  })

  it('creates and returns a persisted agent definition', async () => {
    const created = await service.create({
      id: 'agent-1',
      name: 'Test Agent',
      instructions: 'Be useful',
      modelTier: 'sonnet',
    })

    expect(created).not.toBeNull()
    expect(created?.id).toBe('agent-1')
    expect(created?.active).toBe(true)
  })

  it('rejects duplicate ids in the same tenant and preserves the original definition', async () => {
    const original = await service.create({
      id: 'agent-1',
      name: 'Original Agent',
      instructions: 'Original instructions',
      modelTier: 'sonnet',
      tenantId: 'tenant-a',
      tools: ['original-tool'],
      approval: 'required',
    })

    await expect(service.create({
      id: 'agent-1',
      name: 'Replacement Agent',
      instructions: 'Replacement instructions',
      modelTier: 'haiku',
      tenantId: 'tenant-a',
      tools: ['replacement-tool'],
      approval: 'auto',
    })).rejects.toBeInstanceOf(AgentDefinitionConflictError)

    const stored = await agentStore.get('agent-1')
    expect(stored).toEqual(original)
    expect(stored).toMatchObject({
      name: 'Original Agent',
      instructions: 'Original instructions',
    })
  })

  it('rejects duplicate ids across tenants and preserves the owning tenant definition', async () => {
    const original = await service.create({
      id: 'agent-1',
      name: 'Tenant A Agent',
      instructions: 'Work for tenant A',
      modelTier: 'sonnet',
      tenantId: 'tenant-a',
      tools: ['original-tool'],
      approval: 'required',
    })

    await expect(service.create({
      id: 'agent-1',
      name: 'Tenant B Agent',
      instructions: 'Work for tenant B',
      modelTier: 'haiku',
      tenantId: 'tenant-b',
      tools: ['replacement-tool'],
      approval: 'auto',
    })).rejects.toBeInstanceOf(AgentDefinitionConflictError)

    const stored = await agentStore.get('agent-1')
    expect(stored).toEqual(original)
    expect(stored).toMatchObject({
      tenantId: 'tenant-a',
      instructions: 'Work for tenant A',
    })
  })

  it('creates distinct ids when no id is supplied', async () => {
    const input = {
      name: 'Generated Agent',
      instructions: 'Be useful',
      modelTier: 'sonnet',
    }
    const first = await service.create(input)
    const second = await service.create(input)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first?.id).toEqual(expect.any(String))
    expect(second?.id).toEqual(expect.any(String))
    expect(first?.id).not.toBe(second?.id)
    expect(await agentStore.get(first!.id)).toEqual(first)
    expect(await agentStore.get(second!.id)).toEqual(second)
  })

  it('clamps list limit to 200', async () => {
    const listSpy = agentStore.list.bind(agentStore)
    let seenLimit: number | undefined
    agentStore.list = async (filter) => {
      seenLimit = filter?.limit
      return listSpy(filter)
    }

    await service.list({ limit: 99999 })

    expect(seenLimit).toBe(200)
  })

  it('updates an existing agent definition and preserves id', async () => {
    await service.create({
      id: 'agent-1',
      name: 'Original',
      instructions: 'Old',
      modelTier: 'haiku',
    })

    const updated = await service.update('agent-1', {
      name: 'Updated',
      modelTier: 'sonnet',
    })

    expect(updated).not.toBeNull()
    expect(updated?.id).toBe('agent-1')
    expect(updated?.name).toBe('Updated')
    expect(updated?.modelTier).toBe('sonnet')
    expect(updated?.instructions).toBe('Old')
  })

  it('returns null when updating a missing agent definition', async () => {
    const updated = await service.update('missing', { name: 'Nope' })
    expect(updated).toBeNull()
  })

  it('returns false when deleting a missing agent definition', async () => {
    await expect(service.delete('missing')).resolves.toBe(false)
  })
})
