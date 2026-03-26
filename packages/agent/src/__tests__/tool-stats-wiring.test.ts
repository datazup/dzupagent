import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop } from '../agent/tool-loop.js'

// ---------- Helpers ----------

function mockTool(name: string, result = 'ok') {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}

function createMockModel(responses: AIMessage[]): BaseChatModel {
  let callIdx = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[callIdx] ?? new AIMessage('done')
      callIdx++
      return resp
    }),
  } as unknown as BaseChatModel
}

function aiWithToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map((c, i) => ({
    id: `call_${i}`,
    name: c.name,
    args: c.args,
  }))
  return msg
}

// ---------- Tests ----------

describe('ToolStatsTracker wiring into tool loop', () => {
  it('calls formatAsPromptHint and injects result as SystemMessage', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools for this task:\n1. read_file (95% success)'),
    }

    const model = createMockModel([new AIMessage('final answer')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('hello')],
      [],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // formatAsPromptHint should have been called with limit=5
    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5)

    // The messages should contain a SystemMessage with the hint
    const systemMsgs = result.messages.filter(m => m._getType() === 'system')
    const hintMsg = systemMsgs.find(
      m => typeof m.content === 'string' && m.content.includes('Preferred tools'),
    )
    expect(hintMsg).toBeDefined()
    expect(typeof hintMsg!.content === 'string' && hintMsg!.content).toContain('read_file')
  })

  it('does not inject SystemMessage when hint is empty', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => ''),
    }

    const model = createMockModel([new AIMessage('done')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('hi')],
      [],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5)

    // No system message should have been injected (only user + AI messages)
    const systemMsgs = result.messages.filter(m => m._getType() === 'system')
    expect(systemMsgs).toHaveLength(0)
  })

  it('injects hint only on first iteration, not every loop', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools for this task:\n1. search (90% success)'),
    }

    const tool = mockTool('search')

    // Model calls a tool on first iteration, then returns final answer
    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { q: 'test' } }]),
      aiWithToolCalls([{ name: 'search', args: { q: 'more' } }]),
      new AIMessage('found it'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('find stuff')],
      [tool],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // formatAsPromptHint should be called exactly once (before first iteration)
    expect(tracker.formatAsPromptHint).toHaveBeenCalledTimes(1)

    // Only one system message with the hint should exist in the conversation
    const hintMsgs = result.messages.filter(
      m => m._getType() === 'system'
        && typeof m.content === 'string'
        && m.content.includes('Preferred tools'),
    )
    expect(hintMsgs).toHaveLength(1)

    expect(result.stopReason).toBe('complete')
  })

  it('onToolLatency still fires when toolStatsTracker is provided', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools:\n1. read (100% success)'),
    }
    const latencies: Array<{ name: string; durationMs: number }> = []

    const tool = mockTool('read')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'read', args: {} }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        toolStatsTracker: tracker,
        onToolLatency: (name, durationMs) => {
          latencies.push({ name, durationMs })
        },
      },
    )

    expect(latencies).toHaveLength(1)
    expect(latencies[0]!.name).toBe('read')
    expect(latencies[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('passes messages with hint to the model on first invocation', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools:\n1. write (80% success)'),
    }

    const invokeFn = vi.fn(async () => new AIMessage('ok'))
    const model = { invoke: invokeFn } as unknown as BaseChatModel

    await runToolLoop(
      model,
      [new HumanMessage('test')],
      [],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // The model should have been called with messages that include the hint
    const calledMessages = invokeFn.mock.calls[0]![0] as BaseMessage[]
    const systemMsg = calledMessages.find(
      m => m._getType() === 'system' && typeof m.content === 'string' && m.content.includes('Preferred tools'),
    )
    expect(systemMsg).toBeDefined()
  })
})
