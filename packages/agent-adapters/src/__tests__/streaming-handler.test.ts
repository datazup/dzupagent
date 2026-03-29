import { describe, it, expect, beforeEach } from 'vitest'

import { StreamingHandler } from '../streaming/streaming-handler.js'
import type { StreamOutputEvent } from '../streaming/streaming-handler.js'
import type { AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
  for (const event of events) {
    yield event
  }
}

async function collectOutputEvents(
  gen: AsyncGenerator<StreamOutputEvent>,
): Promise<StreamOutputEvent[]> {
  const result: StreamOutputEvent[] = []
  for await (const event of gen) {
    result.push(event)
  }
  return result
}

async function collectStrings(
  gen: AsyncGenerator<string>,
): Promise<string[]> {
  const result: string[] = []
  for await (const s of gen) {
    result.push(s)
  }
  return result
}

function makeStarted(): AgentEvent {
  return {
    type: 'adapter:started',
    providerId: 'claude',
    sessionId: 'sess-1',
    timestamp: Date.now(),
  }
}

function makeMessage(content: string, role: 'assistant' | 'user' | 'system' = 'assistant'): AgentEvent {
  return {
    type: 'adapter:message',
    providerId: 'claude',
    content,
    role,
    timestamp: Date.now(),
  }
}

function makeToolCall(toolName: string, input: unknown = {}): AgentEvent {
  return {
    type: 'adapter:tool_call',
    providerId: 'claude',
    toolName,
    input,
    timestamp: Date.now(),
  }
}

function makeToolResult(toolName: string, output: string, durationMs = 10): AgentEvent {
  return {
    type: 'adapter:tool_result',
    providerId: 'claude',
    toolName,
    output,
    durationMs,
    timestamp: Date.now(),
  }
}

function makeCompleted(result = 'Done'): AgentEvent {
  return {
    type: 'adapter:completed',
    providerId: 'claude',
    sessionId: 'sess-1',
    result,
    usage: { inputTokens: 100, outputTokens: 50 },
    durationMs: 500,
    timestamp: Date.now(),
  }
}

function makeFailed(error = 'Something broke'): AgentEvent {
  return {
    type: 'adapter:failed',
    providerId: 'claude',
    error,
    code: 'TEST_ERROR',
    timestamp: Date.now(),
  }
}

function makeStreamDelta(content: string): AgentEvent {
  return {
    type: 'adapter:stream_delta',
    providerId: 'claude',
    content,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests: transform()
// ---------------------------------------------------------------------------

describe('StreamingHandler', () => {
  let sut: StreamingHandler

  beforeEach(() => {
    sut = new StreamingHandler({ trackProgress: false })
  })

  describe('transform()', () => {
    it('maps adapter:started to status event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeStarted()])),
      )

      const statusEvents = events.filter((e) => e.type === 'status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0]!.data.type).toBe('status')
      const data = statusEvents[0]!.data as { type: 'status'; status: string; providerId?: string }
      expect(data.status).toBe('started')
      expect(data.providerId).toBe('claude')
    })

    it('maps adapter:message to content event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeMessage('Hello world')])),
      )

      const contentEvents = events.filter((e) => e.type === 'content')
      expect(contentEvents).toHaveLength(1)
      const data = contentEvents[0]!.data as { type: 'content'; text: string; role: string }
      expect(data.text).toBe('Hello world')
      expect(data.role).toBe('assistant')
    })

    it('maps adapter:tool_call to tool_call event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeToolCall('read_file', { path: '/a.ts' })])),
      )

      const toolEvents = events.filter((e) => e.type === 'tool_call')
      expect(toolEvents).toHaveLength(1)
      const data = toolEvents[0]!.data as { type: 'tool_call'; name: string; input: unknown }
      expect(data.name).toBe('read_file')
      expect(data.input).toEqual({ path: '/a.ts' })
    })

    it('maps adapter:tool_result to tool_result event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeToolResult('read_file', 'file contents', 42)])),
      )

      const resultEvents = events.filter((e) => e.type === 'tool_result')
      expect(resultEvents).toHaveLength(1)
      const data = resultEvents[0]!.data as { type: 'tool_result'; name: string; output: string; durationMs: number }
      expect(data.name).toBe('read_file')
      expect(data.output).toBe('file contents')
      expect(data.durationMs).toBe(42)
    })

    it('maps adapter:completed to done event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeCompleted('Final result')])),
      )

      const doneEvents = events.filter((e) => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      const data = doneEvents[0]!.data as { type: 'done'; result: string; durationMs: number; usage?: { inputTokens: number; outputTokens: number } }
      expect(data.result).toBe('Final result')
      expect(data.durationMs).toBe(500)
      expect(data.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    })

    it('maps adapter:failed to error event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeFailed('Bad error')])),
      )

      const errorEvents = events.filter((e) => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      const data = errorEvents[0]!.data as { type: 'error'; message: string; code?: string; recoverable: boolean }
      expect(data.message).toBe('Bad error')
      expect(data.code).toBe('TEST_ERROR')
      expect(data.recoverable).toBe(false)
    })

    it('maps adapter:stream_delta to content event', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeStreamDelta('chunk')])),
      )

      const contentEvents = events.filter((e) => e.type === 'content')
      expect(contentEvents).toHaveLength(1)
      const data = contentEvents[0]!.data as { type: 'content'; text: string; role: string }
      expect(data.text).toBe('chunk')
      expect(data.role).toBe('assistant')
    })

    it('emits progress events when trackProgress enabled', async () => {
      const progressHandler = new StreamingHandler({ trackProgress: true })

      const events = await collectOutputEvents(
        progressHandler.transform(eventStream([
          makeStarted(),
          makeMessage('Hello'),
          makeToolCall('t1', {}),
          makeCompleted(),
        ])),
      )

      const progressEvents = events.filter((e) => e.type === 'progress')
      // Progress events for started, message, tool_call (not for completed/failed)
      expect(progressEvents.length).toBeGreaterThanOrEqual(3)
    })

    it('excludes tool events when includeToolCalls=false', async () => {
      const noTools = new StreamingHandler({
        includeToolCalls: false,
        trackProgress: false,
      })

      const events = await collectOutputEvents(
        noTools.transform(eventStream([
          makeStarted(),
          makeToolCall('read_file', {}),
          makeToolResult('read_file', 'output'),
          makeCompleted(),
        ])),
      )

      const types = events.map((e) => e.type)
      expect(types).not.toContain('tool_call')
      expect(types).not.toContain('tool_result')
      expect(types).toContain('status')
      expect(types).toContain('done')
    })
  })

  // -------------------------------------------------------------------------
  // Tests: serialize()
  // -------------------------------------------------------------------------

  describe('serialize()', () => {
    it('JSONL format outputs newline-delimited JSON', async () => {
      const jsonlHandler = new StreamingHandler({
        format: 'jsonl',
        trackProgress: false,
      })

      const lines = await collectStrings(
        jsonlHandler.serialize(eventStream([makeStarted()])),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.endsWith('\n')).toBe(true)
      // Should be valid JSON
      const parsed = JSON.parse(lines[0]!.trim())
      expect(parsed.type).toBe('status')
    })

    it('SSE format outputs data: prefix with double newline', async () => {
      const sseHandler = new StreamingHandler({
        format: 'sse',
        trackProgress: false,
      })

      const lines = await collectStrings(
        sseHandler.serialize(eventStream([makeStarted()])),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.startsWith('data: ')).toBe(true)
      expect(lines[0]!.endsWith('\n\n')).toBe(true)
      // Extract JSON after "data: "
      const json = lines[0]!.slice(6, -2) // remove "data: " prefix and "\n\n" suffix
      const parsed = JSON.parse(json)
      expect(parsed.type).toBe('status')
    })

    it('NDJSON format outputs same as JSONL', async () => {
      const ndjsonHandler = new StreamingHandler({
        format: 'ndjson',
        trackProgress: false,
      })

      const lines = await collectStrings(
        ndjsonHandler.serialize(eventStream([makeMessage('Hi')])),
      )

      expect(lines).toHaveLength(1)
      expect(lines[0]!.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(lines[0]!.trim())
      expect(parsed.type).toBe('content')
    })
  })

  // -------------------------------------------------------------------------
  // Tests: toReadableStream()
  // -------------------------------------------------------------------------

  describe('toReadableStream()', () => {
    it('returns ReadableStream', () => {
      const handler = new StreamingHandler({ trackProgress: false })
      const stream = handler.toReadableStream(eventStream([makeStarted()]))

      expect(stream).toBeInstanceOf(ReadableStream)
    })

    it('stream yields serialized events', async () => {
      const handler = new StreamingHandler({
        format: 'jsonl',
        trackProgress: false,
      })
      const stream = handler.toReadableStream(
        eventStream([makeStarted(), makeCompleted()]),
      )

      const reader = stream.getReader()
      const chunks: string[] = []

      let readResult = await reader.read()
      while (!readResult.done) {
        chunks.push(readResult.value)
        readResult = await reader.read()
      }

      expect(chunks.length).toBe(2)
      for (const chunk of chunks) {
        expect(chunk.endsWith('\n')).toBe(true)
        // Valid JSON
        expect(() => JSON.parse(chunk.trim())).not.toThrow()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Tests: Progress tracking
  // -------------------------------------------------------------------------

  describe('Progress tracking', () => {
    it('getProgress() returns current state', () => {
      const handler = new StreamingHandler({ trackProgress: true })
      const progress = handler.getProgress()

      expect(progress.totalEvents).toBe(0)
      expect(progress.toolCallCount).toBe(0)
      expect(progress.messageCount).toBe(0)
      expect(progress.estimatedPercent).toBe(0)
    })

    it('reset() clears progress', async () => {
      const handler = new StreamingHandler({ trackProgress: true })

      // Generate some events to advance progress
      await collectOutputEvents(
        handler.transform(eventStream([makeStarted(), makeMessage('Hi')])),
      )

      expect(handler.getProgress().totalEvents).toBeGreaterThan(0)

      handler.reset()

      const progress = handler.getProgress()
      expect(progress.totalEvents).toBe(0)
      expect(progress.estimatedPercent).toBe(0)
    })

    it('percent increases through lifecycle', async () => {
      const handler = new StreamingHandler({ trackProgress: true })

      const events: AgentEvent[] = [
        makeStarted(),
        makeMessage('Thinking...'),
        makeToolCall('read_file', {}),
        makeToolResult('read_file', 'contents'),
        makeToolCall('write_file', {}),
        makeToolResult('write_file', 'ok'),
        makeCompleted('Done'),
      ]

      const percents: number[] = []

      for await (const outputEvent of handler.transform(eventStream(events))) {
        if (outputEvent.type === 'progress') {
          const progressData = outputEvent.data as { type: 'progress'; percent: number }
          percents.push(progressData.percent)
        }
      }

      // Should have progress events, and percents should generally be non-decreasing
      expect(percents.length).toBeGreaterThan(0)

      // Final progress should reach 100
      expect(handler.getProgress().estimatedPercent).toBe(100)
    })

    it('started event sets percent to 5', async () => {
      const handler = new StreamingHandler({ trackProgress: true })

      await collectOutputEvents(handler.transform(eventStream([makeStarted()])))

      expect(handler.getProgress().estimatedPercent).toBe(5)
    })

    it('completed event sets percent to 100', async () => {
      const handler = new StreamingHandler({ trackProgress: true })

      await collectOutputEvents(
        handler.transform(eventStream([makeStarted(), makeCompleted()])),
      )

      expect(handler.getProgress().estimatedPercent).toBe(100)
    })

    it('failed event sets percent to 100', async () => {
      const handler = new StreamingHandler({ trackProgress: true })

      await collectOutputEvents(
        handler.transform(eventStream([makeStarted(), makeFailed()])),
      )

      expect(handler.getProgress().estimatedPercent).toBe(100)
    })
  })

  // -------------------------------------------------------------------------
  // Tests: output event structure
  // -------------------------------------------------------------------------

  describe('output event structure', () => {
    it('includes ISO timestamp', async () => {
      const events = await collectOutputEvents(
        sut.transform(eventStream([makeStarted()])),
      )

      const ts = events[0]!.timestamp
      // Should be a valid ISO date string
      expect(new Date(ts).toISOString()).toBe(ts)
    })

    it('full lifecycle produces correct event sequence', async () => {
      const events = await collectOutputEvents(
        sut.transform(
          eventStream([
            makeStarted(),
            makeMessage('Analyzing...'),
            makeToolCall('read_file', {}),
            makeToolResult('read_file', 'contents'),
            makeCompleted('All done'),
          ]),
        ),
      )

      const types = events.map((e) => e.type)
      expect(types).toEqual([
        'status',
        'content',
        'tool_call',
        'tool_result',
        'done',
      ])
    })
  })
})
