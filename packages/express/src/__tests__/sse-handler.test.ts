import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { AgentStreamEvent } from '@dzupagent/agent'
import { SSEHandler } from '../sse-handler.js'

interface MockResponseState {
  statusCode: number
  headers: Record<string, string>
  chunks: string[]
  writableEnded: boolean
}

function createMockResponse(): { res: Response; state: MockResponseState } {
  const state: MockResponseState = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
  }

  const res = {
    writableEnded: false,
    writeHead: (status: number, headers: Record<string, string>) => {
      state.statusCode = status
      state.headers = headers
    },
    write: (chunk: string) => {
      state.chunks.push(chunk)
      return true
    },
    end: () => {
      state.writableEnded = true
      ;(res as { writableEnded: boolean }).writableEnded = true
    },
  } as unknown as Response

  return { res, state }
}

function createMockRequest(): Request {
  return new EventEmitter() as unknown as Request
}

async function* streamFromEvents(
  events: AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  for (const event of events) {
    yield event
  }
}

describe('SSEHandler', () => {
  it('initStream sets expected SSE headers', () => {
    const handler = new SSEHandler()
    const { res, state } = createMockResponse()

    handler.initStream(res)

    expect(state.statusCode).toBe(200)
    expect(state.headers['Content-Type']).toBe('text/event-stream')
    expect(state.headers['Cache-Control']).toBe('no-cache')
    expect(state.headers['Connection']).toBe('keep-alive')
  })

  it('streamAgent emits chunk and done events and returns final result', async () => {
    const handler = new SSEHandler({ keepAliveMs: 60_000 })
    const { res, state } = createMockResponse()
    const req = createMockRequest()

    const result = await handler.streamAgent(
      streamFromEvents([
        { type: 'text', data: { content: 'Hello' } } as AgentStreamEvent,
        { type: 'tool_call', data: { name: 'search', args: { q: 'x' } } } as AgentStreamEvent,
        { type: 'done', data: { content: 'Hello' } } as AgentStreamEvent,
      ]),
      res,
      req,
    )

    const output = state.chunks.join('')
    expect(output).toContain('event: chunk')
    expect(output).toContain('event: tool_call')
    expect(output).toContain('event: done')
    expect(result.content).toBe('Hello')
    expect(result.toolCalls).toBe(1)
    expect(state.writableEnded).toBe(true)
  })

  describe('client disconnect during streaming', () => {
    it('stops iteration and calls onDisconnect when client closes connection', async () => {
      const onDisconnect = vi.fn()
      const handler = new SSEHandler({ keepAliveMs: 60_000, onDisconnect })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      // Create an async generator that yields one event, then waits for disconnect
      async function* slowStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        yield { type: 'text', data: { content: 'partial' } } as AgentStreamEvent
        // Simulate client disconnect during iteration
        req.emit('close')
        yield { type: 'text', data: { content: 'should-not-arrive' } } as AgentStreamEvent
      }

      const result = await handler.streamAgent(slowStream(), res, req)

      expect(result.content).toBe('partial')
      expect(onDisconnect).toHaveBeenCalledWith(req)
      expect(state.writableEnded).toBe(true)
    })

    it('does not fire onComplete when client disconnects', async () => {
      const onComplete = vi.fn()
      const handler = new SSEHandler({ keepAliveMs: 60_000, onComplete })
      const { res } = createMockResponse()
      const req = createMockRequest()

      async function* disconnectStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        req.emit('close')
        yield { type: 'text', data: { content: 'x' } } as AgentStreamEvent
      }

      await handler.streamAgent(disconnectStream(), res, req)

      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  describe('error event formatting', () => {
    it('formats error events from agent stream with event type and JSON data', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      await handler.streamAgent(
        streamFromEvents([
          { type: 'error', data: { message: 'Something broke' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      const output = state.chunks.join('')
      expect(output).toContain('event: error')
      expect(output).toContain('"message":"Something broke"')
    })

    it('handles error event with missing message by defaulting to Unknown error', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      await handler.streamAgent(
        streamFromEvents([
          { type: 'error', data: {} } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      const output = state.chunks.join('')
      expect(output).toContain('event: error')
      expect(output).toContain('"message":"Unknown error"')
    })

    it('writes error event and calls onError when agent stream throws', async () => {
      const onError = vi.fn()
      const handler = new SSEHandler({ keepAliveMs: 60_000, onError })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      async function* throwingStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        yield { type: 'text', data: { content: 'ok' } } as AgentStreamEvent
        throw new Error('stream exploded')
      }

      const result = await handler.streamAgent(throwingStream(), res, req)

      const output = state.chunks.join('')
      expect(output).toContain('event: error')
      expect(output).toContain('"message":"stream exploded"')
      expect(onError).toHaveBeenCalledWith(expect.any(Error), req, res)
      expect(result.content).toBe('ok')
      expect(state.writableEnded).toBe(true)
    })

    it('handles non-Error throws by converting to Error', async () => {
      const onError = vi.fn()
      const handler = new SSEHandler({ keepAliveMs: 60_000, onError })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      async function* throwStringStream(): AsyncGenerator<AgentStreamEvent, void, undefined> {
        throw 'raw string error'
      }

      await handler.streamAgent(throwStringStream(), res, req)

      const output = state.chunks.join('')
      expect(output).toContain('"message":"raw string error"')
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'raw string error' }), req, res)
    })
  })

  describe('multiple rapid events in sequence', () => {
    it('processes many text chunks and accumulates content correctly', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      const chunks = Array.from({ length: 50 }, (_, i) => ({
        type: 'text' as const,
        data: { content: `chunk${i}` },
      })) as AgentStreamEvent[]

      const result = await handler.streamAgent(
        streamFromEvents(chunks),
        res,
        req,
      )

      expect(result.content).toBe(Array.from({ length: 50 }, (_, i) => `chunk${i}`).join(''))
      // Each chunk should produce an SSE event (chunk events + done event)
      const chunkEvents = state.chunks.filter((c) => c.includes('event: chunk'))
      expect(chunkEvents).toHaveLength(50)
    })

    it('handles interleaved tool_call and tool_result events', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([
          { type: 'tool_call', data: { name: 'search', args: { q: 'a' } } } as AgentStreamEvent,
          { type: 'tool_result', data: { name: 'search', result: 'found' } } as AgentStreamEvent,
          { type: 'tool_call', data: { name: 'read', args: { file: 'x' } } } as AgentStreamEvent,
          { type: 'tool_result', data: { name: 'read', result: 'content' } } as AgentStreamEvent,
          { type: 'text', data: { content: 'Summary' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      const output = state.chunks.join('')
      expect(output).toContain('event: tool_call')
      expect(output).toContain('event: tool_result')
      expect(result.toolCalls).toBe(2)
      expect(result.content).toBe('Summary')
    })
  })

  describe('empty and undefined event data handling', () => {
    it('handles text event with empty content string', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([
          { type: 'text', data: { content: '' } } as AgentStreamEvent,
          { type: 'text', data: { content: 'real' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      expect(result.content).toBe('real')
      const chunkEvents = state.chunks.filter((c) => c.includes('event: chunk'))
      expect(chunkEvents).toHaveLength(2)
    })

    it('handles text event with missing content field', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([
          { type: 'text', data: {} } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      // content defaults to '' when not present
      expect(result.content).toBe('')
    })

    it('handles done event content fallback when no text chunks received', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([
          { type: 'done', data: { content: 'fallback content' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      expect(result.content).toBe('fallback content')
    })

    it('ignores done event content when text chunks were already accumulated', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([
          { type: 'text', data: { content: 'streamed' } } as AgentStreamEvent,
          { type: 'done', data: { content: 'different' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      expect(result.content).toBe('streamed')
    })

    it('handles budget_warning and stuck events', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      await handler.streamAgent(
        streamFromEvents([
          { type: 'budget_warning', data: { message: '80% budget used' } } as AgentStreamEvent,
          { type: 'stuck', data: { reason: 'loop detected' } } as AgentStreamEvent,
        ]),
        res,
        req,
      )

      const output = state.chunks.join('')
      expect(output).toContain('event: budget_warning')
      expect(output).toContain('event: stuck')
    })

    it('handles empty agent stream (no events)', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()
      const req = createMockRequest()

      const result = await handler.streamAgent(
        streamFromEvents([]),
        res,
        req,
      )

      expect(result.content).toBe('')
      expect(result.toolCalls).toBe(0)
      expect(state.writableEnded).toBe(true)
    })
  })

  describe('SSEWriter', () => {
    it('write is no-op after end() is called', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()

      const writer = handler.initStream(res)
      writer.writeChunk('before')
      writer.end()
      writer.writeChunk('after')

      const chunkEvents = state.chunks.filter((c) => c.includes('event: chunk'))
      expect(chunkEvents).toHaveLength(1)
    })

    it('end() is idempotent', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res } = createMockResponse()

      const writer = handler.initStream(res)
      writer.end()
      // Second end should not throw
      writer.end()
    })

    it('isConnected returns false after end', async () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res } = createMockResponse()

      const writer = handler.initStream(res)
      expect(writer.isConnected()).toBe(true)
      writer.end()
      expect(writer.isConnected()).toBe(false)
    })

    it('custom formatEvent is used when provided', () => {
      const customFormat = (event: { type: string; data: unknown }) =>
        `CUSTOM:${event.type}:${JSON.stringify(event.data)}\n`
      const handler = new SSEHandler({ keepAliveMs: 60_000, formatEvent: customFormat })
      const { res, state } = createMockResponse()

      const writer = handler.initStream(res)
      writer.writeChunk('hello')
      writer.end()

      expect(state.chunks[0]).toContain('CUSTOM:chunk:')
    })

    it('includes event id when provided', () => {
      const handler = new SSEHandler({ keepAliveMs: 60_000 })
      const { res, state } = createMockResponse()

      const writer = handler.initStream(res)
      writer.write({ type: 'chunk', data: { content: 'x' }, id: 'evt-123' })
      writer.end()

      expect(state.chunks[0]).toContain('id: evt-123')
    })

    it('custom headers are merged with defaults in initStream', () => {
      const handler = new SSEHandler({
        keepAliveMs: 60_000,
        headers: { 'X-Custom': 'value' },
      })
      const { res, state } = createMockResponse()

      handler.initStream(res)

      expect(state.headers['Content-Type']).toBe('text/event-stream')
      expect(state.headers['X-Custom']).toBe('value')
    })
  })
})
