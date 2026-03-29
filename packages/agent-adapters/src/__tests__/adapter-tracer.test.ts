import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

import { AdapterTracer } from '../observability/adapter-tracer.js'
import type { TraceSpan } from '../observability/adapter-tracer.js'
import type { AgentEvent, AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent<T extends AgentEvent['type']>(
  type: T,
  overrides: Partial<AgentEvent> & Record<string, unknown> = {},
): AgentEvent {
  const base = {
    providerId: 'claude' as AdapterProviderId,
    timestamp: Date.now(),
  }
  return { ...base, type, ...overrides } as unknown as AgentEvent
}

async function* eventStream(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = []
  for await (const e of gen) result.push(e)
  return result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterTracer', () => {
  let tracer: AdapterTracer

  beforeEach(() => {
    tracer = new AdapterTracer()
  })

  describe('trace()', () => {
    it('creates root span on trace', async () => {
      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 100,
        }),
      ]

      await collectEvents(tracer.trace('test-run', eventStream(events)))

      const spans = tracer.getSpans()
      expect(spans).toHaveLength(1)
      expect(spans[0]!.name).toBe('test-run')
      expect(spans[0]!.status).toBe('ok')
    })

    it('adds span event for adapter:started', async () => {
      const events = [
        makeEvent('adapter:started', {
          sessionId: 's1',
        }),
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 50,
        }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const spans = tracer.getSpans()
      expect(spans).toHaveLength(1)
      const rootSpan = spans[0]!
      const startedEvent = rootSpan.events.find((e) => e.name === 'adapter.started')
      expect(startedEvent).toBeDefined()
      expect(startedEvent!.attributes!['adapter.provider_id']).toBe('claude')
    })

    it('creates child spans for tool calls', async () => {
      const events = [
        makeEvent('adapter:tool_call', {
          toolName: 'read_file',
          input: { path: '/foo' },
        }),
        makeEvent('adapter:tool_result', {
          toolName: 'read_file',
          output: 'content',
          durationMs: 25,
        }),
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 100,
        }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const spans = tracer.getSpans()
      // tool span + root span
      expect(spans).toHaveLength(2)
      const toolSpan = spans.find((s) => s.name === 'tool.read_file')
      expect(toolSpan).toBeDefined()
      expect(toolSpan!.status).toBe('ok')
      expect(toolSpan!.attributes['tool.duration_ms']).toBe(25)
    })

    it('ends tool spans on tool results', async () => {
      const events = [
        makeEvent('adapter:tool_call', {
          toolName: 'write_file',
          input: {},
        }),
        makeEvent('adapter:tool_result', {
          toolName: 'write_file',
          output: 'ok',
          durationMs: 10,
        }),
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 50,
        }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const toolSpan = tracer.getSpans().find((s) => s.name === 'tool.write_file')
      expect(toolSpan).toBeDefined()
      expect(toolSpan!.endTime).toBeDefined()
    })

    it('sets usage attributes on completion', async () => {
      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 200,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cachedInputTokens: 50,
            costCents: 0.3,
          },
        }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const root = tracer.getSpans()[0]!
      expect(root.attributes['usage.input_tokens']).toBe(500)
      expect(root.attributes['usage.output_tokens']).toBe(100)
      expect(root.attributes['usage.cached_input_tokens']).toBe(50)
      expect(root.attributes['usage.cost_cents']).toBe(0.3)
      expect(root.attributes['adapter.duration_ms']).toBe(200)
    })

    it('sets error status on failure', async () => {
      const events = [
        makeEvent('adapter:failed', {
          error: 'rate limit exceeded',
        }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const root = tracer.getSpans()[0]!
      expect(root.status).toBe('error')
      const exceptionEvent = root.events.find((e) => e.name === 'exception')
      expect(exceptionEvent).toBeDefined()
      expect(exceptionEvent!.attributes!['exception.message']).toBe('rate limit exceeded')
    })

    it('yields all events unchanged', async () => {
      const sourceEvents = [
        makeEvent('adapter:started', { sessionId: 's1' }),
        makeEvent('adapter:message', { content: 'hello', role: 'assistant' }),
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 50,
        }),
      ]

      const yielded = await collectEvents(tracer.trace('run', eventStream(sourceEvents)))

      expect(yielded).toHaveLength(3)
      expect(yielded.map((e) => e.type)).toEqual([
        'adapter:started',
        'adapter:message',
        'adapter:completed',
      ])
    })

    it('closes root span when generator completes without explicit end event', async () => {
      const events = [
        makeEvent('adapter:message', { content: 'hi', role: 'assistant' }),
      ]

      await collectEvents(tracer.trace('run', eventStream(events)))

      const root = tracer.getSpans()[0]!
      expect(root.status).toBe('ok')
      expect(root.endTime).toBeDefined()
    })

    it('handles thrown errors from source generator', async () => {
      async function* failingStream(): AsyncGenerator<AgentEvent> {
        yield makeEvent('adapter:started', { sessionId: 's1' })
        throw new Error('boom')
      }

      await expect(
        collectEvents(tracer.trace('run', failingStream())),
      ).rejects.toThrow('boom')

      const root = tracer.getSpans()[0]!
      expect(root.status).toBe('error')
    })

    it('closes open tool spans when source throws', async () => {
      async function* failingStream(): AsyncGenerator<AgentEvent> {
        yield makeEvent('adapter:tool_call', {
          toolName: 'exec',
          input: {},
        })
        throw new Error('crash')
      }

      await expect(
        collectEvents(tracer.trace('run', failingStream())),
      ).rejects.toThrow('crash')

      const toolSpan = tracer.getSpans().find((s) => s.name === 'tool.exec')
      expect(toolSpan).toBeDefined()
      expect(toolSpan!.status).toBe('error')
    })

    it('propagates parent context', async () => {
      const parentCtx = {
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: 'eeee5555ffff6666',
      }

      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
        }),
      ]

      await collectEvents(tracer.trace('child-run', eventStream(events), parentCtx))

      const root = tracer.getSpans()[0]!
      expect(root.traceId).toBe(parentCtx.traceId)
      expect(root.parentSpanId).toBe(parentCtx.spanId)
    })
  })

  describe('getSpans()', () => {
    it('returns completed spans', async () => {
      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
        }),
      ]
      await collectEvents(tracer.trace('run', eventStream(events)))
      expect(tracer.getSpans()).toHaveLength(1)
    })

    it('returns a copy of the internal array', async () => {
      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
        }),
      ]
      await collectEvents(tracer.trace('run', eventStream(events)))

      const spans1 = tracer.getSpans()
      const spans2 = tracer.getSpans()
      expect(spans1).not.toBe(spans2)
      expect(spans1).toEqual(spans2)
    })
  })

  describe('reset()', () => {
    it('clears spans', async () => {
      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 10,
        }),
      ]
      await collectEvents(tracer.trace('run', eventStream(events)))
      expect(tracer.getSpans()).toHaveLength(1)

      tracer.reset()
      expect(tracer.getSpans()).toHaveLength(0)
    })
  })

  describe('buildPropagationEnv()', () => {
    it('returns W3C traceparent when propagateContext is true (default)', () => {
      const span: TraceSpan = {
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: 'eeee5555ffff6666',
        name: 'test',
        startTime: Date.now(),
        status: 'unset',
        attributes: {},
        events: [],
      }

      const env = tracer.buildPropagationEnv(span)
      expect(env.TRACEPARENT).toBe('00-aaaa1111bbbb2222cccc3333dddd4444-eeee5555ffff6666-01')
    })

    it('returns empty object when propagateContext is false', () => {
      const noPropTracer = new AdapterTracer({ propagateContext: false })
      const span: TraceSpan = {
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: 'eeee5555ffff6666',
        name: 'test',
        startTime: Date.now(),
        status: 'unset',
        attributes: {},
        events: [],
      }

      const env = noPropTracer.buildPropagationEnv(span)
      expect(env).toEqual({})
    })
  })

  describe('getTraceContext()', () => {
    it('returns context from span', () => {
      const span: TraceSpan = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'test',
        startTime: Date.now(),
        status: 'unset',
        attributes: {},
        events: [],
      }

      const ctx = tracer.getTraceContext(span)
      expect(ctx).toEqual({ traceId: 'trace123', spanId: 'span456' })
    })
  })

  describe('onSpanEnd callback', () => {
    it('fires when a span ends', async () => {
      const endedSpans: TraceSpan[] = []
      const cbTracer = new AdapterTracer({
        onSpanEnd: (span) => endedSpans.push(span),
      })

      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
        }),
      ]

      await collectEvents(cbTracer.trace('run', eventStream(events)))

      expect(endedSpans).toHaveLength(1)
      expect(endedSpans[0]!.name).toBe('run')
    })

    it('does not throw if onSpanEnd throws', async () => {
      const cbTracer = new AdapterTracer({
        onSpanEnd: () => {
          throw new Error('callback failure')
        },
      })

      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'ok',
          durationMs: 10,
        }),
      ]

      // Should not throw
      await collectEvents(cbTracer.trace('run', eventStream(events)))
      expect(cbTracer.getSpans()).toHaveLength(1)
    })
  })

  describe('eventBus integration', () => {
    it('emits tool:latency events on span end', async () => {
      const bus = createEventBus()
      const emitted: unknown[] = []
      bus.onAny((e) => emitted.push(e))

      const busTracer = new AdapterTracer({ eventBus: bus })

      const events = [
        makeEvent('adapter:completed', {
          sessionId: 's1',
          result: 'done',
          durationMs: 50,
        }),
      ]

      await collectEvents(busTracer.trace('run', eventStream(events)))

      const latencyEvent = emitted.find(
        (e) => (e as Record<string, unknown>).type === 'tool:latency',
      ) as Record<string, unknown> | undefined
      expect(latencyEvent).toBeDefined()
      expect(latencyEvent!['toolName']).toBe('trace:run')
    })
  })
})
