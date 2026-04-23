import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { FrozenSnapshot } from '@dzupagent/context'
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

describe('DzupAgent memoryFrame pass-through (P4 Task 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('threads the Arrow frame from loader into prepareMessages when arrowMemory is configured', async () => {
    const memory = createMemoryService()
    const model = createModel()

    mockArrowRuntime.extendMemoryServiceWithArrow.mockReturnValue({
      exportFrame: async () => ({
        numRows: 1,
        records: [{ meta: { namespace: 'facts' }, value: { text: 'fact' } }],
      }),
    })
    mockArrowRuntime.selectMemoriesByBudget.mockReturnValue([{ rowIndex: 0 }])

    const agent = new DzupAgent({
      id: 'frame-passthrough',
      instructions: 'Base instructions',
      model: model as never,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      arrowMemory: {
        currentPhase: 'general',
        totalBudget: 10_000,
        maxMemoryFraction: 1,
        minResponseReserve: 0,
      },
    })

    // Call the private prepareMessages directly to assert the frame is
    // returned in the result (per-run, not stored on the instance).
    const prepared = await (
      agent as unknown as {
        prepareMessages: (
          msgs: unknown[],
        ) => Promise<{ messages: unknown[]; memoryFrame?: unknown }>
      }
    ).prepareMessages([new HumanMessage('hello')])

    expect(prepared.memoryFrame).not.toBeNull()
    expect(prepared.memoryFrame).toBeDefined()

    // Instance no longer retains memory frame — it must be per-run only.
    expect((agent as unknown as { lastMemoryFrame?: unknown }).lastMemoryFrame).toBeUndefined()
  })
})

describe('DzupAgent frozenSnapshot config wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the configured frozen snapshot to short-circuit memory reloads across generate() calls', async () => {
    const memory = createMemoryService()
    const model = createModel()

    const snapshot = new FrozenSnapshot()
    snapshot.freeze('## Memory Context\n- cached fact')

    const agent = new DzupAgent({
      id: 'frozen-snapshot-agent',
      instructions: 'Base instructions',
      model: model as never,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      frozenSnapshot: snapshot,
    })

    const first = await agent.generate([new HumanMessage('hello')])
    const second = await agent.generate([new HumanMessage('hello again')])

    expect(first.content).toBe('done')
    expect(second.content).toBe('done')

    // Memory service must not be hit — snapshot short-circuits the loader.
    expect(memory.get).not.toHaveBeenCalled()
    expect(memory.formatForPrompt).not.toHaveBeenCalled()

    // Both calls should include the snapshot-supplied context.
    for (const call of model.invoke.mock.calls) {
      const callMessages = call[0] as unknown[]
      const systemMessage = callMessages.find(
        (message) => message instanceof SystemMessage,
      ) as SystemMessage | undefined
      expect(systemMessage).toBeDefined()
      expect(systemMessage?.content).toContain('Base instructions')
      expect(systemMessage?.content).toContain('cached fact')
    }
  })

  it('falls through to the memory service when the snapshot is inactive', async () => {
    const memory = createMemoryService()
    const model = createModel()

    const snapshot = new FrozenSnapshot() // never frozen — isActive() === false

    const agent = new DzupAgent({
      id: 'inactive-snapshot-agent',
      instructions: 'Base instructions',
      model: model as never,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      frozenSnapshot: snapshot,
    })

    const result = await agent.generate([new HumanMessage('hello')])

    expect(result.content).toBe('done')
    // Without arrowMemory, the standard path must run and hit the service.
    expect(memory.get).toHaveBeenCalledTimes(1)
    expect(memory.formatForPrompt).toHaveBeenCalledTimes(1)
  })
})
