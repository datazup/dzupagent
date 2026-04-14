import { describe, it, expect } from 'vitest'
import {
  MiddlewarePipeline,
  type AdapterMiddleware,
  type MiddlewareContext,
} from '../middleware/middleware-pipeline.js'
import type { AgentEvent } from '../types.js'

// Helper: create a mock event source
async function* mockSource(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, undefined> {
  for (const e of events) yield e
}

// Helper: create a simple context
function mockContext(): MiddlewareContext {
  return { input: { prompt: 'test' }, providerId: 'claude' }
}

describe('MiddlewarePipeline', () => {
  it('passes events through when empty', async () => {
    const pipeline = new MiddlewarePipeline()
    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'ok',
        durationMs: 100,
        timestamp: 2,
      },
    ]
    const wrapped = pipeline.wrap(mockSource(events), mockContext())
    const result: AgentEvent[] = []
    for await (const e of wrapped) result.push(e)
    expect(result).toEqual(events)
  })

  it('applies middleware in correct order', async () => {
    const pipeline = new MiddlewarePipeline()
    const order: string[] = []

    const mw1: AdapterMiddleware = async function* (source, _ctx) {
      order.push('mw1-before')
      for await (const e of source) {
        yield e
      }
      order.push('mw1-after')
    }
    const mw2: AdapterMiddleware = async function* (source, _ctx) {
      order.push('mw2-before')
      for await (const e of source) {
        yield e
      }
      order.push('mw2-after')
    }

    pipeline.use('first', mw1).use('second', mw2)
    const events: AgentEvent[] = [
      {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 's1',
        timestamp: 1,
      },
    ]
    const wrapped = pipeline.wrap(mockSource(events), mockContext())
    for await (const _e of wrapped) {
      /* consume */
    }

    // First added = outermost, so mw1 wraps mw2
    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after'])
  })

  it('can filter events', async () => {
    const pipeline = new MiddlewarePipeline()
    const filterMw: AdapterMiddleware = async function* (source, _ctx) {
      for await (const e of source) {
        if (e.type !== 'adapter:stream_delta') yield e
      }
    }
    pipeline.use('filter', filterMw)
    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
      { type: 'adapter:stream_delta', providerId: 'claude', content: 'hi', timestamp: 2 },
      {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId: 's1',
        result: 'ok',
        durationMs: 100,
        timestamp: 3,
      },
    ]
    const result: AgentEvent[] = []
    for await (const e of pipeline.wrap(mockSource(events), mockContext())) result.push(e)
    expect(result).toHaveLength(2)
    expect(result.every(e => e.type !== 'adapter:stream_delta')).toBe(true)
  })

  it('remove() removes middleware by name', () => {
    const pipeline = new MiddlewarePipeline()
    const noop: AdapterMiddleware = async function* (s) {
      yield* s
    }
    pipeline.use('a', noop).use('b', noop)
    expect(pipeline.list()).toEqual(['a', 'b'])
    pipeline.remove('a')
    expect(pipeline.list()).toEqual(['b'])
  })

  it('has() checks middleware existence', () => {
    const pipeline = new MiddlewarePipeline()
    const noop: AdapterMiddleware = async function* (s) {
      yield* s
    }
    pipeline.use('tracker', noop)
    expect(pipeline.has('tracker')).toBe(true)
    expect(pipeline.has('nonexistent')).toBe(false)
  })

  it('can inject events', async () => {
    const pipeline = new MiddlewarePipeline()
    const injector: AdapterMiddleware = async function* (source, _ctx) {
      for await (const e of source) {
        yield e
        if (e.type === 'adapter:started') {
          yield {
            type: 'adapter:message' as const,
            providerId: 'claude' as const,
            content: 'injected',
            role: 'system' as const,
            timestamp: Date.now(),
          }
        }
      }
    }
    pipeline.use('inject', injector)
    const events: AgentEvent[] = [
      { type: 'adapter:started', providerId: 'claude', sessionId: 's1', timestamp: 1 },
    ]
    const result: AgentEvent[] = []
    for await (const e of pipeline.wrap(mockSource(events), mockContext())) result.push(e)
    expect(result).toHaveLength(2)
    expect(result[1]!.type).toBe('adapter:message')
  })
})
