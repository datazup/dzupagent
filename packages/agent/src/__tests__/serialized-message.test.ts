import { describe, it, expect } from 'vitest'
import {
  serializeMessage,
  migrateMessages,
} from '../snapshot/serialized-message.js'
import type { SerializedMessage } from '../snapshot/serialized-message.js'

describe('serializeMessage', () => {
  it('handles a simple user message', () => {
    const result = serializeMessage({ role: 'user', content: 'hello' })
    expect(result).toEqual({ role: 'user', content: 'hello' })
  })

  it('handles an assistant message with tool calls', () => {
    const result = serializeMessage({
      role: 'assistant',
      content: 'Let me read that file.',
      tool_calls: [
        {
          id: 'call_1',
          function: { name: 'read_file', arguments: '{"path": "index.ts"}' },
        },
      ],
    })

    expect(result.role).toBe('assistant')
    expect(result.content).toBe('Let me read that file.')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls![0]).toEqual({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'index.ts' },
    })
  })

  it('handles an assistant with new-style toolCalls', () => {
    const result = serializeMessage({
      role: 'assistant',
      content: 'ok',
      toolCalls: [
        { id: 'tc_1', name: 'search', arguments: { query: 'test' } },
      ],
    })

    expect(result.toolCalls).toEqual([
      { id: 'tc_1', name: 'search', arguments: { query: 'test' } },
    ])
  })

  it('handles a tool message with toolCallId', () => {
    const result = serializeMessage({
      role: 'tool',
      content: 'file contents here',
      tool_call_id: 'call_1',
    })

    expect(result.role).toBe('tool')
    expect(result.toolCallId).toBe('call_1')
  })

  it('handles multimodal content array', () => {
    const result = serializeMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' },
      ],
    })

    expect(result.role).toBe('user')
    expect(Array.isArray(result.content)).toBe(true)
    const content = result.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: 'What is in this image?' })
    expect(content[1]).toEqual({ type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' })
  })

  it('handles OpenAI image_url format', () => {
    const result = serializeMessage({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
      ],
    })

    const content = result.content as Array<{ type: string; url?: string }>
    expect(content[0]).toEqual({ type: 'image', url: 'https://example.com/photo.jpg' })
  })

  it('normalizes legacy role names', () => {
    expect(serializeMessage({ role: 'human', content: 'hi' }).role).toBe('user')
    expect(serializeMessage({ role: 'ai', content: 'hi' }).role).toBe('assistant')
    expect(serializeMessage({ role: 'function', content: 'hi' }).role).toBe('tool')
  })

  it('handles LangChain-style messages with _getType', () => {
    const langMsg = {
      _getType: () => 'ai',
      content: 'response text',
      tool_calls: [
        { id: 'tc_1', name: 'read', args: { path: 'a.ts' } },
      ],
    }

    const result = serializeMessage(langMsg)
    expect(result.role).toBe('assistant')
    expect(result.content).toBe('response text')
    expect(result.toolCalls).toEqual([
      { id: 'tc_1', name: 'read', arguments: { path: 'a.ts' } },
    ])
  })

  it('handles null/undefined input', () => {
    expect(serializeMessage(null).role).toBe('user')
    expect(serializeMessage(undefined).content).toBe('')
  })

  it('handles string input', () => {
    const result = serializeMessage('hello world')
    expect(result).toEqual({ role: 'user', content: 'hello world' })
  })
})

describe('migrateMessages', () => {
  it('migrates an array of mixed-format messages', () => {
    const old = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'human', content: 'hi' },
      { role: 'ai', content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ]

    const migrated = migrateMessages(old)
    expect(migrated).toHaveLength(4)
    expect(migrated[0]!.role).toBe('system')
    expect(migrated[1]!.role).toBe('user')
    expect(migrated[2]!.role).toBe('assistant')
    expect(migrated[2]!.toolCalls).toHaveLength(1)
    expect(migrated[3]!.role).toBe('tool')
    expect(migrated[3]!.toolCallId).toBe('c1')
  })

  it('handles empty array', () => {
    expect(migrateMessages([])).toEqual([])
  })

  it('round-trips serialized messages', () => {
    const original: SerializedMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
      },
      { role: 'tool', content: 'found it', toolCallId: 'tc1' },
    ]

    const migrated = migrateMessages(original)
    expect(migrated[0]!.role).toBe('user')
    expect(migrated[0]!.content).toBe('hello')
    expect(migrated[1]!.toolCalls).toEqual([{ id: 'tc1', name: 'search', arguments: { q: 'test' } }])
    expect(migrated[2]!.toolCallId).toBe('tc1')
  })
})
