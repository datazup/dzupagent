import { HumanMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import type { FrozenSnapshot } from '@dzupagent/context'
import { estimateTokens } from '@dzupagent/core'

import {
  AgentMemoryContextLoader,
  ArrowRuntimeNotInjectedError,
  type ArrowMemoryRuntime,
} from '../agent/memory-context-loader.js'

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
    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      [{ text: 'stored fact' }],
      expect.objectContaining({
        maxItems: 1,
        maxCharsPerItem: 2000,
      }),
    )
  })

  it('applies tight token-derived bounds to standard memory loading', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
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
        return [
          '## Memory Context',
          ...input.slice(0, maxItems).map((record) => {
            const text = String(record['text'] ?? '')
            return `- ${text.slice(0, maxCharsPerItem)}`
          }),
        ].join('\n')
      }),
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 123_600,
    })

    const result = await loader.load([new HumanMessage('hello')])

    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({
        maxItems: 1,
        maxCharsPerItem: expect.any(Number),
      }),
    )
    const options = memory.formatForPrompt.mock.calls[0][1] as {
      maxItems: number
      maxCharsPerItem: number
    }
    expect(options.maxCharsPerItem).toBeLessThan(2000)
    expect(result.context).not.toBeNull()
    expect(estimateTokens(result.context!)).toBeLessThanOrEqual(400)
    expect(result.context).not.toContain('record-1')
  })

  it('keeps default standard memory bounds for large context budgets', async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({ text: `record-${i}` }))
    const memory = createMemoryService()
    memory.get.mockResolvedValueOnce(records)
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
    })

    await loader.load([new HumanMessage('hello')])

    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({
        maxItems: 10,
        maxCharsPerItem: 2000,
      }),
    )
  })

  it('falls back to the legacy standard prompt call when budget estimation fails', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => {
        throw new Error('estimator unavailable')
      },
    })

    await expect(loader.load([new HumanMessage('hello')])).resolves.toMatchObject({
      context: '## Memory Context\n- stored fact',
    })
    expect(memory.formatForPrompt).toHaveBeenCalledWith([{ text: 'stored fact' }])
  })

  it('passes read provenance context through the standard prompt memory path', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
      memoryReadContext: { runId: 'run-standard' },
    })

    await loader.load([new HumanMessage('hello')])

    expect(memory.get).toHaveBeenCalledWith(
      'facts',
      { project: 'demo' },
      undefined,
      { runId: 'run-standard' },
    )
  })

  it('prefers query-aware search for standard prompt memory when available', async () => {
    const memory = {
      get: vi.fn(async () => [{ text: 'fallback fact' }]),
      search: vi.fn(async () => [{ text: 'query matched fact' }]),
      formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
        records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`),
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
      memoryReadContext: { runId: 'run-search' },
    })

    await expect(loader.load([new HumanMessage('find the auth token rule')])).resolves.toMatchObject({
      context: '## Memory Context\n- query matched fact',
    })

    expect(memory.search).toHaveBeenCalledWith(
      'facts',
      { project: 'demo' },
      'find the auth token rule',
      10,
      { runId: 'run-search' },
    )
    expect(memory.get).not.toHaveBeenCalled()
  })

  it('falls back to get when standard prompt memory search rejects', async () => {
    const memory = {
      get: vi.fn(async () => [{ text: 'fallback fact' }]),
      search: vi.fn(async () => {
        throw new Error('search unavailable')
      }),
      formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
        records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`),
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 42,
      memoryReadContext: { runId: 'run-search-fallback' },
    })

    await expect(loader.load([new HumanMessage('find the auth token rule')])).resolves.toMatchObject({
      context: '## Memory Context\n- fallback fact',
    })

    expect(memory.search).toHaveBeenCalledTimes(1)
    expect(memory.get).toHaveBeenCalledWith(
      'facts',
      { project: 'demo' },
      undefined,
      { runId: 'run-search-fallback' },
    )
  })

  it('preserves search result order under tight standard memory bounds', async () => {
    const now = Date.now()
    const relevant = {
      text: 'relevant auth token rotation rule',
      _decay: {
        strength: 0.1,
        accessCount: 0,
        lastAccessedAt: now - 30 * 24 * 60 * 60 * 1000,
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
        halfLifeMs: 1,
      },
    }
    const irrelevant = {
      text: 'irrelevant billing dashboard preference',
      _decay: {
        strength: 1,
        accessCount: 100,
        lastAccessedAt: now,
        createdAt: now,
        halfLifeMs: 30 * 24 * 60 * 60 * 1000,
      },
    }
    const memory = {
      get: vi.fn(async () => [irrelevant, relevant]),
      search: vi.fn(async () => [relevant, irrelevant]),
      formatForPrompt: vi.fn((
        input: Array<Record<string, unknown>>,
        options?: { maxItems?: number; maxCharsPerItem?: number },
      ) => {
        const maxItems = options?.maxItems ?? input.length
        const maxCharsPerItem = options?.maxCharsPerItem ?? Number.MAX_SAFE_INTEGER
        return [
          '## Memory Context',
          ...input.slice(0, maxItems).map((record) => {
            const text = String(record['text'] ?? '')
            return `- ${text.slice(0, maxCharsPerItem)}`
          }),
        ].join('\n')
      }),
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      limits: { standardMaxItems: 1 },
    })

    const result = await loader.load([new HumanMessage('auth token rotation')])

    expect(result.context).toContain('relevant auth token rotation rule')
    expect(result.context).not.toContain('irrelevant billing dashboard preference')
    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      [relevant, irrelevant],
      expect.objectContaining({ maxItems: 1 }),
    )
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

  it('throws when Arrow memory is configured without a runtime injector', async () => {
    const previousRequireInjection = process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION']
    process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION'] = '1'
    const memory = createMemoryService()
    try {
      const loader = new AgentMemoryContextLoader({
        instructions: 'Base instructions',
        memory,
        memoryNamespace: 'facts',
        memoryScope: { project: 'demo' },
        arrowMemory: { currentPhase: 'general' },
        estimateConversationTokens: () => 0,
      })

      await expect(loader.load([new HumanMessage('hello')])).rejects.toBeInstanceOf(
        ArrowRuntimeNotInjectedError,
      )
      expect(memory.get).not.toHaveBeenCalled()
      expect(memory.formatForPrompt).not.toHaveBeenCalled()
    } finally {
      if (previousRequireInjection === undefined) {
        delete process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION']
      } else {
        process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION'] = previousRequireInjection
      }
    }
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
    expect(memory.get).toHaveBeenCalledWith('facts', { project: 'demo' })
    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({
        maxItems: 1,
        maxCharsPerItem: expect.any(Number),
      }),
    )
    expect(result.context).not.toBeNull()
    expect(estimateTokens(result.context!)).toBeLessThanOrEqual(200)
    expect(result.context).not.toContain('record-10')
  })

  it('passes read provenance context through search in the bounded Arrow fallback path', async () => {
    const memory = {
      get: vi.fn(async () => [{ text: 'fallback fact' }]),
      search: vi.fn(async () => [{ text: 'search fallback fact' }]),
      formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
        records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`),
    }
    const loader = new AgentMemoryContextLoader({
      instructions: 'Base instructions',
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
      loadArrowRuntime: async () => {
        throw new Error('Arrow unavailable')
      },
    })

    await loader.load([new HumanMessage('hello')], { runId: 'run-fallback' })

    expect(memory.search).toHaveBeenCalledWith(
      'facts',
      { project: 'demo' },
      'hello',
      10,
      { runId: 'run-fallback' },
    )
    expect(memory.get).not.toHaveBeenCalled()
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

// ─── M-08: per-agent tuneable memory limits ────────────────────────────────

describe('AgentMemoryContextLoader per-agent limits (M-08)', () => {
  function buildMemory(records: Record<string, unknown>[]) {
    return {
      get: vi.fn(async () => records),
      formatForPrompt: vi.fn((
        input: Array<Record<string, unknown>>,
        options?: { maxItems?: number; maxCharsPerItem?: number },
      ) => {
        const maxItems = options?.maxItems ?? input.length
        const maxCharsPerItem = options?.maxCharsPerItem ?? Number.MAX_SAFE_INTEGER
        return [
          '## Memory Context',
          ...input.slice(0, maxItems).map((r) => `- ${String(r['text'] ?? '').slice(0, maxCharsPerItem)}`),
        ].join('\n')
      }),
    }
  }

  it('respects standardMaxItems override — caps records at the supplied limit', async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({ text: `record-${i}` }))
    const memory = buildMemory(records)

    const loader = new AgentMemoryContextLoader({
      instructions: 'instr',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      limits: { standardMaxItems: 5 },
    })

    await loader.load([new HumanMessage('hello')])

    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({ maxItems: 5 }),
    )
  })

  it('respects standardMaxCharsPerItem override — truncates per-record content', async () => {
    const records = [{ text: 'a'.repeat(5_000) }]
    const memory = buildMemory(records)

    const loader = new AgentMemoryContextLoader({
      instructions: 'instr',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      limits: { standardMaxCharsPerItem: 100 },
    })

    await loader.load([new HumanMessage('hello')])

    const callArgs = memory.formatForPrompt.mock.calls[0] as [
      Array<Record<string, unknown>>,
      { maxItems: number; maxCharsPerItem: number },
    ]
    expect(callArgs[1].maxCharsPerItem).toBeLessThanOrEqual(100)
  })

  it('respects standardTotalBudget override — a tiny budget squeezes the memory window', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ text: `record-${i}` }))
    const memory = buildMemory(records)

    // Very small total budget so the memory fraction is tiny.
    const loader = new AgentMemoryContextLoader({
      instructions: 'instr',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      limits: {
        standardTotalBudget: 500,
        standardMaxMemoryFraction: 0.1,
        standardMinResponseReserve: 0,
      },
    })

    await loader.load([new HumanMessage('hello')])

    const callArgs = memory.formatForPrompt.mock.calls[0] as [
      Array<Record<string, unknown>>,
      { maxItems: number; maxCharsPerItem: number },
    ]
    // Budget = 500 * 0.1 = 50 tokens → maxItems is very small
    expect(callArgs[1].maxItems).toBeLessThan(10)
  })

  it('falls back to defaults when limits is omitted', async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({ text: `record-${i}` }))
    const memory = buildMemory(records)

    const loader = new AgentMemoryContextLoader({
      instructions: 'instr',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      estimateConversationTokens: () => 0,
      // no limits field
    })

    await loader.load([new HumanMessage('hello')])

    expect(memory.formatForPrompt).toHaveBeenCalledWith(
      records,
      expect.objectContaining({ maxItems: 10, maxCharsPerItem: 2000 }),
    )
  })

  it('caps Arrow fallback budget via arrowFallbackMaxTokens override', async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({
      text: `record-${i} ${'long text '.repeat(50)}`,
    }))
    const memory = buildMemory(records)

    const loader = new AgentMemoryContextLoader({
      instructions: 'instr',
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 128_000,
        maxMemoryFraction: 0.3,
        minResponseReserve: 0,
      },
      estimateConversationTokens: () => 0,
      loadArrowRuntime: async () => {
        throw new Error('Arrow unavailable')
      },
      limits: { arrowFallbackMaxTokens: 50 },
    })

    const result = await loader.load([new HumanMessage('hello')])
    // With a 50-token ceiling the result must fit within ~200 chars.
    expect(result.context).not.toBeNull()
    expect(result.context!.length).toBeLessThan(500)
  })
})
