import { describe, it, expect } from 'vitest'
import { serializeMessage, migrateMessages } from '../snapshot/serialized-message.js'
import type { SerializedMessage } from '../snapshot/serialized-message.js'

describe('serializeMessage', () => {
  describe('null / undefined / string input', () => {
    it('handles null', () => {
      const result = serializeMessage(null)
      expect(result).toEqual({ role: 'user', content: '' })
    })

    it('handles undefined', () => {
      const result = serializeMessage(undefined)
      expect(result).toEqual({ role: 'user', content: '' })
    })

    it('handles string', () => {
      const result = serializeMessage('hello')
      expect(result).toEqual({ role: 'user', content: 'hello' })
    })

    it('handles number (non-object, non-string)', () => {
      const result = serializeMessage(42)
      expect(result).toEqual({ role: 'user', content: '42' })
    })
  })

  describe('role normalization', () => {
    it('normalizes "human" to "user"', () => {
      const result = serializeMessage({ role: 'human', content: 'hi' })
      expect(result.role).toBe('user')
    })

    it('normalizes "ai" to "assistant"', () => {
      const result = serializeMessage({ role: 'ai', content: 'response' })
      expect(result.role).toBe('assistant')
    })

    it('normalizes "function" to "tool"', () => {
      const result = serializeMessage({ role: 'function', content: 'result' })
      expect(result.role).toBe('tool')
    })

    it('normalizes unknown role to "user"', () => {
      const result = serializeMessage({ role: 'unknown_role', content: 'test' })
      expect(result.role).toBe('user')
    })

    it('normalizes undefined role to "user"', () => {
      const result = serializeMessage({ content: 'no role' })
      expect(result.role).toBe('user')
    })

    it('preserves "system" role', () => {
      const result = serializeMessage({ role: 'system', content: 'sys' })
      expect(result.role).toBe('system')
    })

    it('preserves "tool" role', () => {
      const result = serializeMessage({ role: 'tool', content: 'result' })
      expect(result.role).toBe('tool')
    })
  })

  describe('content normalization', () => {
    it('handles string content', () => {
      const result = serializeMessage({ role: 'user', content: 'hello' })
      expect(result.content).toBe('hello')
    })

    it('handles null content', () => {
      const result = serializeMessage({ role: 'user', content: null })
      expect(result.content).toBe('')
    })

    it('handles undefined content', () => {
      const result = serializeMessage({ role: 'user', content: undefined })
      expect(result.content).toBe('')
    })

    it('handles numeric content', () => {
      const result = serializeMessage({ role: 'user', content: 123 })
      expect(result.content).toBe('123')
    })

    it('handles array of strings', () => {
      const result = serializeMessage({ role: 'user', content: ['hello', 'world'] })
      expect(Array.isArray(result.content)).toBe(true)
      const blocks = result.content as Array<{ type: string; text: string }>
      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toEqual({ type: 'text', text: 'hello' })
    })

    it('handles array with text objects', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      })
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('handles array with image objects', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' }],
      })
      const blocks = result.content as Array<{ type: string; url: string; mimeType?: string }>
      expect(blocks[0]).toEqual({ type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' })
    })

    it('handles image without mimeType', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'image', url: 'https://example.com/img.png' }],
      })
      const blocks = result.content as Array<{ type: string; url: string; mimeType?: string }>
      expect(blocks[0]).toEqual({ type: 'image', url: 'https://example.com/img.png' })
      expect(blocks[0]!.mimeType).toBeUndefined()
    })

    it('handles OpenAI-style image_url content', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } }],
      })
      const blocks = result.content as Array<{ type: string; url: string }>
      expect(blocks[0]).toEqual({ type: 'image', url: 'https://example.com/img.jpg' })
    })

    it('handles image_url with invalid nested object (missing url) -- silently dropped', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'image_url', image_url: { detail: 'high' } }], // no url
      })
      // The image_url branch matches but inner url check fails, so item is dropped
      const blocks = result.content as Array<{ type: string }>
      expect(blocks).toHaveLength(0)
    })

    it('handles unknown typed objects as text JSON', () => {
      const result = serializeMessage({
        role: 'user',
        content: [{ type: 'custom', data: 'foo' }],
      })
      const blocks = result.content as Array<{ type: string; text: string }>
      expect(blocks[0]!.type).toBe('text')
      expect(blocks[0]!.text).toContain('custom')
    })

    it('handles non-object array items as text JSON', () => {
      const result = serializeMessage({
        role: 'user',
        content: [null, 42, true],
      })
      const blocks = result.content as Array<{ type: string; text: string }>
      expect(blocks).toHaveLength(3)
      expect(blocks.every(b => b.type === 'text')).toBe(true)
    })
  })

  describe('tool calls extraction', () => {
    it('extracts new-style toolCalls', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
      })
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls![0]).toEqual({ id: 'tc1', name: 'search', arguments: { q: 'test' } })
    })

    it('extracts OpenAI-style tool_calls', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }],
      })
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls![0]!.name).toBe('search')
    })

    it('extracts tool_calls with function.arguments as string', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc1',
          function: { name: 'search', arguments: '{"q":"test"}' },
        }],
      })
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls![0]!.arguments).toEqual({ q: 'test' })
    })

    it('extracts tool_calls with function.arguments as object', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc1',
          function: { name: 'search', arguments: { q: 'test' } },
        }],
      })
      expect(result.toolCalls![0]!.arguments).toEqual({ q: 'test' })
    })

    it('handles unparseable function.arguments string', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tc1',
          function: { name: 'search', arguments: 'not json' },
        }],
      })
      expect(result.toolCalls![0]!.arguments).toEqual({ raw: 'not json' })
    })

    it('generates fallback id for tool calls without id', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'test', arguments: {} }],
      })
      expect(result.toolCalls![0]!.id).toBe('call_0')
    })

    it('uses arguments field from tool_calls', () => {
      const result = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'test', arguments: { x: 1 } }],
      })
      expect(result.toolCalls![0]!.arguments).toEqual({ x: 1 })
    })
  })

  describe('tool call ID and metadata', () => {
    it('extracts tool_call_id', () => {
      const result = serializeMessage({
        role: 'tool',
        content: 'result',
        tool_call_id: 'tc1',
      })
      expect(result.toolCallId).toBe('tc1')
    })

    it('extracts toolCallId (camelCase)', () => {
      const result = serializeMessage({
        role: 'tool',
        content: 'result',
        toolCallId: 'tc2',
      })
      expect(result.toolCallId).toBe('tc2')
    })

    it('extracts name as metadata', () => {
      const result = serializeMessage({
        role: 'tool',
        content: 'result',
        name: 'my_tool',
      })
      expect(result.metadata).toEqual({ name: 'my_tool' })
    })
  })

  describe('LangChain BaseMessage format', () => {
    it('handles LangChain message with _getType', () => {
      const langMsg = {
        _getType: () => 'ai',
        content: 'Hello from assistant',
      }
      const result = serializeMessage(langMsg)
      expect(result.role).toBe('assistant')
      expect(result.content).toBe('Hello from assistant')
    })

    it('handles LangChain message with tool_calls', () => {
      const langMsg = {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'test' } }],
      }
      const result = serializeMessage(langMsg)
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls![0]).toEqual({ id: 'tc1', name: 'search', arguments: { q: 'test' } })
    })

    it('handles LangChain message with tool_call_id', () => {
      const langMsg = {
        _getType: () => 'tool',
        content: 'result data',
        tool_call_id: 'tc1',
      }
      const result = serializeMessage(langMsg)
      expect(result.toolCallId).toBe('tc1')
    })

    it('handles LangChain message with name', () => {
      const langMsg = {
        _getType: () => 'tool',
        content: 'result',
        name: 'my_tool',
      }
      const result = serializeMessage(langMsg)
      expect(result.metadata).toEqual({ name: 'my_tool' })
    })

    it('generates fallback id for LangChain tool_calls without id', () => {
      const langMsg = {
        _getType: () => 'ai',
        content: '',
        tool_calls: [{ name: 'search', args: { q: 'test' } }],
      }
      const result = serializeMessage(langMsg)
      expect(result.toolCalls![0]!.id).toBe('call_0')
    })
  })
})

describe('migrateMessages', () => {
  it('migrates an array of mixed messages', () => {
    const results = migrateMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'human', content: 'Hi' },
      { role: 'ai', content: 'Hello!' },
      'plain string',
      null,
    ])

    expect(results).toHaveLength(5)
    expect(results[0]!.role).toBe('system')
    expect(results[1]!.role).toBe('user')
    expect(results[2]!.role).toBe('assistant')
    expect(results[3]!.role).toBe('user')
    expect(results[3]!.content).toBe('plain string')
    expect(results[4]!.role).toBe('user')
    expect(results[4]!.content).toBe('')
  })

  it('handles empty array', () => {
    expect(migrateMessages([])).toEqual([])
  })
})
