import { describe, it, expect } from 'vitest'

import { AdapterTracer } from '../observability/adapter-tracer.js'
import { createTracingMiddleware } from '../observability/tracing-middleware.js'
import type { AgentEvent } from '../types.js'
import type { MiddlewareContext } from '../middleware/middleware-pipeline.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* mockSource(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
  for (const e of events) yield e
}

function mockContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    input: { prompt: 'test prompt' },
    providerId: 'claude',
    ...overrides,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent, void, undefined>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = []
  for await (const e of gen) result.push(e)
  return result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTracingMiddleware', () => {
  it('creates a root span for execution', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: 'ok', durationMs: 100, timestamp: 2 },
    ]

    const result = await collect(mw(mockSource(events), mockContext()))

    expect(result).toHaveLength(2)
    const spans = tracer.getSpans()
    expect(spans.length).toBeGreaterThanOrEqual(1)
    // Root span should be ended
    expect(spans[0]!.endTime).toBeDefined()
    expect(spans[0]!.name).toBe('adapter.claude.execute')
    expect(spans[0]!.status).toBe('ok')
  })

  it('creates child spans for tool calls', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:tool_call', providerId: 'claude', toolName: 'read_file', input: {}, timestamp: 2 },
      { type: 'adapter:tool_result', providerId: 'claude', toolName: 'read_file', output: 'content', durationMs: 50, timestamp: 3 },
      { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: 'ok', durationMs: 200, timestamp: 4 },
    ]

    const result = await collect(mw(mockSource(events), mockContext()))

    expect(result).toHaveLength(4)
    const spans = tracer.getSpans()
    // Should have tool span + root span (tool ends first, root ends on completed)
    expect(spans.length).toBe(2)
    // Tool span is ended first
    const toolSpan = spans.find(s => s.name === 'tool.read_file')
    expect(toolSpan).toBeDefined()
    expect(toolSpan!.attributes['tool.name']).toBe('read_file')
    expect(toolSpan!.attributes['tool.duration_ms']).toBe(50)
    expect(toolSpan!.attributes['tool.output_length']).toBe(7) // 'content'.length
    expect(toolSpan!.parentSpanId).toBe(spans.find(s => s.name === 'adapter.claude.execute')!.spanId)
  })

  it('passes all events through unchanged', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:stream_delta', providerId: 'claude', content: 'hi', timestamp: 2 },
      { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: 'ok', durationMs: 100, timestamp: 3 },
    ]

    const result = await collect(mw(mockSource(events), mockContext()))

    expect(result).toEqual(events)
  })

  it('handles failure events', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:failed', providerId: 'claude', error: 'timeout', code: 'TIMEOUT', timestamp: 2 },
    ]

    const result = await collect(mw(mockSource(events), mockContext()))

    expect(result).toHaveLength(2)
    const spans = tracer.getSpans()
    expect(spans[0]!.endTime).toBeDefined()
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.attributes['adapter.status']).toBe('error')
    expect(spans[0]!.attributes['adapter.error_code']).toBe('TIMEOUT')
  })

  it('ends root span when stream completes without terminal event', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:stream_delta', providerId: 'claude', content: 'partial', timestamp: 2 },
    ]

    await collect(mw(mockSource(events), mockContext()))

    const spans = tracer.getSpans()
    expect(spans.length).toBe(1)
    expect(spans[0]!.endTime).toBeDefined()
    expect(spans[0]!.attributes['adapter.status']).toBe('stream_ended')
  })

  it('handles thrown errors from source generator', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    async function* failingSource(): AsyncGenerator<AgentEvent, void, undefined> {
      yield { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 }
      throw new Error('connection lost')
    }

    const gen = mw(failingSource(), mockContext())
    const result: AgentEvent[] = []

    await expect(async () => {
      for await (const e of gen) result.push(e)
    }).rejects.toThrow('connection lost')

    // First event should still have been yielded
    expect(result).toHaveLength(1)

    const spans = tracer.getSpans()
    expect(spans[0]!.status).toBe('error')
  })

  it('records usage in span events for completed runs', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'done',
        durationMs: 300,
        timestamp: 2,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]

    await collect(mw(mockSource(events), mockContext()))

    const spans = tracer.getSpans()
    const rootSpan = spans[0]!
    const usageEvent = rootSpan.events.find(e => e.name === 'usage')
    expect(usageEvent).toBeDefined()
    expect(usageEvent!.attributes!['input_tokens']).toBe(100)
    expect(usageEvent!.attributes!['output_tokens']).toBe(50)
  })

  it('sets root span attributes from context', async () => {
    const tracer = new AdapterTracer({ serviceName: 'test' })
    const mw = createTracingMiddleware(tracer)

    const events: AgentEvent[] = [
      { type: 'adapter:completed', providerId: 'gemini', sessionId: 's1', result: 'ok', durationMs: 50, timestamp: 1 },
    ]

    await collect(mw(mockSource(events), mockContext({ providerId: 'gemini', input: { prompt: 'hello', maxTurns: 5, systemPrompt: 'be helpful' } })))

    const spans = tracer.getSpans()
    const root = spans[0]!
    expect(root.attributes['adapter.provider_id']).toBe('gemini')
    expect(root.attributes['adapter.prompt_length']).toBe(5)
    expect(root.attributes['adapter.has_system_prompt']).toBe(true)
    expect(root.attributes['adapter.max_turns']).toBe(5)
  })
})
