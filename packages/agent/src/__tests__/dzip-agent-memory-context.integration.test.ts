import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { DzupAgent } from '../agent/dzip-agent.js'

const mockArrowRuntime = vi.hoisted(() => ({
  extendMemoryServiceWithArrow: vi.fn(),
  selectMemoriesByBudget: vi.fn(),
  phaseWeightedSelection: vi.fn(),
  FrameReader: class {
    private readonly frame: { records: Array<{ meta?: { namespace?: string }; value: Record<string, unknown> }> }

    constructor(frame: { records: Array<{ meta?: { namespace?: string }; value: Record<string, unknown> }> }) {
      this.frame = frame
    }

    toRecords() {
      return this.frame.records
    }
  },
}))

vi.mock('@dzupagent/memory-ipc', () => mockArrowRuntime, { virtual: true })

function createMemoryService() {
  return {
    get: vi.fn(async () => [{ text: 'stored fact' }]),
    formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
      records.length === 0 ? '' : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`),
  }
}

function createModel() {
  const invoke = vi.fn(async (messages: unknown[]) => {
    messages.find((message) => message instanceof SystemMessage)
    return new AIMessage({ content: 'done' })
  })

  return { invoke }
}

describe('DzupAgent generate memory context integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes Arrow-selected memory context in the public generate path', async () => {
    const memory = createMemoryService()
    const model = createModel()

    mockArrowRuntime.extendMemoryServiceWithArrow.mockReturnValue({
      exportFrame: async () => ({
        numRows: 2,
        records: [
          { meta: { namespace: 'facts' }, value: { text: 'ignored' } },
          { meta: { namespace: 'facts' }, value: { text: 'selected fact' } },
        ],
      }),
    })
    mockArrowRuntime.selectMemoriesByBudget.mockReturnValue([{ rowIndex: 1 }])
    mockArrowRuntime.phaseWeightedSelection.mockReturnValue([{ rowIndex: 1 }])

    const agent = new DzupAgent({
      id: 'memory-arrow',
      instructions: 'Base instructions',
      model: model as never,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'coding',
        totalBudget: 10_000,
        maxMemoryFraction: 1,
        minResponseReserve: 0,
      },
    })

    const result = await agent.generate([new HumanMessage('hello')])

    expect(result.content).toBe('done')
    expect(memory.get).not.toHaveBeenCalled()
    expect(mockArrowRuntime.extendMemoryServiceWithArrow).toHaveBeenCalledTimes(1)
    expect(mockArrowRuntime.phaseWeightedSelection).toHaveBeenCalledTimes(1)
    expect(mockArrowRuntime.selectMemoriesByBudget).not.toHaveBeenCalled()

    const callMessages = model.invoke.mock.calls[0]?.[0] as unknown[] | undefined
    expect(callMessages).toBeDefined()
    const systemMessage = callMessages?.find((message) => message instanceof SystemMessage) as SystemMessage | undefined
    expect(systemMessage).toBeDefined()
    expect(systemMessage?.content).toContain('Base instructions')
    expect(systemMessage?.content).toContain('## Memory Context')
    expect(systemMessage?.content).toContain('[facts] selected fact')
  })

  it('falls back to the standard memory path when Arrow setup fails', async () => {
    const memory = createMemoryService()
    const model = createModel()

    mockArrowRuntime.extendMemoryServiceWithArrow.mockImplementation(() => {
      throw new Error('Arrow unavailable')
    })

    const agent = new DzupAgent({
      id: 'memory-fallback',
      instructions: 'Base instructions',
      model: model as never,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
      },
    })

    const result = await agent.generate([new HumanMessage('hello')])

    expect(result.content).toBe('done')
    expect(mockArrowRuntime.extendMemoryServiceWithArrow).toHaveBeenCalledTimes(1)
    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.formatForPrompt).toHaveBeenCalledTimes(1)

    const callMessages = model.invoke.mock.calls[0]?.[0] as unknown[] | undefined
    expect(callMessages).toBeDefined()
    const systemMessage = callMessages?.find((message) => message instanceof SystemMessage) as SystemMessage | undefined
    expect(systemMessage?.content).toContain('Base instructions')
    expect(systemMessage?.content).toContain('## Memory Context')
    expect(systemMessage?.content).toContain('stored fact')
  })
})
