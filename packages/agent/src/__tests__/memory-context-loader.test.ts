import { HumanMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'

import { AgentMemoryContextLoader, type ArrowMemoryRuntime } from '../agent/memory-context-loader.js'

function createMemoryService() {
  return {
    get: vi.fn(async () => [{ text: 'stored fact' }]),
    formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
      records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`),
  }
}

describe('AgentMemoryContextLoader', () => {
  it('loads memory through the standard path when Arrow memory is not configured', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
    })

    await expect(loader.load([new HumanMessage('hello')])).resolves.toBe(
      '## Memory Context\n- stored fact',
    )
    expect(memory.get).toHaveBeenCalledWith('facts', { project: 'demo' })
    expect(memory.formatForPrompt).toHaveBeenCalled()
  })

  it('uses Arrow selection when configured and formats the selected records', async () => {
    const memory = createMemoryService()
    const phaseWeightedSelection = vi.fn(() => [{ rowIndex: 1 }])
    const selectMemoriesByBudget = vi.fn(() => [])

    class FakeFrameReader {
      constructor(_frame: { numRows: number }) {}

      toRecords() {
        return [
          { meta: { namespace: 'facts' }, value: { text: 'ignored' } },
          { meta: { namespace: 'facts' }, value: { text: 'selected fact' } },
        ]
      }
    }

    const loadArrowRuntime = vi.fn(async (): Promise<ArrowMemoryRuntime> => ({
      extendMemoryServiceWithArrow: () => ({
        exportFrame: async () => ({ numRows: 2 }),
      }),
      selectMemoriesByBudget,
      phaseWeightedSelection,
      FrameReader: FakeFrameReader,
    }))

    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'coding',
        totalBudget: 10_000,
        maxMemoryFraction: 1,
        minResponseReserve: 0,
      },
      estimateConversationTokens: () => 100,
      loadArrowRuntime,
    })

    await expect(loader.load([new HumanMessage('hello')])).resolves.toBe(
      '## Memory Context\n- [facts] selected fact',
    )
    expect(loadArrowRuntime).toHaveBeenCalledTimes(1)
    expect(phaseWeightedSelection).toHaveBeenCalledTimes(1)
    expect(selectMemoriesByBudget).not.toHaveBeenCalled()
    expect(memory.get).not.toHaveBeenCalled()
  })

  it('falls back to the standard path when Arrow loading fails', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: { currentPhase: 'general' },
      estimateConversationTokens: () => 0,
      loadArrowRuntime: async () => {
        throw new Error('Arrow unavailable')
      },
    })

    await expect(loader.load([new HumanMessage('hello')])).resolves.toBe(
      '## Memory Context\n- stored fact',
    )
    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.formatForPrompt).toHaveBeenCalledTimes(1)
  })
})
