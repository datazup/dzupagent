/**
 * Branch-coverage tests for agent/memory-context-loader.ts, targeting:
 *  - short-circuit when memory/scope/namespace is missing
 *  - arrow path zero rows, zero/negative budget, empty selection,
 *    missing record row, record.value without text, custom namespace meta
 *  - fallback to standard path when formatForPrompt returns ''
 */
import { HumanMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentMemoryContextLoader,
  type ArrowMemoryRuntime,
} from '../agent/memory-context-loader.js'

function createMemoryService(opts: { formatValue?: string; getValue?: unknown[] } = {}): {
  get: ReturnType<typeof vi.fn>
  formatForPrompt: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(async () => opts.getValue ?? [{ text: 'stored fact' }]),
    formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
      opts.formatValue != null
        ? opts.formatValue
        : (records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`)),
  }
}

function makeRuntime(opts: {
  numRows?: number
  selected?: Array<{ rowIndex: number }>
  records?: Array<{ meta: { namespace?: string }; value: Record<string, unknown> }>
  usePhaseWeighted?: boolean
}): {
  loadArrowRuntime: () => Promise<ArrowMemoryRuntime>
  phaseWeightedSelection: ReturnType<typeof vi.fn>
  selectMemoriesByBudget: ReturnType<typeof vi.fn>
} {
  const phaseWeightedSelection = vi.fn(() => opts.selected ?? [])
  const selectMemoriesByBudget = vi.fn(() => opts.selected ?? [])
  class FakeFrameReader {
    constructor(_f: unknown) {}
    toRecords(): Array<{ meta: { namespace?: string }; value: Record<string, unknown> }> {
      return opts.records ?? []
    }
  }
  const loadArrowRuntime = vi.fn(async (): Promise<ArrowMemoryRuntime> => ({
    extendMemoryServiceWithArrow: () => ({
      exportFrame: async () => ({ numRows: opts.numRows ?? 2 }),
    }),
    selectMemoriesByBudget,
    phaseWeightedSelection,
    FrameReader: FakeFrameReader,
  }))
  return { loadArrowRuntime, phaseWeightedSelection, selectMemoriesByBudget }
}

describe('AgentMemoryContextLoader — branch coverage', () => {
  it('returns null when memory is not configured', async () => {
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      estimateConversationTokens: () => 0,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('returns null when scope is not configured', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      estimateConversationTokens: () => 0,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('returns null when namespace is not configured', async () => {
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryScope: { p: 'demo' },
      estimateConversationTokens: () => 0,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('standard path returns null when formatForPrompt yields empty string', async () => {
    const memory = createMemoryService({ formatValue: '' })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      estimateConversationTokens: () => 0,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('arrow path returns null when exported frame has zero rows', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime, phaseWeightedSelection } = makeRuntime({ numRows: 0 })

    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { currentPhase: 'coding', totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
    expect(phaseWeightedSelection).not.toHaveBeenCalled()
  })

  it('arrow path returns null when budget becomes <= 0', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime } = makeRuntime({ numRows: 5 })
    const loader = new AgentMemoryContextLoader({
      instructions: 'very '.repeat(10_000),
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: {
        currentPhase: 'coding',
        totalBudget: 100,
        maxMemoryFraction: 0.1,
        minResponseReserve: 1_000_000,
      },
      estimateConversationTokens: () => 500_000,
      loadArrowRuntime,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('arrow path returns null when selected list is empty', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime } = makeRuntime({ numRows: 3, selected: [] })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { currentPhase: 'coding', totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({ context: null })
  })

  it('arrow path uses selectMemoriesByBudget when phase is undefined', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime, phaseWeightedSelection, selectMemoriesByBudget } = makeRuntime({
      numRows: 3,
      selected: [{ rowIndex: 0 }],
      records: [{ meta: {}, value: { text: 'no-phase' } }],
    })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({
      context: '## Memory Context\n- [ns] no-phase',
    })
    expect(selectMemoriesByBudget).toHaveBeenCalled()
    expect(phaseWeightedSelection).not.toHaveBeenCalled()
  })

  it('arrow path uses selectMemoriesByBudget when phase is "general"', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime, phaseWeightedSelection, selectMemoriesByBudget } = makeRuntime({
      numRows: 3,
      selected: [{ rowIndex: 0 }],
      records: [{ meta: { namespace: 'custom-ns' }, value: { text: 'stored' } }],
    })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { currentPhase: 'general', totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({
      context: '## Memory Context\n- [custom-ns] stored',
    })
    expect(selectMemoriesByBudget).toHaveBeenCalled()
    expect(phaseWeightedSelection).not.toHaveBeenCalled()
  })

  it('arrow path skips selected rows that have no matching record', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime } = makeRuntime({
      numRows: 3,
      selected: [{ rowIndex: 0 }, { rowIndex: 99 }, { rowIndex: 1 }],
      records: [
        { meta: {}, value: { text: 'first' } },
        { meta: { namespace: 'other' }, value: { text: 'second' } },
      ],
    })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    const out = await loader.load([new HumanMessage('hi')])
    expect(out.context).toContain('[ns] first')
    expect(out.context).toContain('[other] second')
    expect(out.context?.split('\n').length).toBe(3) // header + 2 kept rows
  })

  it('arrow path stringifies value when text is not a string', async () => {
    const memory = createMemoryService()
    const { loadArrowRuntime } = makeRuntime({
      numRows: 1,
      selected: [{ rowIndex: 0 }],
      records: [{ meta: {}, value: { foo: 'bar', n: 1 } }],
    })
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      arrowMemory: { totalBudget: 10_000, maxMemoryFraction: 1 },
      estimateConversationTokens: () => 0,
      loadArrowRuntime,
    })
    const out = await loader.load([new HumanMessage('hi')])
    expect(out.context).toContain('[ns] {"foo":"bar","n":1}')
  })

  it('uses default loadArrowRuntime when none is provided', async () => {
    // Confirms the default branch: loader constructor with no loader override.
    // We do not actually trigger arrow load; we just exercise the constructor.
    const memory = createMemoryService()
    const loader = new AgentMemoryContextLoader({
      instructions: 'i',
      memory,
      memoryNamespace: 'ns',
      memoryScope: { p: 'demo' },
      estimateConversationTokens: () => 0,
    })
    await expect(loader.load([new HumanMessage('hi')])).resolves.toMatchObject({
      context: '## Memory Context\n- stored fact',
    })
  })
})
