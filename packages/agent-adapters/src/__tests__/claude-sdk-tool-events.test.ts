import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentEvent } from '../types.js'

// Messages below follow the installed Claude Agent SDK shapes (sdk.d.ts):
// SDKAssistantMessage and SDKUserMessage carry Messages API content under
// `message.content`; SDKToolProgressMessage is a heartbeat without `status`.

function asyncIterableOf<T>(items: T[]): AsyncIterable<T> & { interrupt: ReturnType<typeof vi.fn> } {
  return {
    interrupt: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))

const { ClaudeAgentAdapter } = await import('../claude/claude-adapter.js')

const system = { type: 'system', subtype: 'init', session_id: 'sess-sdk', model: 'claude-opus-5-5', tools: ['Read'] }
const result = { type: 'result', subtype: 'success', result: 'Done', session_id: 'sess-sdk', duration_ms: 10 }

function sdkAssistant(content: unknown[]) {
  return {
    type: 'assistant',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: null, usage: {} },
    parent_tool_use_id: null,
    uuid: 'u-a',
    session_id: 'sess-sdk',
  }
}

function sdkUser(content: unknown[]) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: 'u-u',
    session_id: 'sess-sdk',
  }
}

async function run(messages: unknown[]): Promise<AgentEvent[]> {
  mockQuery.mockReturnValue(asyncIterableOf(messages))
  const adapter = new ClaudeAgentAdapter({ interactionPolicy: { mode: 'auto-approve' } })
  const events: AgentEvent[] = []
  for await (const event of adapter.execute({ prompt: 'inspect' })) events.push(event)
  return events
}

describe('Claude SDK tool events (A22-C1-CLAUDE-TOOL-EVENTS-20261015-R1)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps SDK assistant text and tool_use blocks under message.content', async () => {
    const events = await run([
      system,
      sdkAssistant([
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.js' } },
      ]),
      sdkUser([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'line 1' }]),
      result,
    ])

    const message = events.find(e => e.type === 'adapter:message')
    expect(message).toMatchObject({ content: 'Reading the file.', role: 'assistant' })
    const calls = events.filter(e => e.type === 'adapter:tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolName: 'Read', toolCallId: 'toolu_1', input: { file_path: 'a.js' } })
    const results = events.filter(e => e.type === 'adapter:tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolName: 'Read', toolCallId: 'toolu_1', output: 'line 1' })
    expect(events.at(-1)?.type).toBe('adapter:completed')
  })

  it('pairs several tool calls with their results by id and carries is_error', async () => {
    const events = await run([
      system,
      sdkAssistant([{ type: 'tool_use', id: 'toolu_a', name: 'Grep', input: { pattern: 'x' } }]),
      sdkAssistant([{ type: 'tool_use', id: 'toolu_b', name: 'Glob', input: { pattern: '*.js' } }]),
      sdkUser([
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'b.js' }] },
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'no match', is_error: true },
      ]),
      result,
    ])

    const calls = events.filter(e => e.type === 'adapter:tool_call')
    expect(calls.map(e => (e as { toolCallId?: string }).toolCallId)).toEqual(['toolu_a', 'toolu_b'])
    const results = events.filter(e => e.type === 'adapter:tool_result') as Array<AgentEvent & { toolName: string; toolCallId?: string; isError?: boolean; output: string }>
    expect(results.map(e => [e.toolCallId, e.toolName])).toEqual([['toolu_b', 'Glob'], ['toolu_a', 'Grep']])
    expect(results[0]!.output).toContain('b.js')
    expect(results[0]!.isError).toBeUndefined()
    expect(results[1]!.isError).toBe(true)
  })

  it('ignores status-less SDK tool_progress heartbeats and plain user text', async () => {
    const events = await run([
      system,
      sdkAssistant([{ type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: { command: 'node --test' } }]),
      { type: 'tool_progress', tool_use_id: 'toolu_slow', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 12, uuid: 'u-p', session_id: 'sess-sdk' },
      sdkUser([{ type: 'text', text: 'not a tool result' }]),
      sdkUser([{ type: 'tool_result', tool_use_id: 'toolu_slow', content: 'ok' }]),
      result,
    ])

    expect(events.filter(e => e.type === 'adapter:tool_call')).toHaveLength(1)
    const results = events.filter(e => e.type === 'adapter:tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolName: 'Bash', toolCallId: 'toolu_slow', output: 'ok' })
  })

  it('keeps the legacy top-level content shape working', async () => {
    const events = await run([
      system,
      { type: 'assistant', content: [{ type: 'text', text: 'legacy' }] },
      result,
    ])

    expect(events.find(e => e.type === 'adapter:message')).toMatchObject({ content: 'legacy' })
  })
})
