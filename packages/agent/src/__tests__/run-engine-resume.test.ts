import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { RunJournalEntry } from '@dzupagent/core'
import type { DzupAgentConfig, GenerateOptions } from '../agent/agent-types.js'

const { mockCreateToolLoopLearningHook } = vi.hoisted(() => ({
  mockCreateToolLoopLearningHook: vi.fn(),
}))

vi.mock('../agent/tool-loop-learning.js', () => ({
  createToolLoopLearningHook: mockCreateToolLoopLearningHook,
}))

import { prepareRunState } from '../agent/run-engine.js'

function mockModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('done')),
  } as unknown as BaseChatModel
}

function journalEntry(partial: {
  type: RunJournalEntry['type']
  seq: number
  data: unknown
}): RunJournalEntry {
  return {
    v: 1,
    seq: partial.seq,
    ts: '2026-04-20T00:00:00.000Z',
    runId: 'run-1',
    type: partial.type,
    data: partial.data,
  } as RunJournalEntry
}

describe('prepareRunState — resume rehydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateToolLoopLearningHook.mockReturnValue(undefined)
  })

  it('returns prepareMessages() result unchanged when _resume is absent', async () => {
    const original: BaseMessage[] = [new HumanMessage('original question')]
    const prepared: BaseMessage[] = [new HumanMessage('prepared question')]
    const model = mockModel()

    const result = await prepareRunState({
      config: {
        id: 'agent-1',
        instructions: '',
        model: 'gpt-4',
      } as DzupAgentConfig,
      resolvedModel: model,
      messages: original,
      options: undefined,
      prepareMessages: vi.fn(async () => ({ messages: prepared })),
      getTools: vi.fn(() => [] as StructuredToolInterface[]),
      bindTools: vi.fn((m: BaseChatModel) => m),
      runBeforeAgentHooks: vi.fn(async () => {}),
    })

    expect(result.preparedMessages).toBe(prepared)
    expect(result.preparedMessages).toHaveLength(1)
    expect(result.preparedMessages[0].content).toBe('prepared question')
  })

  it('rehydrates messages from journal when _resume.lastStateSeq is provided', async () => {
    const entries: RunJournalEntry[] = [
      journalEntry({
        type: 'run_started',
        seq: 1,
        data: { input: 'do task X', agentId: 'agent-1' },
      }),
      journalEntry({
        type: 'step_completed',
        seq: 2,
        data: { stepId: 's1', toolName: 'search', result: 'found results' },
      }),
      journalEntry({
        type: 'step_completed',
        seq: 3,
        data: { stepId: 's2', toolName: 'write_file', result: 'done' },
      }),
      // Beyond lastStateSeq — must be ignored.
      journalEntry({
        type: 'step_completed',
        seq: 4,
        data: { stepId: 's3', toolName: 'future', result: 'nope' },
      }),
    ]

    const mockJournal = {
      getAll: vi.fn(async () => entries),
    }

    const options: GenerateOptions = { _resume: { lastStateSeq: 3 } }
    const model = mockModel()

    const result = await prepareRunState({
      config: {
        id: 'agent-1',
        instructions: '',
        model: 'gpt-4',
      } as DzupAgentConfig,
      resolvedModel: model,
      messages: [],
      options,
      prepareMessages: vi.fn(async (m: BaseMessage[]) => ({ messages: m })),
      getTools: vi.fn(() => [] as StructuredToolInterface[]),
      bindTools: vi.fn((m: BaseChatModel) => m),
      runBeforeAgentHooks: vi.fn(async () => {}),
      journal: mockJournal,
      runId: 'run-1',
    })

    expect(mockJournal.getAll).toHaveBeenCalledWith('run-1')

    const msgs = result.preparedMessages
    // 1 HumanMessage + 2 AIMessages (seq 2 and seq 3 only)
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toBeInstanceOf(HumanMessage)
    expect(msgs[0].content).toBe('do task X')
    expect(msgs[1]).toBeInstanceOf(AIMessage)
    expect(String(msgs[1].content)).toContain('search')
    expect(String(msgs[1].content)).toContain('found results')
    expect(msgs[2]).toBeInstanceOf(AIMessage)
    expect(String(msgs[2].content)).toContain('write_file')
    expect(String(msgs[2].content)).toContain('done')
    // The seq=4 entry must not appear in rehydrated output.
    const joined = msgs.map((m) => String(m.content)).join('\n')
    expect(joined).not.toContain('future')
  })

  it('falls back to extracting HumanMessage content when run_started entry is absent', async () => {
    const entries: RunJournalEntry[] = [
      journalEntry({
        type: 'step_completed',
        seq: 1,
        data: { toolName: 'noop', result: 'ok' },
      }),
    ]

    const mockJournal = { getAll: vi.fn(async () => entries) }
    const prepared: BaseMessage[] = [new HumanMessage('fallback input')]

    const result = await prepareRunState({
      config: { id: 'agent-1', instructions: '', model: 'gpt-4' } as DzupAgentConfig,
      resolvedModel: mockModel(),
      messages: [],
      options: { _resume: { lastStateSeq: 1 } },
      prepareMessages: vi.fn(async () => ({ messages: prepared })),
      getTools: vi.fn(() => []),
      bindTools: vi.fn((m: BaseChatModel) => m),
      runBeforeAgentHooks: vi.fn(async () => {}),
      journal: mockJournal,
      runId: 'run-1',
    })

    expect(result.preparedMessages[0]).toBeInstanceOf(HumanMessage)
    expect(result.preparedMessages[0].content).toBe('fallback input')
  })
})
