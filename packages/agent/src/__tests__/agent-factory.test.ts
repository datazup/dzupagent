import { describe, expect, it, vi } from 'vitest'
import { FrozenSnapshot } from '@dzupagent/context'

import { DzupAgent } from '../agent/dzip-agent.js'
import { createAgentWithMemory } from '../agent/agent-factory.js'

function createMockModel() {
  return { invoke: vi.fn(async () => ({ content: 'ok' })) }
}

function createMemoryService(records: Array<Record<string, unknown>>) {
  return {
    get: vi.fn(async () => records),
  }
}

describe('createAgentWithMemory', () => {
  it('returns a DzupAgent instance with a populated frozen snapshot', async () => {
    const memory = createMemoryService([
      { text: 'fact one' },
      { text: 'fact two' },
    ])
    const model = createMockModel()

    const agent = await createAgentWithMemory(
      {
        id: 'factory-agent',
        instructions: 'Base instructions',
        model: model as never,
      },
      memory as never,
      'facts',
      { project: 'demo' },
    )

    expect(agent).toBeInstanceOf(DzupAgent)
    expect(memory.get).toHaveBeenCalledWith('facts', { project: 'demo' })

    const snapshot = agent.agentConfig.frozenSnapshot
    expect(snapshot).toBeInstanceOf(FrozenSnapshot)
    expect(snapshot?.isActive()).toBe(true)

    const context = snapshot?.get() ?? ''
    expect(context).toContain('## Memory Snapshot')
    expect(context).toContain('fact one')
    expect(context).toContain('fact two')
  })

  it('passes an empty scope to memory.get when scope is omitted', async () => {
    const memory = createMemoryService([{ text: 'only fact' }])
    const model = createMockModel()

    const agent = await createAgentWithMemory(
      {
        id: 'factory-agent-no-scope',
        instructions: 'Base instructions',
        model: model as never,
      },
      memory as never,
      'notes',
    )

    expect(memory.get).toHaveBeenCalledWith('notes', {})
    expect(agent.agentConfig.frozenSnapshot?.isActive()).toBe(true)
    expect(agent.agentConfig.frozenSnapshot?.get()).toContain('only fact')
  })

  it('overrides any frozenSnapshot already present on the config', async () => {
    const preexisting = new FrozenSnapshot()
    preexisting.freeze('stale snapshot body')

    const memory = createMemoryService([{ text: 'fresh fact' }])
    const model = createMockModel()

    const agent = await createAgentWithMemory(
      {
        id: 'factory-agent-override',
        instructions: 'Base instructions',
        model: model as never,
        frozenSnapshot: preexisting,
      },
      memory as never,
      'facts',
    )

    const snapshot = agent.agentConfig.frozenSnapshot
    expect(snapshot).not.toBe(preexisting)
    expect(snapshot?.get()).toContain('fresh fact')
    expect(snapshot?.get()).not.toContain('stale snapshot body')
  })

  it('uses config.memory when memory param is omitted', async () => {
    const memory = createMemoryService([{ text: 'from config memory' }])
    const model = createMockModel()

    const agent = await createAgentWithMemory({
      id: 'factory-agent-config-memory',
      instructions: 'Base instructions',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    expect(memory.get).toHaveBeenCalledWith('facts', { project: 'demo' })
    expect(agent.agentConfig.frozenSnapshot?.get()).toContain(
      'from config memory',
    )
  })

  it('uses config.memoryNamespace when namespace param is omitted', async () => {
    const memory = createMemoryService([{ text: 'ns-from-config' }])
    const model = createMockModel()

    const agent = await createAgentWithMemory(
      {
        id: 'factory-agent-config-namespace',
        instructions: 'Base instructions',
        model: model as never,
        memoryNamespace: 'config-ns',
      },
      memory as never,
    )

    expect(memory.get).toHaveBeenCalledWith('config-ns', {})
    expect(agent.agentConfig.frozenSnapshot?.get()).toContain('ns-from-config')
  })

  it('uses config.memoryScope when scope param is omitted', async () => {
    const memory = createMemoryService([{ text: 'scope-from-config' }])
    const model = createMockModel()

    await createAgentWithMemory(
      {
        id: 'factory-agent-config-scope',
        instructions: 'Base instructions',
        model: model as never,
        memoryScope: { tenant: 'acme' },
      },
      memory as never,
      'facts',
    )

    expect(memory.get).toHaveBeenCalledWith('facts', { tenant: 'acme' })
  })

  it("falls back to 'default' namespace and {} scope when neither param nor config field is set", async () => {
    const memory = createMemoryService([{ text: 'default-fallback' }])
    const model = createMockModel()

    await createAgentWithMemory(
      {
        id: 'factory-agent-defaults',
        instructions: 'Base instructions',
        model: model as never,
      },
      memory as never,
    )

    expect(memory.get).toHaveBeenCalledWith('default', {})
  })

  it('throws a descriptive error when both memory param and config.memory are absent', async () => {
    const model = createMockModel()

    await expect(
      createAgentWithMemory({
        id: 'factory-agent-no-memory',
        instructions: 'Base instructions',
        model: model as never,
      }),
    ).rejects.toThrow(
      'createAgentWithMemory: no MemoryService provided — pass memory param or set config.memory',
    )
  })
})
