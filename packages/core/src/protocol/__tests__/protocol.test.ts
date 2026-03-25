import { describe, it, expect } from 'vitest'
import {
  createMessageId,
  createForgeMessage,
  createResponse,
  createErrorResponse,
  isMessageAlive,
  validateForgeMessage,
} from '../message-factory.js'
import {
  ForgeMessageUriSchema,
  ForgePayloadSchema,
  ForgeMessageSchema,
} from '../message-schemas.js'
import type { ForgeMessage, ForgeMessageId, ForgePayload } from '../message-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<ForgeMessage>): ForgeMessage {
  return {
    id: createMessageId(),
    type: 'request',
    from: 'forge://acme/sender',
    to: 'forge://acme/receiver',
    protocol: 'internal',
    timestamp: new Date().toISOString(),
    payload: { type: 'text', content: 'hello' },
    metadata: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createMessageId
// ---------------------------------------------------------------------------

describe('createMessageId', () => {
  it('generates unique IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(createMessageId())
    }
    expect(ids.size).toBe(100)
  })

  it('returns a non-empty string', () => {
    const id = createMessageId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// createForgeMessage — all payload variants
// ---------------------------------------------------------------------------

describe('createForgeMessage', () => {
  it('creates a text message with defaults', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/agent-a',
      to: 'forge://acme/agent-b',
      payload: { type: 'text', content: 'hello' },
    })
    expect(msg.id).toBeTruthy()
    expect(msg.type).toBe('request')
    expect(msg.protocol).toBe('internal')
    expect(msg.timestamp).toBeTruthy()
    expect(msg.metadata).toEqual({})
    expect(msg.payload).toEqual({ type: 'text', content: 'hello' })
  })

  it('creates a json payload message', () => {
    const msg = createForgeMessage({
      type: 'notification',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'json', data: { foo: 'bar' } },
    })
    expect(msg.payload).toEqual({ type: 'json', data: { foo: 'bar' } })
  })

  it('creates a tool_call payload message', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: {
        type: 'tool_call',
        toolName: 'git_status',
        arguments: { path: '/repo' },
        callId: 'call-001',
      },
    })
    expect(msg.payload.type).toBe('tool_call')
    if (msg.payload.type === 'tool_call') {
      expect(msg.payload.toolName).toBe('git_status')
      expect(msg.payload.callId).toBe('call-001')
    }
  })

  it('creates a tool_result payload message', () => {
    const msg = createForgeMessage({
      type: 'response',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'tool_result', callId: 'call-001', result: { status: 'clean' } },
    })
    expect(msg.payload.type).toBe('tool_result')
  })

  it('creates a task payload message', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: {
        type: 'task',
        taskId: 'task-001',
        description: 'Refactor module',
        context: { priority: 'high' },
      },
    })
    expect(msg.payload.type).toBe('task')
  })

  it('creates a binary payload message', () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    const msg = createForgeMessage({
      type: 'notification',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'binary', mimeType: 'application/octet-stream', data },
    })
    expect(msg.payload.type).toBe('binary')
    if (msg.payload.type === 'binary') {
      expect(msg.payload.data).toEqual(data)
    }
  })

  it('creates an error payload message', () => {
    const msg = createForgeMessage({
      type: 'error',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: {
        type: 'error',
        code: 'PROTOCOL_SEND_FAILED',
        message: 'Connection refused',
      },
    })
    expect(msg.payload.type).toBe('error')
    if (msg.payload.type === 'error') {
      expect(msg.payload.code).toBe('PROTOCOL_SEND_FAILED')
    }
  })

  it('sets correlationId and parentId when provided', () => {
    const parentId = createMessageId()
    const msg = createForgeMessage({
      type: 'response',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'text', content: 'ok' },
      correlationId: 'corr-123',
      parentId,
    })
    expect(msg.correlationId).toBe('corr-123')
    expect(msg.parentId).toBe(parentId)
  })

  it('does not set correlationId/parentId when not provided', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'text', content: 'hi' },
    })
    expect(msg.correlationId).toBeUndefined()
    expect(msg.parentId).toBeUndefined()
  })

  it('respects custom protocol', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'a2a://remote/agent',
      to: 'a2a://remote/other',
      protocol: 'a2a',
      payload: { type: 'text', content: 'hi' },
    })
    expect(msg.protocol).toBe('a2a')
  })

  it('spreads metadata', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/a',
      to: 'forge://acme/b',
      payload: { type: 'text', content: 'hi' },
      metadata: { traceId: 'trace-1', priority: 'high', customField: 42 },
    })
    expect(msg.metadata.traceId).toBe('trace-1')
    expect(msg.metadata.priority).toBe('high')
    expect(msg.metadata.customField).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// createResponse
// ---------------------------------------------------------------------------

describe('createResponse', () => {
  it('links correlationId and swaps from/to', () => {
    const original = makeRequest()
    const resp = createResponse(original, { type: 'text', content: 'pong' })
    expect(resp.type).toBe('response')
    expect(resp.from).toBe(original.to)
    expect(resp.to).toBe(original.from)
    expect(resp.correlationId).toBe(original.id)
    expect(resp.protocol).toBe(original.protocol)
  })

  it('includes optional metadata', () => {
    const original = makeRequest()
    const resp = createResponse(
      original,
      { type: 'text', content: 'ok' },
      { traceId: 'trace-abc' },
    )
    expect(resp.metadata.traceId).toBe('trace-abc')
  })
})

// ---------------------------------------------------------------------------
// createErrorResponse
// ---------------------------------------------------------------------------

describe('createErrorResponse', () => {
  it('creates error payload with correct fields', () => {
    const original = makeRequest()
    const err = createErrorResponse(original, 'PROTOCOL_TIMEOUT', 'Timed out', {
      elapsed: 5000,
    })
    expect(err.type).toBe('error')
    expect(err.from).toBe(original.to)
    expect(err.to).toBe(original.from)
    expect(err.correlationId).toBe(original.id)
    expect(err.payload).toEqual({
      type: 'error',
      code: 'PROTOCOL_TIMEOUT',
      message: 'Timed out',
      details: { elapsed: 5000 },
    })
  })

  it('works without details', () => {
    const original = makeRequest()
    const err = createErrorResponse(original, 'MESSAGE_EXPIRED', 'Message TTL exceeded')
    expect(err.payload.type).toBe('error')
    if (err.payload.type === 'error') {
      expect(err.payload.details).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// isMessageAlive
// ---------------------------------------------------------------------------

describe('isMessageAlive', () => {
  it('returns true for messages without TTL', () => {
    const msg = makeRequest()
    expect(isMessageAlive(msg)).toBe(true)
  })

  it('returns true for fresh messages with TTL', () => {
    const msg = makeRequest({
      metadata: { ttlMs: 60_000 },
    })
    expect(isMessageAlive(msg)).toBe(true)
  })

  it('returns false for expired messages', () => {
    const pastTime = new Date(Date.now() - 10_000).toISOString()
    const msg = makeRequest({
      timestamp: pastTime,
      metadata: { ttlMs: 5_000 },
    })
    expect(isMessageAlive(msg)).toBe(false)
  })

  it('returns true when exactly at TTL boundary (within tolerance)', () => {
    // Message sent 4.9s ago with 5s TTL should be alive
    const pastTime = new Date(Date.now() - 4_900).toISOString()
    const msg = makeRequest({
      timestamp: pastTime,
      metadata: { ttlMs: 5_000 },
    })
    expect(isMessageAlive(msg)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateForgeMessage
// ---------------------------------------------------------------------------

describe('validateForgeMessage', () => {
  it('accepts valid messages', () => {
    const msg = makeRequest()
    const result = validateForgeMessage(msg)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe(msg.id)
    }
  })

  it('rejects null', () => {
    const result = validateForgeMessage(null)
    expect(result.success).toBe(false)
  })

  it('rejects empty object', () => {
    const result = validateForgeMessage({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('rejects message with invalid type', () => {
    const msg = makeRequest()
    const result = validateForgeMessage({ ...msg, type: 'invalid_type' })
    expect(result.success).toBe(false)
  })

  it('rejects message with missing from', () => {
    const msg = makeRequest()
    const { from: _from, ...rest } = msg
    const result = validateForgeMessage(rest)
    expect(result.success).toBe(false)
  })

  it('rejects message with invalid URI in from', () => {
    const msg = makeRequest()
    const result = validateForgeMessage({ ...msg, from: 'not-a-uri' })
    expect(result.success).toBe(false)
  })

  it('rejects message with extra top-level fields (strict)', () => {
    const msg = makeRequest()
    const result = validateForgeMessage({ ...msg, extraField: 'surprise' })
    expect(result.success).toBe(false)
  })

  it('accepts message with extra metadata fields (passthrough)', () => {
    const msg = makeRequest({ metadata: { customKey: 'value' } })
    const result = validateForgeMessage(msg)
    expect(result.success).toBe(true)
  })

  it('never throws', () => {
    expect(() => validateForgeMessage(undefined)).not.toThrow()
    expect(() => validateForgeMessage(42)).not.toThrow()
    expect(() => validateForgeMessage('string')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ForgeMessageUriSchema
// ---------------------------------------------------------------------------

describe('ForgeMessageUriSchema', () => {
  it('accepts forge:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('forge://acme/agent').success).toBe(true)
  })

  it('accepts a2a:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('a2a://remote.host/agent-x').success).toBe(true)
  })

  it('accepts mcp:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('mcp://localhost/tools').success).toBe(true)
  })

  it('accepts http:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('http://example.com/agents/a').success).toBe(true)
  })

  it('accepts https:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('https://example.com/agents/a').success).toBe(true)
  })

  it('accepts ws:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('ws://localhost:8080/ws').success).toBe(true)
  })

  it('accepts grpc:// URIs', () => {
    expect(ForgeMessageUriSchema.safeParse('grpc://localhost:50051/service').success).toBe(true)
  })

  it('rejects URIs with unknown scheme', () => {
    expect(ForgeMessageUriSchema.safeParse('ftp://server/file').success).toBe(false)
  })

  it('rejects empty string', () => {
    expect(ForgeMessageUriSchema.safeParse('').success).toBe(false)
  })

  it('rejects bare hostname', () => {
    expect(ForgeMessageUriSchema.safeParse('example.com').success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ForgePayloadSchema
// ---------------------------------------------------------------------------

describe('ForgePayloadSchema', () => {
  const cases: Array<{ name: string; payload: ForgePayload }> = [
    { name: 'text', payload: { type: 'text', content: 'hello' } },
    { name: 'json', payload: { type: 'json', data: { key: 'value' } } },
    {
      name: 'tool_call',
      payload: {
        type: 'tool_call',
        toolName: 'git_diff',
        arguments: { file: 'a.ts' },
        callId: 'c1',
      },
    },
    {
      name: 'tool_result',
      payload: { type: 'tool_result', callId: 'c1', result: 'ok' },
    },
    {
      name: 'task',
      payload: { type: 'task', taskId: 't1', description: 'Do something' },
    },
    {
      name: 'binary',
      payload: {
        type: 'binary',
        mimeType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      },
    },
    {
      name: 'error',
      payload: {
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Something broke',
      },
    },
  ]

  for (const { name, payload } of cases) {
    it(`validates ${name} payload`, () => {
      const result = ForgePayloadSchema.safeParse(payload)
      expect(result.success).toBe(true)
    })
  }

  it('rejects unknown payload type', () => {
    const result = ForgePayloadSchema.safeParse({ type: 'unknown', data: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects tool_call with empty toolName', () => {
    const result = ForgePayloadSchema.safeParse({
      type: 'tool_call',
      toolName: '',
      arguments: {},
      callId: 'c1',
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: create -> validate
// ---------------------------------------------------------------------------

describe('round-trip: create -> validate', () => {
  it('created message passes validation', () => {
    const msg = createForgeMessage({
      type: 'request',
      from: 'forge://acme/agent-a',
      to: 'a2a://remote/agent-b',
      protocol: 'a2a',
      payload: { type: 'json', data: { action: 'deploy' } },
      metadata: { traceId: 'trace-xyz', priority: 'urgent' },
    })
    const result = validateForgeMessage(msg)
    expect(result.success).toBe(true)
  })

  it('created response passes validation', () => {
    const original = makeRequest()
    const resp = createResponse(original, { type: 'text', content: 'done' })
    const result = validateForgeMessage(resp)
    expect(result.success).toBe(true)
  })

  it('created error response passes validation', () => {
    const original = makeRequest()
    const err = createErrorResponse(original, 'PROTOCOL_SEND_FAILED', 'Failed')
    const result = validateForgeMessage(err)
    expect(result.success).toBe(true)
  })
})
