import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAgentStore, InMemoryRegistry } from '@dzupagent/core'
import { AgentControlPlaneService } from '../agent-control-plane-service.js'

describe('AgentControlPlaneService', () => {
  let agentStore: InMemoryAgentStore

  beforeEach(() => {
    agentStore = new InMemoryAgentStore()
  })

  it('resolves a directly stored active execution spec', async () => {
    await agentStore.save({
      id: 'agent-1',
      name: 'Local Agent',
      instructions: 'local',
      modelTier: 'chat',
      active: true,
    })

    const service = new AgentControlPlaneService({ agentStore })
    const resolved = await service.resolveExecutableAgent('agent-1')

    expect(resolved?.id).toBe('agent-1')
  })

  it('resolves a registered agent via metadata.executionSpecId projection', async () => {
    const registry = new InMemoryRegistry()
    await agentStore.save({
      id: 'local-exec-1',
      name: 'Projected Local Agent',
      instructions: 'projected',
      modelTier: 'chat',
      active: true,
    })

    const registered = await registry.register({
      name: 'Managed Agent',
      description: 'Registry-backed agent',
      capabilities: [{ name: 'code.review', version: '1.0.0', description: 'Code review' }],
      metadata: { executionSpecId: 'local-exec-1' },
    })

    const service = new AgentControlPlaneService({ agentStore, registry })
    const resolved = await service.resolveExecutableAgent(registered.id)

    expect(resolved?.id).toBe('local-exec-1')
  })

  it('returns null for discover-only registry agents without a local projection', async () => {
    const registry = new InMemoryRegistry()
    const registered = await registry.register({
      name: 'Remote Agent',
      description: 'Discover only',
      endpoint: 'https://remote.example.com/agent',
      capabilities: [{ name: 'remote.search', version: '1.0.0', description: 'Remote search' }],
    })

    const service = new AgentControlPlaneService({ agentStore, registry })
    const resolved = await service.resolveExecutableAgent(registered.id)

    expect(resolved).toBeNull()
  })

  it('returns null when the projected execution spec is inactive', async () => {
    const registry = new InMemoryRegistry()
    await agentStore.save({
      id: 'inactive-exec',
      name: 'Inactive Local Agent',
      instructions: 'inactive',
      modelTier: 'chat',
      active: false,
    })

    const registered = await registry.register({
      name: 'Managed Agent',
      description: 'Registry-backed agent',
      capabilities: [{ name: 'code.review', version: '1.0.0', description: 'Code review' }],
      metadata: { executionSpecId: 'inactive-exec' },
    })

    const service = new AgentControlPlaneService({ agentStore, registry })
    const resolved = await service.resolveExecutableAgent(registered.id)

    expect(resolved).toBeNull()
  })
})
