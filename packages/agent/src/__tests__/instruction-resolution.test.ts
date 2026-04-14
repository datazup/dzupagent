import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentInstructionResolver } from '../agent/instruction-resolution.js'

vi.mock('../instructions/instruction-loader.js', () => ({
  loadAgentsFiles: vi.fn(),
}))

vi.mock('../instructions/instruction-merger.js', () => ({
  mergeInstructions: vi.fn(),
}))

import { loadAgentsFiles } from '../instructions/instruction-loader.js'
import { mergeInstructions } from '../instructions/instruction-merger.js'

describe('AgentInstructionResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns static instructions without loading AGENTS files in static mode', async () => {
    const resolver = new AgentInstructionResolver({
      agentId: 'reviewer',
      instructions: 'Static instructions',
      instructionsMode: 'static',
    })

    await expect(resolver.resolve()).resolves.toBe('Static instructions')
    expect(loadAgentsFiles).not.toHaveBeenCalled()
    expect(mergeInstructions).not.toHaveBeenCalled()
  })

  it('caches merged instructions after first successful resolution', async () => {
    vi.mocked(loadAgentsFiles).mockResolvedValue([
      { path: '/repo/AGENTS.md', sections: [{ agentId: 'reviewer', instructions: 'Merged' }] },
    ])
    vi.mocked(mergeInstructions).mockReturnValue({
      systemPrompt: 'Merged instructions',
      agentHierarchy: [],
      sources: ['/repo/AGENTS.md'],
    })

    const resolver = new AgentInstructionResolver({
      agentId: 'reviewer',
      instructions: 'Static instructions',
      instructionsMode: 'static+agents',
      agentsDir: '/repo',
    })

    await expect(resolver.resolve()).resolves.toBe('Merged instructions')
    await expect(resolver.resolve()).resolves.toBe('Merged instructions')

    expect(loadAgentsFiles).toHaveBeenCalledTimes(1)
    expect(mergeInstructions).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent AGENTS loads', async () => {
    let resolveLoad: ((value: Array<{ path: string; sections: Array<{ agentId: string; instructions: string }> }>) => void) | null = null
    const loadPromise = new Promise<Array<{ path: string; sections: Array<{ agentId: string; instructions: string }> }>>((resolve) => {
      resolveLoad = resolve
    })

    vi.mocked(loadAgentsFiles).mockReturnValue(loadPromise)
    vi.mocked(mergeInstructions).mockReturnValue({
      systemPrompt: 'Concurrent merge',
      agentHierarchy: [],
      sources: ['/repo/AGENTS.md'],
    })

    const resolver = new AgentInstructionResolver({
      agentId: 'reviewer',
      instructions: 'Static instructions',
      instructionsMode: 'static+agents',
      agentsDir: '/repo',
    })

    const first = resolver.resolve()
    const second = resolver.resolve()

    expect(loadAgentsFiles).toHaveBeenCalledTimes(1)

    resolveLoad?.([{ path: '/repo/AGENTS.md', sections: [{ agentId: 'reviewer', instructions: 'Merged' }] }])

    await expect(first).resolves.toBe('Concurrent merge')
    await expect(second).resolves.toBe('Concurrent merge')
    expect(mergeInstructions).toHaveBeenCalledTimes(1)
  })

  it('falls back to static instructions when AGENTS loading fails', async () => {
    vi.mocked(loadAgentsFiles).mockRejectedValue(new Error('boom'))

    const resolver = new AgentInstructionResolver({
      agentId: 'reviewer',
      instructions: 'Static instructions',
      instructionsMode: 'static+agents',
      agentsDir: '/repo',
    })

    await expect(resolver.resolve()).resolves.toBe('Static instructions')
    expect(mergeInstructions).not.toHaveBeenCalled()
  })
})
