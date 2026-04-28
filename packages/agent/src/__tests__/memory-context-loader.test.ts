import { HumanMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import type { FrozenSnapshot } from '@dzupagent/context'
import { estimateTokens } from '@dzupagent/core'

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

  it('bounds standard memory context when Arrow loading fails', async () => {
    const records = Array.from({ length: 100 }, (_, i) => ({
      text: `record-${i} ${'large-memory-payload '.repeat(200)}`,
    }))
    const memory = {
      get: vi.fn(async () => records),
      formatForPrompt: vi.fn((
        input: Array<Record<string, unknown>>,
        options?: { maxItems?: number; maxCharsPerItem?: number },
      ) => {
        const maxItems = options?.maxItems ?? input.length
        const maxCharsPerItem = options?.maxCharsPerItem ?? Number.MAX_SAFE_INTEGER
        const lines = input.slice(0, maxItems).map((record) => {
          const text = String(record['text'] ?? '')
          return `- ${text.slice(0, maxCharsPerItem)}`
        })
        return `## Memory Context\n${lines.join('\n')}`
      }),
    }

    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 2_000,
        maxMemoryFraction: 0.1,
        minResponseReserve: 0,
      },
      estimateConversationTokens: () => 0,
      loadArrowRuntime: async () => {
        throw new Error('Arrow unavailable')
      },
    })

    const result = await loader.load([new HumanMessage('hello')])

    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({
        maxItems: 10,
        maxCharsPerItem: expect.any(Number),
      }),
    )
    expect(result.context).not.toBeNull()
    expect(estimateTokens(result.context!)).toBeLessThanOrEqual(200)
    expect(result.context).not.toContain('record-10')
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

    expect(onFallback).toHaveBeenCalledWith('arrow_fallback', expect.any(Number), 0)
  })

  it('invokes onFallbackDetail with arrow_runtime_failure when Arrow path throws', async () => {
    const memory = createMemoryService()
    const onFallbackDetail = vi.fn()
    const loader = new AgentMemoryContextLoader({
      instructions: 'instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: { currentPhase: 'general' },
      estimateConversationTokens: () => 0,
      loadArrowRuntime: async () => {
        throw new Error('Arrow unavailable')
      },
      onFallbackDetail,
    })

    await loader.load([new HumanMessage('hello')])

    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'arrow_runtime_failure',
        detail: 'Arrow unavailable',
        namespace: 'facts',
        provider: 'arrow',
        tokensBefore: expect.any(Number),
        tokensAfter: 0,
      }),
    )
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

    expect(onFallback).toHaveBeenCalledWith('budget_zero', expect.any(Number), 0)
  })

  it('invokes onFallbackDetail with memory_budget_zero including token diagnostics', async () => {
    const memory = createMemoryService()
    const onFallbackDetail = vi.fn()

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
      instructions: 'some instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 100,
        maxMemoryFraction: 0.1,
        minResponseReserve: 1_000_000,
      },
      estimateConversationTokens: () => 50,
      loadArrowRuntime,
      onFallbackDetail,
    })

    await loader.load([new HumanMessage('hello')])

    expect(onFallbackDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'memory_budget_zero',
        namespace: 'facts',
        provider: 'arrow',
        tokensBefore: expect.any(Number),
        tokensAfter: 0,
      }),
    )
    const call = onFallbackDetail.mock.calls[0][0] as { detail: string }
    expect(call.detail).toContain('totalBudget=100')
    expect(call.detail).toContain('minResponseReserve=1000000')
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
