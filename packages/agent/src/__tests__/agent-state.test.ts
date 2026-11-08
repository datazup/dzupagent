import { describe, it, expect } from 'vitest'
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages'
import {
  serializeMessages,
  deserializeMessages,
} from '../agent/agent-state.js'
import type { SerializedMessage } from '../agent/agent-state.js'
import { formatSummaryContext } from '@dzupagent/context'
import { buildPreparedMessages } from '../agent/message-utils.js'

describe('serializeMessages', () => {
  it('serializes system message', () => {
    const messages = [new SystemMessage('You are helpful')]
    const result = serializeMessages(messages)

    expect(result).toEqual([{ role: 'system', content: 'You are helpful' }])
  })

  it('serializes human message', () => {
    const messages = [new HumanMessage('Hello')]
    const result = serializeMessages(messages)

    expect(result).toEqual([{ role: 'human', content: 'Hello' }])
  })

  it('serializes AI message', () => {
    const messages = [new AIMessage('Hi there')]
    const result = serializeMessages(messages)

    expect(result).toEqual([{ role: 'ai', content: 'Hi there' }])
  })

  it('serializes tool message with tool_call_id', () => {
    const messages = [
      new ToolMessage({
        content: 'file contents',
        tool_call_id: 'call-123',
        name: 'read_file',
      }),
    ]
    const result = serializeMessages(messages)

    expect(result).toEqual([
      {
        role: 'tool',
        content: 'file contents',
        name: 'read_file',
        toolCallId: 'call-123',
      },
    ])
  })

  it('serializes a mixed conversation', () => {
    const messages = [
      new SystemMessage('system prompt'),
      new HumanMessage('user input'),
      new AIMessage('assistant reply'),
      new ToolMessage({ content: 'tool result', tool_call_id: 'tc-1' }),
    ]
    const result = serializeMessages(messages)

    expect(result).toHaveLength(4)
    expect(result[0]!.role).toBe('system')
    expect(result[1]!.role).toBe('human')
    expect(result[2]!.role).toBe('ai')
    expect(result[3]!.role).toBe('tool')
    expect(result[3]!.toolCallId).toBe('tc-1')
  })

  it('serializes empty array', () => {
    expect(serializeMessages([])).toEqual([])
  })

  it('serializes text-only block array content as its joined text (MC-04b)', () => {
    const messages = [
      new HumanMessage({
        content: [{ type: 'text', text: 'hello' }],
      }),
    ]
    const result = serializeMessages(messages)

    // MC-04b: a text-only block array (every block exactly `type` and `text`)
    // serializes as its concatenated text, no longer as JSON.
    expect(result[0]!.content).toBe('hello')
  })

  it('serializes other array content to a JSON string (unchanged, MC-04b)', () => {
    const cases = [
      [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }],
      [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:x' } }],
    ]
    for (const content of cases) {
      const result = serializeMessages([new HumanMessage({ content: content as never })])
      expect(result[0]!.content).toBe(JSON.stringify(content))
    }
  })

  it('preserves the name field on named messages', () => {
    const messages = [new HumanMessage({ content: 'hi', name: 'alice' })]
    const result = serializeMessages(messages)

    expect(result[0]!.name).toBe('alice')
  })

  it('omits name field when not set', () => {
    const messages = [new HumanMessage('hello')]
    const result = serializeMessages(messages)

    expect(result[0]).not.toHaveProperty('name')
  })

  it('omits toolCallId for non-tool messages', () => {
    const messages = [new AIMessage('reply')]
    const result = serializeMessages(messages)

    expect(result[0]).not.toHaveProperty('toolCallId')
  })
})

describe('deserializeMessages', () => {
  it('deserializes system message', () => {
    const serialized: SerializedMessage[] = [
      { role: 'system', content: 'You are helpful' },
    ]
    const result = deserializeMessages(serialized)

    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(SystemMessage)
    expect(result[0]!.content).toBe('You are helpful')
  })

  it('deserializes human message', () => {
    const serialized: SerializedMessage[] = [
      { role: 'human', content: 'Hello' },
    ]
    const result = deserializeMessages(serialized)

    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(HumanMessage)
    expect(result[0]!.content).toBe('Hello')
  })

  it('deserializes AI message', () => {
    const serialized: SerializedMessage[] = [
      { role: 'ai', content: 'Reply' },
    ]
    const result = deserializeMessages(serialized)

    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(AIMessage)
    expect(result[0]!.content).toBe('Reply')
  })

  it('deserializes tool message with toolCallId', () => {
    const serialized: SerializedMessage[] = [
      { role: 'tool', content: 'result', toolCallId: 'tc-1', name: 'search' },
    ]
    const result = deserializeMessages(serialized)

    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(ToolMessage)
    const toolMsg = result[0] as ToolMessage
    expect(toolMsg.content).toBe('result')
    expect(toolMsg.tool_call_id).toBe('tc-1')
    expect(toolMsg.name).toBe('search')
  })

  it('deserializes tool message with missing toolCallId as empty string', () => {
    const serialized: SerializedMessage[] = [
      { role: 'tool', content: 'result' },
    ]
    const result = deserializeMessages(serialized)

    const toolMsg = result[0] as ToolMessage
    expect(toolMsg.tool_call_id).toBe('')
  })

  it('deserializes a full conversation', () => {
    const serialized: SerializedMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'human', content: 'question' },
      { role: 'ai', content: 'answer' },
      { role: 'tool', content: 'data', toolCallId: 'tc' },
    ]
    const result = deserializeMessages(serialized)

    expect(result).toHaveLength(4)
    expect(result[0]).toBeInstanceOf(SystemMessage)
    expect(result[1]).toBeInstanceOf(HumanMessage)
    expect(result[2]).toBeInstanceOf(AIMessage)
    expect(result[3]).toBeInstanceOf(ToolMessage)
  })

  it('deserializes empty array', () => {
    expect(deserializeMessages([])).toEqual([])
  })

  it('preserves name field on deserialized messages', () => {
    const serialized: SerializedMessage[] = [
      { role: 'human', content: 'hi', name: 'bob' },
    ]
    const result = deserializeMessages(serialized)

    expect(result[0]!.name).toBe('bob')
  })
})

describe('serialize/deserialize round-trip', () => {
  it('round-trips string content messages', () => {
    const original = [
      new SystemMessage('system'),
      new HumanMessage('user input'),
      new AIMessage('ai response'),
    ]

    const serialized = serializeMessages(original)
    const deserialized = deserializeMessages(serialized)

    expect(deserialized).toHaveLength(3)
    expect(deserialized[0]).toBeInstanceOf(SystemMessage)
    expect(deserialized[0]!.content).toBe('system')
    expect(deserialized[1]).toBeInstanceOf(HumanMessage)
    expect(deserialized[1]!.content).toBe('user input')
    expect(deserialized[2]).toBeInstanceOf(AIMessage)
    expect(deserialized[2]!.content).toBe('ai response')
  })

  it('round-trips tool messages with tool_call_id', () => {
    const original = [
      new ToolMessage({ content: 'output', tool_call_id: 'call-42', name: 'exec' }),
    ]

    const serialized = serializeMessages(original)
    const deserialized = deserializeMessages(serialized)

    expect(deserialized).toHaveLength(1)
    const msg = deserialized[0] as ToolMessage
    expect(msg).toBeInstanceOf(ToolMessage)
    expect(msg.content).toBe('output')
    expect(msg.tool_call_id).toBe('call-42')
    expect(msg.name).toBe('exec')
  })

  it('round-trips named messages', () => {
    const original = [new HumanMessage({ content: 'hey', name: 'alice' })]

    const serialized = serializeMessages(original)
    const deserialized = deserializeMessages(serialized)

    expect(deserialized[0]!.name).toBe('alice')
    expect(deserialized[0]!.content).toBe('hey')
  })

  it('handles empty conversation round-trip', () => {
    const serialized = serializeMessages([])
    const deserialized = deserializeMessages(serialized)
    expect(deserialized).toEqual([])
  })

  it('round-trips a prepared block system message (instructions, memory, summary) to the identical former string (MC-04b)', () => {
    const params = {
      baseInstructions: 'You are the agent.\nFollow the rules.',
      memoryContext: '## Memory Context\n- fact one\n',
      conversationSummary: '## Goal\nShip MC-04b.',
    }
    const [system, human] = buildPreparedMessages({ ...params, messages: [new HumanMessage('go')] })
    expect(Array.isArray(system!.content)).toBe(true)
    expect(system!.content).toHaveLength(3)
    // Today's single string for the same inputs.
    const legacy = [
      params.baseInstructions,
      params.memoryContext,
      formatSummaryContext(params.conversationSummary),
    ].join('\n\n')

    const serialized = serializeMessages([system!, human!])
    expect(serialized[0]).toEqual({ role: 'system', content: legacy })
    const restored = deserializeMessages(serialized)
    expect(restored[0]).toBeInstanceOf(SystemMessage)
    expect(restored[0]!.content).toBe(legacy)
    expect(restored[1]!.content).toBe('go')
  })

  it('keeps other array content in its JSON form across a round-trip (MC-04b)', () => {
    const content = [
      { type: 'text', text: 'I', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\nmemo' },
    ]
    const restored = deserializeMessages(serializeMessages([new SystemMessage({ content: content as never })]))
    expect(restored[0]!.content).toBe(JSON.stringify(content))
  })
})
