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
    // The resolver only reads; the remaining members throw so a future call
    // cannot silently succeed against a no-op double.
    const store: AgentExecutionSpecStore = {
      get,
      save: () => {
        throw new Error('AgentExecutionSpecStore double: save() is not implemented')
      },
      list: () => {
        throw new Error('AgentExecutionSpecStore double: list() is not implemented')
      },
      delete: () => {
        throw new Error('AgentExecutionSpecStore double: delete() is not implemented')
      },
    }

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
