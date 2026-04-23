import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutionSpecStore } from '@dzupagent/core'
import {
  AgentStoreExecutableAgentResolver,
  ControlPlaneExecutableAgentResolver,
} from '../executable-agent-resolver.js'

describe('AgentStoreExecutableAgentResolver', () => {
  it('resolves execution specs from the backing store', async () => {
    const get = vi.fn<AgentExecutionSpecStore['get']>().mockResolvedValue({
      id: 'agent-1',
      name: 'Agent 1',
      instructions: 'test',
      modelTier: 'chat',
    })
    const store = { get } as AgentExecutionSpecStore

    const resolver = new AgentStoreExecutableAgentResolver(store)
    const resolved = await resolver.resolve('agent-1')

    expect(resolved?.id).toBe('agent-1')
    expect(get).toHaveBeenCalledWith('agent-1')
  })
})

describe('ControlPlaneExecutableAgentResolver', () => {
  it('delegates resolution to the control-plane service', async () => {
    const resolveExecutableAgent = vi.fn().mockResolvedValue({
      id: 'agent-1',
      name: 'Agent 1',
      instructions: 'test',
      modelTier: 'chat',
    })

    const resolver = new ControlPlaneExecutableAgentResolver({
      resolveExecutableAgent,
    } as { resolveExecutableAgent(agentId: string): Promise<unknown> } as never)
    const resolved = await resolver.resolve('agent-1')

    expect(resolved?.id).toBe('agent-1')
    expect(resolveExecutableAgent).toHaveBeenCalledWith('agent-1')
  })
})
