import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseSSEEvents, streamA2ATask } from '../a2a-sse-stream.js'
import { A2AClientAdapter } from '../a2a-client-adapter.js'
import type { ForgeMessage } from '../message-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch that returns a ReadableStream of SSE-formatted data.
 */
function createMockSSEFetch(
  sseText: string,
  options?: { status?: number; delay?: number },
): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) => {
    const status = options?.status ?? 200
    if (status !== 200) {
      return new Response(null, { status }) as Response
    }

    const encoder = new TextEncoder()
    const chunks = [encoder.encode(sseText)]

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
}

/**
 * Create a mock fetch that returns SSE chunks with a delay between them.
 */
function createMultiChunkSSEFetch(
  chunks: string[],
): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) => {
    const encoder = new TextEncoder()
    let chunkIndex = 0

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex]
          if (chunk !== undefined) {
            controller.enqueue(encoder.encode(chunk))
          }
          chunkIndex++
        } else {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
}

/**
 * Collect all messages from an async iterable.
 */
async function collectMessages(
  iterable: AsyncIterable<ForgeMessage>,
): Promise<ForgeMessage[]> {
  const messages: ForgeMessage[] = []
  for await (const msg of iterable) {
    messages.push(msg)
  }
  return messages
}

// ---------------------------------------------------------------------------
// parseSSEEvents tests
// ---------------------------------------------------------------------------

describe('parseSSEEvents', () => {
  it('parses a single data line', () => {
    const events = parseSSEEvents('data: hello world\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('hello world')
    expect(events[0]?.event).toBeUndefined()
  })

  it('handles multi-line data concatenation', () => {
    const text = 'data: line one\ndata: line two\ndata: line three\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('line one\nline two\nline three')
  })

  it('parses event type field', () => {
    const text = 'event: task.status.update\ndata: {"status":"working"}\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('task.status.update')
    expect(events[0]?.data).toBe('{"status":"working"}')
  })

  it('parses multiple events separated by blank lines', () => {
    const text = [
      'data: first',
      '',
      'data: second',
      '',
      'data: third',
      '',
    ].join('\n')
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(3)
    expect(events[0]?.data).toBe('first')
    expect(events[1]?.data).toBe('second')
    expect(events[2]?.data).toBe('third')
  })

  it('ignores comment lines', () => {
    const text = ': this is a comment\ndata: actual data\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('actual data')
  })

  it('parses retry directive', () => {
    const text = 'retry: 5000\ndata: reconnect test\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.retry).toBe(5000)
    expect(events[0]?.data).toBe('reconnect test')
  })

  it('parses id field', () => {
    const text = 'id: evt-123\ndata: identified event\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe('evt-123')
  })

  it('ignores invalid retry values', () => {
    const text = 'retry: not-a-number\ndata: test\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.retry).toBeUndefined()
  })

  it('handles data without leading space after colon', () => {
    const text = 'data:no-space\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('no-space')
  })

  it('handles empty data field', () => {
    const text = 'data:\n\n'
    const events = parseSSEEvents(text)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('')
  })
})

// ---------------------------------------------------------------------------
// streamA2ATask tests
// ---------------------------------------------------------------------------

describe('streamA2ATask', () => {
  it('yields stream_chunk for working status', async () => {
    const sseData = [
      'event: task.status.update',
      `data: ${JSON.stringify({
        id: 'task-1',
        status: {
          state: 'working',
          message: { role: 'agent', parts: [{ type: 'text', text: 'Processing...' }] },
        },
      })}`,
      '',
      'event: task.status.update',
      `data: ${JSON.stringify({
        id: 'task-1',
        status: { state: 'completed' },
      })}`,
      '',
    ].join('\n')

    const mockFetch = createMockSSEFetch(sseData)
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
    )

    expect(messages.length).toBeGreaterThanOrEqual(2)
    const workingMsg = messages.find((m) => m.type === 'stream_chunk')
    expect(workingMsg).toBeDefined()
    expect(workingMsg?.payload).toEqual({ type: 'text', content: 'Processing...' })
  })

  it('yields stream_end on completion', async () => {
    const sseData = [
      'event: task.status.update',
      `data: ${JSON.stringify({
        id: 'task-1',
        status: { state: 'completed' },
      })}`,
      '',
    ].join('\n')

    const mockFetch = createMockSSEFetch(sseData)
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
    )

    expect(messages.length).toBeGreaterThanOrEqual(1)
    const endMsg = messages.find((m) => m.type === 'stream_end')
    expect(endMsg).toBeDefined()
    expect(endMsg?.metadata['a2aTaskState']).toBe('completed')
  })

  it('yields error message on failed status', async () => {
    const sseData = [
      'event: task.status.update',
      `data: ${JSON.stringify({
        id: 'task-1',
        status: {
          state: 'failed',
          message: { role: 'agent', parts: [{ type: 'text', text: 'Something went wrong' }] },
        },
      })}`,
      '',
    ].join('\n')

    const mockFetch = createMockSSEFetch(sseData)
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
    )

    const errorMsg = messages.find((m) => m.type === 'error')
    expect(errorMsg).toBeDefined()
    expect(errorMsg?.payload).toMatchObject({
      type: 'error',
      message: 'Something went wrong',
    })
  })

  it('handles abort signal', async () => {
    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    const mockFetch = createMockSSEFetch('data: should not appear\n\n')
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', {
        fetch: mockFetch,
        signal: controller.signal,
      }),
    )

    expect(messages).toHaveLength(0)
  })

  it('reconnects on connection drop up to maxReconnects', async () => {
    let callCount = 0

    const mockFetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      callCount++
      if (callCount <= 2) {
        // Simulate network error
        throw new Error('Connection reset')
      }

      // Third attempt succeeds with a completed task
      const sseData = [
        'event: task.status.update',
        `data: ${JSON.stringify({
          id: 'task-1',
          status: { state: 'completed' },
        })}`,
        '',
      ].join('\n')

      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(sseData))
          ctrl.close()
        },
      })

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof globalThis.fetch

    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', {
        fetch: mockFetch,
        maxReconnects: 3,
        reconnectDelayMs: 10,
      }),
    )

    expect(callCount).toBe(3)
    const endMsg = messages.find((m) => m.type === 'stream_end')
    expect(endMsg).toBeDefined()
  })

  it('throws after exhausting maxReconnects', async () => {
    const mockFetch = (async () => {
      throw new Error('Connection refused')
    }) as typeof globalThis.fetch

    await expect(
      collectMessages(
        streamA2ATask('https://example.com', 'task-1', {
          fetch: mockFetch,
          maxReconnects: 2,
          reconnectDelayMs: 10,
        }),
      ),
    ).rejects.toThrow(/reconnect attempts/)
  })

  it('handles artifact update events', async () => {
    const sseData = [
      'event: task.artifact.update',
      `data: ${JSON.stringify({
        id: 'task-1',
        artifact: {
          name: 'output',
          parts: [{ type: 'data', data: { result: 'artifact-data' } }],
        },
      })}`,
      '',
      'event: task.status.update',
      `data: ${JSON.stringify({ id: 'task-1', status: { state: 'completed' } })}`,
      '',
    ].join('\n')

    const mockFetch = createMockSSEFetch(sseData)
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
    )

    const artifactMsg = messages.find(
      (m) => m.type === 'stream_chunk' && m.payload.type === 'json',
    )
    expect(artifactMsg).toBeDefined()
    expect(artifactMsg?.metadata['artifactName']).toBe('output')
  })

  it('handles multi-chunk SSE data', async () => {
    // Split SSE data across multiple chunks
    const chunk1 = 'event: task.status.update\ndata: {"id":"t'
    const chunk2 = `ask-1","status":{"state":"working","message":{"role":"agent","parts":[{"type":"text","text":"Working"}]}}}\n\nevent: task.status.update\ndata: ${JSON.stringify({
      id: 'task-1',
      status: { state: 'completed' },
    })}\n\n`

    const mockFetch = createMultiChunkSSEFetch([chunk1, chunk2])
    const messages = await collectMessages(
      streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
    )

    expect(messages.length).toBeGreaterThanOrEqual(1)
    const endMsg = messages.find((m) => m.type === 'stream_end')
    expect(endMsg).toBeDefined()
  })

  it('handles non-200 HTTP response', async () => {
    const mockFetch = createMockSSEFetch('', { status: 404 })

    await expect(
      collectMessages(
        streamA2ATask('https://example.com', 'task-1', { fetch: mockFetch }),
      ),
    ).rejects.toThrow(/returned 404/)
  })
})

// ---------------------------------------------------------------------------
// A2AClientAdapter.stream() integration test
// ---------------------------------------------------------------------------

describe('A2AClientAdapter.stream()', () => {
  it('submits task then streams SSE updates', async () => {
    let callCount = 0

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      callCount++
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      // First call: send() POST to submit the task
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              id: 'task-abc',
              status: { state: 'working' },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      // Second call: GET for SSE stream
      if (url.includes('/tasks/task-abc/stream')) {
        const sseData = [
          'event: task.status.update',
          `data: ${JSON.stringify({
            id: 'task-abc',
            status: {
              state: 'working',
              message: { role: 'agent', parts: [{ type: 'text', text: 'Step 1 done' }] },
            },
          })}`,
          '',
          'event: task.status.update',
          `data: ${JSON.stringify({ id: 'task-abc', status: { state: 'completed' } })}`,
          '',
        ].join('\n')

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(encoder.encode(sseData))
            ctrl.close()
          },
        })

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      // Agent card check
      if (url.includes('.well-known/agent.json')) {
        return new Response(JSON.stringify({ name: 'test-agent' }), { status: 200 })
      }

      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://example.com',
      fetch: mockFetch,
    })

    const { createForgeMessage } = await import('../message-factory.js')
    const message = createForgeMessage({
      type: 'request',
      from: 'forge://local',
      to: 'a2a://example.com',
      protocol: 'a2a',
      payload: { type: 'text', content: 'Do something' },
    })

    const messages = await collectMessages(adapter.stream(message))

    // Should have: initial response from send(), then streaming messages
    expect(messages.length).toBeGreaterThanOrEqual(2)

    // First message is the send() response
    expect(messages[0]?.type).toBe('response')
    expect(messages[0]?.metadata['a2aTaskId']).toBe('task-abc')

    // Subsequent messages from SSE
    const streamChunks = messages.filter((m) => m.type === 'stream_chunk')
    const streamEnd = messages.find((m) => m.type === 'stream_end')
    expect(streamChunks.length + (streamEnd ? 1 : 0)).toBeGreaterThanOrEqual(1)
  })

  it('returns only send() response when task already completed', async () => {
    const mockFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              id: 'task-done',
              status: { state: 'completed' },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch

    const adapter = new A2AClientAdapter({
      baseUrl: 'https://example.com',
      fetch: mockFetch,
    })

    const { createForgeMessage } = await import('../message-factory.js')
    const message = createForgeMessage({
      type: 'request',
      from: 'forge://local',
      to: 'a2a://example.com',
      protocol: 'a2a',
      payload: { type: 'text', content: 'Already done' },
    })

    const messages = await collectMessages(adapter.stream(message))

    // Only the send() response — no SSE streaming
    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('response')
    expect(messages[0]?.metadata['a2aTaskState']).toBe('completed')
  })
})
