import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryAgentStore } from '@dzupagent/core'
import { AgentDefinitionService } from '../agent-definition-service.js'

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
