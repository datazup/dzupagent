/**
 * Branch-coverage tests for snapshot/serialized-message.ts.
 * Targets multimodal content normalization, tool-call extraction from
 * multiple wire formats, and role normalization edge cases.
 */
import { describe, it, expect } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import { serializeMessage, migrateMessages } from '../snapshot/serialized-message.js'

describe('serializeMessage — branch coverage', () => {
  describe('null/undefined/primitive inputs', () => {
    it('returns empty user message for null input', () => {
      expect(serializeMessage(null)).toEqual({ role: 'user', content: '' })
    })
    it('returns empty user message for undefined input', () => {
      expect(serializeMessage(undefined)).toEqual({ role: 'user', content: '' })
    })
    it('treats number as user string', () => {
      expect(serializeMessage(42)).toEqual({ role: 'user', content: '42' })
    })
    it('treats boolean as user string', () => {
      expect(serializeMessage(true)).toEqual({ role: 'user', content: 'true' })
    })
    it('treats raw string as user role', () => {
      expect(serializeMessage('hello')).toEqual({ role: 'user', content: 'hello' })
    })
  })

  describe('role normalization via plain objects', () => {
    it('maps "human" to user', () => {
      expect(serializeMessage({ role: 'human', content: 'x' }).role).toBe('user')
    })
    it('maps "ai" to assistant', () => {
      expect(serializeMessage({ role: 'ai', content: 'x' }).role).toBe('assistant')
    })
    it('maps "function" to tool', () => {
      expect(serializeMessage({ role: 'function', content: 'x' }).role).toBe('tool')
    })
    it('defaults unknown role to user', () => {
      expect(serializeMessage({ role: 'mystery', content: 'x' }).role).toBe('user')
    })
    it('defaults missing role to user', () => {
      expect(serializeMessage({ content: 'x' }).role).toBe('user')
    })
  })

  describe('content normalization', () => {
    it('null content becomes empty string', () => {
      expect(serializeMessage({ role: 'user', content: null }).content).toBe('')
    })
    it('undefined content becomes empty string', () => {
      expect(serializeMessage({ role: 'user' }).content).toBe('')
    })
    it('number content is converted to string', () => {
      expect(serializeMessage({ role: 'user', content: 123 }).content).toBe('123')
    })

    it('array content with plain text items is normalized to text blocks', () => {
      const r = serializeMessage({ role: 'user', content: ['hello', 'world'] })
      expect(r.content).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ])
    })

    it('array content with text block objects is preserved', () => {
      const r = serializeMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      })
      expect(r.content).toEqual([{ type: 'text', text: 'hi' }])
    })

    it('array content with image block and mimeType preserves both', () => {
      const r = serializeMessage({
        role: 'user',
        content: [{ type: 'image', url: 'http://x/y.png', mimeType: 'image/png' }],
      })
      expect(r.content).toEqual([{ type: 'image', url: 'http://x/y.png', mimeType: 'image/png' }])
    })

    it('array content with image block without mimeType omits mimeType', () => {
      const r = serializeMessage({
        role: 'user',
        content: [{ type: 'image', url: 'http://x/y.png' }],
      })
      expect(r.content).toEqual([{ type: 'image', url: 'http://x/y.png' }])
    })

    it('array content with OpenAI image_url format is normalized to image block', () => {
      const r = serializeMessage({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://img' } },
        ],
      })
      expect(r.content).toEqual([{ type: 'image', url: 'https://img' }])
    })

    it('ignores image_url block with non-string url', () => {
      const r = serializeMessage({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: null } },
        ],
      })
      expect(r.content).toEqual([])
    })

    it('unknown-type block is stringified to text', () => {
      const r = serializeMessage({
        role: 'user',
        content: [{ type: 'weird', foo: 'bar' }],
      })
      expect(r.content).toEqual([{ type: 'text', text: '{"type":"weird","foo":"bar"}' }])
    })

    it('non-object, non-string array item is JSON-stringified', () => {
      const r = serializeMessage({
        role: 'user',
        content: [123, null],
      })
      // null item hits the else branch: JSON.stringify(null) === 'null'
      expect(r.content).toEqual([
        { type: 'text', text: '123' },
        { type: 'text', text: 'null' },
      ])
    })
  })

  describe('LangChain message handling', () => {
    it('serializes SystemMessage', () => {
      const r = serializeMessage(new SystemMessage('be helpful'))
      expect(r.role).toBe('system')
      expect(r.content).toBe('be helpful')
    })
    it('serializes HumanMessage', () => {
      const r = serializeMessage(new HumanMessage('hi'))
      expect(r.role).toBe('user')
    })
    it('serializes AIMessage with tool_calls', () => {
      const ai = new AIMessage({
        content: 'calling',
        tool_calls: [{ id: 'tc1', name: 'search', args: { q: 'cats' } }],
      })
      const r = serializeMessage(ai)
      expect(r.role).toBe('assistant')
      expect(r.toolCalls).toEqual([{ id: 'tc1', name: 'search', arguments: { q: 'cats' } }])
    })
    it('serializes AIMessage without tool_calls (no toolCalls field)', () => {
      const ai = new AIMessage('plain')
      const r = serializeMessage(ai)
      expect(r.toolCalls).toBeUndefined()
    })
    it('serializes ToolMessage with tool_call_id', () => {
      const r = serializeMessage(new ToolMessage({ content: 'result', tool_call_id: 'tc1' }))
      expect(r.role).toBe('tool')
      expect(r.toolCallId).toBe('tc1')
    })
    it('assigns placeholder tool call id when missing', () => {
      const ai = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'a', args: {} },
          { name: 'b', args: {} },
        ],
      })
      const r = serializeMessage(ai)
      expect(r.toolCalls?.[0]?.id).toBe('call_0')
      expect(r.toolCalls?.[1]?.id).toBe('call_1')
    })
  })

  describe('OpenAI plain object tool_calls', () => {
    it('parses OpenAI-style tool_calls with function.arguments as JSON string', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'abc', function: { name: 'search', arguments: '{"q":"cats"}' } },
        ],
      })
      expect(r.toolCalls).toEqual([
        { id: 'abc', name: 'search', arguments: { q: 'cats' } },
      ])
    })

    it('falls back to raw string when function.arguments is invalid JSON', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'search', arguments: 'not-json' } },
        ],
      })
      expect(r.toolCalls?.[0]?.arguments).toEqual({ raw: 'not-json' })
    })

    it('uses function.arguments directly when it is already an object', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'search', arguments: { q: 'x' } } },
        ],
      })
      expect(r.toolCalls?.[0]?.arguments).toEqual({ q: 'x' })
    })

    it('prefers top-level arguments over function.arguments', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          { name: 'x', arguments: { top: 1 }, function: { arguments: '{"bot":2}' } },
        ],
      })
      expect(r.toolCalls?.[0]?.arguments).toEqual({ top: 1 })
    })

    it('uses args when arguments is missing', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
          { name: 'x', args: { used: true } },
        ],
      })
      expect(r.toolCalls?.[0]?.arguments).toEqual({ used: true })
    })

    it('defaults to empty object when no arguments found', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'x' }],
      })
      expect(r.toolCalls?.[0]?.arguments).toEqual({})
    })

    it('assigns call_0, call_1 as fallback ids for OpenAI-style tool_calls', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'a' }, { name: 'b' }],
      })
      expect(r.toolCalls?.map(tc => tc.id)).toEqual(['call_0', 'call_1'])
    })

    it('prefers new-style toolCalls over OpenAI tool_calls when both are present', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'new', name: 'n', arguments: {} }],
        tool_calls: [{ id: 'old', name: 'o' }],
      })
      expect(r.toolCalls).toEqual([{ id: 'new', name: 'n', arguments: {} }])
    })

    it('new-style toolCalls fills defaults for missing name/arguments', () => {
      const r = serializeMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{}],
      })
      expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'unknown', arguments: {} }])
    })

    it('ignores empty tool_calls array', () => {
      const r = serializeMessage({ role: 'assistant', content: '', tool_calls: [] })
      expect(r.toolCalls).toBeUndefined()
    })

    it('reads toolCallId from tool_call_id or toolCallId', () => {
      expect(serializeMessage({ role: 'tool', content: '', tool_call_id: 't1' }).toolCallId).toBe('t1')
      expect(serializeMessage({ role: 'tool', content: '', toolCallId: 't2' }).toolCallId).toBe('t2')
    })

    it('attaches metadata.name when name is present on object', () => {
      const r = serializeMessage({ role: 'user', content: 'hi', name: 'Alice' })
      expect(r.metadata).toEqual({ name: 'Alice' })
    })

    it('does not attach metadata when name is absent', () => {
      const r = serializeMessage({ role: 'user', content: 'hi' })
      expect(r.metadata).toBeUndefined()
    })
  })

  describe('migrateMessages', () => {
    it('maps mixed array through serializeMessage', () => {
      const out = migrateMessages([
        null,
        'hello',
        { role: 'ai', content: 'hi' },
        new SystemMessage('sys'),
      ])
      expect(out).toHaveLength(4)
      expect(out[0]?.role).toBe('user')
      expect(out[1]?.content).toBe('hello')
      expect(out[2]?.role).toBe('assistant')
      expect(out[3]?.role).toBe('system')
    })

    it('handles empty array', () => {
      expect(migrateMessages([])).toEqual([])
    })
  })
})
