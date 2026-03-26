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

/** Count hint messages (those starting with the marker prefix). */
function countHintMessages(messages: BaseMessage[]): number {
  return messages.filter(
    m =>
      m._getType() === 'system'
      && typeof m.content === 'string'
      && m.content.startsWith('Tool performance hint:'),
  ).length
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

    // formatAsPromptHint should have been called with limit=5, intent=undefined
    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5, undefined)

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

    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5, undefined)

    // No system message should have been injected (only user + AI messages)
    const systemMsgs = result.messages.filter(m => m._getType() === 'system')
    expect(systemMsgs).toHaveLength(0)
  })

  it('refreshes hint each iteration and never duplicates it', async () => {
    let callCount = 0
    const tracker = {
      formatAsPromptHint: vi.fn(() => {
        callCount++
        return `Preferred tools for this task:\n1. search (${90 + callCount}% success)`
      }),
    }

    const tool = mockTool('search')

    // Model calls a tool on first two iterations, then returns final answer
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

    // formatAsPromptHint should be called once per iteration (3 iterations)
    expect(tracker.formatAsPromptHint).toHaveBeenCalledTimes(3)

    // Only ONE hint SystemMessage should exist in the final conversation
    // (old ones are replaced, not accumulated)
    expect(countHintMessages(result.messages)).toBe(1)

    // The surviving hint should be the last one generated (iteration 3)
    const hintMsg = result.messages.find(
      m =>
        m._getType() === 'system'
        && typeof m.content === 'string'
        && m.content.startsWith('Tool performance hint:'),
    )
    expect(hintMsg).toBeDefined()
    expect(typeof hintMsg!.content === 'string' && hintMsg!.content).toContain('93% success')

    expect(result.stopReason).toBe('complete')
  })

  it('passes intent to formatAsPromptHint when configured', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools for this task:\n1. deploy (88% success)'),
    }

    const model = createMockModel([new AIMessage('deployed')])

    await runToolLoop(
      model,
      [new HumanMessage('deploy app')],
      [],
      { maxIterations: 10, toolStatsTracker: tracker, intent: 'deploy' },
    )

    // Should have been called with the intent
    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5, 'deploy')
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

  it('hint message is placed after system messages, before user messages', async () => {
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'Preferred tools:\n1. code (75% success)'),
    }

    const invokeFn = vi.fn(async () => new AIMessage('ok'))
    const model = { invoke: invokeFn } as unknown as BaseChatModel

    await runToolLoop(
      model,
      [new SystemMessage('You are helpful'), new HumanMessage('hi')],
      [],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    const calledMessages = invokeFn.mock.calls[0]![0] as BaseMessage[]
    // Find hint position
    const hintIdx = calledMessages.findIndex(
      m =>
        m._getType() === 'system'
        && typeof m.content === 'string'
        && m.content.startsWith('Tool performance hint:'),
    )
    expect(hintIdx).toBeGreaterThanOrEqual(0)

    // The system messages should come before the hint, and user messages after
    const humanIdx = calledMessages.findIndex(m => m._getType() === 'human')
    expect(hintIdx).toBeLessThan(humanIdx)
  })

  it('updates hint content across iterations when stats change', async () => {
    // Simulate changing stats across iterations
    let iteration = 0
    const tracker = {
      formatAsPromptHint: vi.fn((_limit?: number, _intent?: string) => {
        iteration++
        if (iteration === 1) return 'Preferred tools for this task:\n1. search (70% success)'
        if (iteration === 2) return 'Preferred tools for this task:\n1. search (85% success)\n2. read (90% success)'
        return 'Preferred tools for this task:\n1. read (95% success)\n2. search (85% success)'
      }),
    }

    const searchTool = mockTool('search')
    const readTool = mockTool('read')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { q: 'a' } }]),
      aiWithToolCalls([{ name: 'read', args: { file: 'b' } }]),
      new AIMessage('done'),
    ])

    // Capture what the model sees each time
    const invokeFn = model.invoke as ReturnType<typeof vi.fn>
    const seenHints: string[] = []
    const originalInvoke = invokeFn.getMockImplementation()!
    invokeFn.mockImplementation(async (msgs: BaseMessage[]) => {
      const hint = msgs.find(
        (m: BaseMessage) =>
          m._getType() === 'system'
          && typeof m.content === 'string'
          && m.content.startsWith('Tool performance hint:'),
      )
      if (hint && typeof hint.content === 'string') {
        seenHints.push(hint.content)
      }
      return originalInvoke(msgs)
    })

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [searchTool, readTool],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // Each iteration should have seen a different hint
    expect(seenHints).toHaveLength(3)
    expect(seenHints[0]).toContain('70% success')
    expect(seenHints[1]).toContain('85% success')
    expect(seenHints[2]).toContain('95% success')
  })
})
