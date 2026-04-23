import { HumanMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import type { FrozenSnapshot } from '@dzupagent/context'

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

    await expect(loader.load([new HumanMessage('hello')])).resolves.toMatchObject({
      context: '## Memory Context\n- stored fact',
    })
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

    await expect(loader.load([new HumanMessage('hello')])).resolves.toMatchObject({
      context: '## Memory Context\n- [facts] selected fact',
    })
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

    await expect(loader.load([new HumanMessage('hello')])).resolves.toMatchObject({
      context: '## Memory Context\n- stored fact',
    })
    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.formatForPrompt).toHaveBeenCalledTimes(1)
  })

  it('invokes onFallback with arrow_fallback when Arrow path throws', async () => {
    const memory = createMemoryService()
    const onFallback = vi.fn()
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
      onFallback,
    })

    await loader.load([new HumanMessage('hello')])

    expect(onFallback).toHaveBeenCalledWith('arrow_fallback', 0, 0)
  })

  it('invokes onFallback with budget_zero when the computed memory budget is non-positive', async () => {
    const memory = createMemoryService()
    const onFallback = vi.fn()

    class FakeFrameReader {
      constructor(_frame: { numRows: number }) {}
      toRecords() {
        return [{ meta: { namespace: 'facts' }, value: { text: 'ignored' } }]
      }
    }

    const loadArrowRuntime = vi.fn(async (): Promise<ArrowMemoryRuntime> => ({
      extendMemoryServiceWithArrow: () => ({
        exportFrame: async () => ({ numRows: 1 }),
      }),
      selectMemoriesByBudget: vi.fn(() => []),
      phaseWeightedSelection: vi.fn(() => []),
      FrameReader: FakeFrameReader,
    }))

    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 100,
        maxMemoryFraction: 0.1,
        minResponseReserve: 1_000_000, // forces remaining below zero
      },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
      onFallback,
    })

    await loader.load([new HumanMessage('hello')])

    expect(onFallback).toHaveBeenCalledWith('budget_zero', 0, 0)
  })
})

describe('AgentMemoryContextLoader FrozenSnapshot integration (P4 Task 3)', () => {
  it('returns frozen context immediately when snapshot is active', async () => {
    const memory = createMemoryService()
    const frozenSnapshot = {
      isActive: vi.fn(() => true),
      get: vi.fn(() => '## Memory Context\n- frozen fact'),
      freeze: vi.fn(),
      shouldInvalidate: vi.fn(() => false),
      thaw: vi.fn(),
    }

    const loader = new AgentMemoryContextLoader({
      instructions: 'Base',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      frozenSnapshot: frozenSnapshot as unknown as FrozenSnapshot,
    })

    const result = await loader.load([new HumanMessage('hello')])
    expect(result.context).toBe('## Memory Context\n- frozen fact')
    expect(memory.get).not.toHaveBeenCalled()
    expect(frozenSnapshot.get).toHaveBeenCalledTimes(1)
  })

  it('freezes snapshot after successful Arrow load', async () => {
    const memory = createMemoryService()
    const frozenSnapshot = {
      isActive: vi.fn(() => false),
      get: vi.fn(),
      freeze: vi.fn(),
      shouldInvalidate: vi.fn(),
      thaw: vi.fn(),
    }

    class FakeFrameReader {
      constructor(_frame: unknown) {}
      toRecords() {
        return [{ meta: { namespace: 'facts' }, value: { text: 'fact' } }]
      }
    }

    const loadArrowRuntime = vi.fn(async (): Promise<ArrowMemoryRuntime> => ({
      extendMemoryServiceWithArrow: () => ({
        exportFrame: async () => ({ numRows: 1 }),
      }),
      selectMemoriesByBudget: vi.fn(() => [{ rowIndex: 0 }]),
      phaseWeightedSelection: vi.fn(() => []),
      FrameReader: FakeFrameReader,
    }))

    const loader = new AgentMemoryContextLoader({
      instructions: 'Base',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 10_000,
        maxMemoryFraction: 1,
        minResponseReserve: 0,
      },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
      frozenSnapshot: frozenSnapshot as unknown as FrozenSnapshot,
    })

    await loader.load([new HumanMessage('hello')])
    expect(frozenSnapshot.freeze).toHaveBeenCalledTimes(1)
  })
})
