import { describe, it, expect } from 'vitest'
import { JSONSerializer, defaultSerializer } from '../serialization.js'
import { createForgeMessage, createMessageId } from '../message-factory.js'
import type { ForgeMessage, ForgePayload } from '../message-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(payload: ForgePayload): ForgeMessage {
  return createForgeMessage({
    type: 'request',
    from: 'forge://acme/sender',
    to: 'forge://acme/receiver',
    protocol: 'internal',
    payload,
    metadata: { traceId: 'trace-001', spanId: 'span-001' },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JSONSerializer', () => {
  const serializer = new JSONSerializer()

  describe('contentType', () => {
    it('returns application/json', () => {
      expect(serializer.contentType).toBe('application/json')
    })
  })

  describe('round-trip', () => {
    it('preserves text payload', () => {
      const msg = makeMessage({ type: 'text', content: 'hello world' })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)

      expect(result.id).toBe(msg.id)
      expect(result.type).toBe(msg.type)
      expect(result.from).toBe(msg.from)
      expect(result.to).toBe(msg.to)
      expect(result.protocol).toBe(msg.protocol)
      expect(result.timestamp).toBe(msg.timestamp)
      expect(result.payload).toEqual(msg.payload)
      expect(result.metadata.traceId).toBe('trace-001')
      expect(result.metadata.spanId).toBe('span-001')
    })

    it('preserves json payload', () => {
      const msg = makeMessage({ type: 'json', data: { nested: { value: 42 } } })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)
      expect(result.payload).toEqual({ type: 'json', data: { nested: { value: 42 } } })
    })

    it('preserves tool_call payload', () => {
      const msg = makeMessage({
        type: 'tool_call',
        toolName: 'git_status',
        arguments: { path: '/repo', verbose: true },
        callId: 'call-123',
      })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)
      expect(result.payload).toEqual(msg.payload)
    })

    it('preserves tool_result payload', () => {
      const msg = makeMessage({
        type: 'tool_result',
        callId: 'call-123',
        result: { status: 'clean', files: [] },
        isError: false,
      })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)
      expect(result.payload).toEqual(msg.payload)
    })

    it('preserves task payload', () => {
      const msg = makeMessage({
        type: 'task',
        taskId: 'task-001',
        description: 'Refactor module X',
        context: { priority: 'high', tags: ['refactor'] },
      })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)
      expect(result.payload).toEqual(msg.payload)
    })

    it('preserves error payload', () => {
      const msg = makeMessage({
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        details: { stack: 'line 42' },
      })
      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)
      expect(result.payload).toEqual(msg.payload)
    })

    it('preserves ForgeMessageId branded type through round-trip', () => {
      const msg = makeMessage({ type: 'text', content: 'test' })
      const parentId = createMessageId()
      msg.parentId = parentId
      msg.correlationId = 'corr-xyz'

      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)

      expect(result.id).toBe(msg.id)
      expect(result.parentId).toBe(parentId)
      expect(result.correlationId).toBe('corr-xyz')
    })

    it('preserves metadata extension fields', () => {
      const msg = makeMessage({ type: 'text', content: 'test' })
      msg.metadata.customField = 'custom-value'
      msg.metadata.numericField = 99

      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)

      expect(result.metadata.customField).toBe('custom-value')
      expect(result.metadata.numericField).toBe(99)
    })
  })

  describe('binary payload (Uint8Array)', () => {
    it('encodes Uint8Array as base64 and decodes back', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
      const msg = makeMessage({
        type: 'binary',
        mimeType: 'application/octet-stream',
        data,
        description: 'test binary',
      })

      const bytes = serializer.serialize(msg)

      // Verify the serialized form contains base64
      const json = new TextDecoder().decode(bytes)
      expect(json).toContain('__uint8:')

      const result = serializer.deserialize(bytes)
      expect(result.payload.type).toBe('binary')
      if (result.payload.type === 'binary') {
        expect(result.payload.data).toBeInstanceOf(Uint8Array)
        expect(Array.from(result.payload.data)).toEqual([72, 101, 108, 108, 111])
        expect(result.payload.mimeType).toBe('application/octet-stream')
        expect(result.payload.description).toBe('test binary')
      }
    })

    it('handles empty Uint8Array', () => {
      const msg = makeMessage({
        type: 'binary',
        mimeType: 'application/octet-stream',
        data: new Uint8Array(0),
      })

      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)

      if (result.payload.type === 'binary') {
        expect(result.payload.data).toBeInstanceOf(Uint8Array)
        expect(result.payload.data.length).toBe(0)
      }
    })

    it('handles large Uint8Array', () => {
      const data = new Uint8Array(1024)
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256
      }
      const msg = makeMessage({
        type: 'binary',
        mimeType: 'application/octet-stream',
        data,
      })

      const bytes = serializer.serialize(msg)
      const result = serializer.deserialize(bytes)

      if (result.payload.type === 'binary') {
        expect(Array.from(result.payload.data)).toEqual(Array.from(data))
      }
    })
  })

  describe('deserialize validation', () => {
    it('throws on invalid JSON', () => {
      const badBytes = new TextEncoder().encode('not json {{{')
      expect(() => serializer.deserialize(badBytes)).toThrow('Failed to parse JSON')
    })

    it('throws on valid JSON but invalid ForgeMessage', () => {
      const badMessage = new TextEncoder().encode(JSON.stringify({ type: 'invalid' }))
      expect(() => serializer.deserialize(badMessage)).toThrow('Invalid ForgeMessage')
    })

    it('throws on empty input', () => {
      const empty = new Uint8Array(0)
      expect(() => serializer.deserialize(empty)).toThrow()
    })
  })

  describe('serialize output', () => {
    it('returns Uint8Array', () => {
      const msg = makeMessage({ type: 'text', content: 'test' })
      const result = serializer.serialize(msg)
      expect(result).toBeInstanceOf(Uint8Array)
    })

    it('output is valid UTF-8 JSON', () => {
      const msg = makeMessage({ type: 'text', content: 'hello' })
      const bytes = serializer.serialize(msg)
      const text = new TextDecoder().decode(bytes)
      expect(() => JSON.parse(text)).not.toThrow()
    })
  })
})

describe('defaultSerializer', () => {
  it('is a JSONSerializer instance', () => {
    expect(defaultSerializer).toBeInstanceOf(JSONSerializer)
    expect(defaultSerializer.contentType).toBe('application/json')
  })

  it('can serialize and deserialize', () => {
    const msg = makeMessage({ type: 'text', content: 'default test' })
    const bytes = defaultSerializer.serialize(msg)
    const result = defaultSerializer.deserialize(bytes)
    expect(result.payload).toEqual(msg.payload)
  })
})
