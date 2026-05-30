import { describe, it, expect, vi } from 'vitest'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'
import type { AgentEvent, AgentInput } from '../types.js'

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: 'test prompt',
    systemPrompt: 'system',
    correlationId: 'corr-1',
    ...overrides,
  }
}

interface RawEvent {
  kind: 'thread_start' | 'message' | 'done' | 'error'
  sessionId?: string
  content?: string
  error?: string
}

function makeSource(
  events: RawEvent[],
  overrides: Partial<AdapterStreamSource<RawEvent>> = {},
): AdapterStreamSource<RawEvent> {
  return {
    providerId: 'claude',
    async *open(_input, _signal) {
      for (const ev of events) yield ev
    },
    mapRawEvent(raw, ctx): AgentEvent | null {
      if (raw.kind === 'thread_start') return null
      if (raw.kind === 'message') {
        return {
          type: 'adapter:message',
          providerId: 'claude',
          content: raw.content ?? '',
          role: 'assistant',
          timestamp: Date.now(),
        }
      }
      if (raw.kind === 'done') {
        return {
          type: 'adapter:completed',
          providerId: 'claude',
          sessionId: ctx.sessionId,
          result: 'done',
          durationMs: 0,
          timestamp: Date.now(),
        }
      }
      return null
    },
    detectThreadStart(raw) {
      if (raw.kind === 'thread_start') return { threadId: raw.sessionId ?? 'session-1' }
      return null
    },
    ...overrides,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const results: AgentEvent[] = []
  for await (const ev of gen) results.push(ev)
  return results
}

describe('AdapterStreamRunner', () => {
  it('emits adapter:started on thread start detection', async () => {
    const runner = new AdapterStreamRunner()
    const source = makeSource([{ kind: 'thread_start', sessionId: 'sess-abc' }, { kind: 'done' }])
    const events = await collect(runner.run(source, makeInput()))

    expect(events[0]?.type).toBe('adapter:started')
    expect((events[0] as { type: string; sessionId: string }).sessionId).toBe('sess-abc')
  })

  it('passes correlationId through to adapter:started', async () => {
    const runner = new AdapterStreamRunner()
    const source = makeSource([{ kind: 'thread_start', sessionId: 's1' }])
    const events = await collect(runner.run(source, makeInput({ correlationId: 'my-corr' })))

    expect((events[0] as Record<string, unknown>)['correlationId']).toBe('my-corr')
  })

  it('maps raw events through source.mapRawEvent', async () => {
    const runner = new AdapterStreamRunner()
    const source = makeSource([
      { kind: 'thread_start', sessionId: 's1' },
      { kind: 'message', content: 'hello' },
      { kind: 'done' },
    ])
    const events = await collect(runner.run(source, makeInput()))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:message', 'adapter:completed'])
    expect((events[1] as { content: string }).content).toBe('hello')
  })

  it('emits adapter:failed and returns (does not rethrow) on stream error', async () => {
    const runner = new AdapterStreamRunner()
    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open() {
        throw new Error('SDK error')
      },
      mapRawEvent: () => null,
    }

    const events = await collect(runner.run(source, makeInput()))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('adapter:failed')
    expect((events[0] as { error: string }).error).toContain('SDK error')
  })

  it('respects abort signal — stops yielding events after abort', async () => {
    const runner = new AdapterStreamRunner()
    const controller = new AbortController()

    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open(_input, signal) {
        for (let i = 0; i < 10; i++) {
          if (signal.aborted) return
          yield { kind: 'message', content: `msg-${i}` } as RawEvent
        }
      },
      mapRawEvent(raw, _ctx): AgentEvent | null {
        return {
          type: 'adapter:message',
          providerId: 'claude',
          content: (raw as RawEvent).content ?? '',
          role: 'assistant',
          timestamp: Date.now(),
        }
      },
    }

    // Abort after first event
    let count = 0
    const events: AgentEvent[] = []
    for await (const ev of runner.run(source, makeInput(), controller.signal)) {
      events.push(ev)
      count++
      if (count === 1) controller.abort()
    }

    expect(events.length).toBeLessThan(10)
  })

  it('emits adapter:started immediately when emitStartedImmediately=true', async () => {
    const runner = new AdapterStreamRunner({ emitStartedImmediately: true })
    const source = makeSource([{ kind: 'done' }], {
      detectThreadStart: () => null,
    })
    const events = await collect(runner.run(source, makeInput()))

    expect(events[0]?.type).toBe('adapter:started')
  })

  it('sets sessionId in context when detectThreadStart fires', async () => {
    const runner = new AdapterStreamRunner()
    const capturedContexts: StreamContext[] = []
    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open() {
        yield { kind: 'thread_start', sessionId: 'ctx-session' } as RawEvent
        yield { kind: 'done' } as RawEvent
      },
      mapRawEvent(raw, ctx): AgentEvent | null {
        capturedContexts.push({ ...ctx })
        if (raw.kind === 'done') {
          return { type: 'adapter:completed', providerId: 'claude', sessionId: ctx.sessionId, result: 'x', durationMs: 0, timestamp: 0 }
        }
        return null
      },
      detectThreadStart(raw) {
        if (raw.kind === 'thread_start') return { threadId: raw.sessionId! }
        return null
      },
    }

    await collect(runner.run(source, makeInput()))
    // After thread_start, sessionId should be set in context for subsequent events
    expect(capturedContexts.some((c) => c.sessionId === 'ctx-session')).toBe(true)
  })

  it('calls onAbortController before stream opens', async () => {
    let capturedController: AbortController | null = null
    const runner = new AdapterStreamRunner({
      onAbortController: (ctrl) => { capturedController = ctrl },
    })
    const source = makeSource([{ kind: 'thread_start', sessionId: 's1' }, { kind: 'done' }])
    await collect(runner.run(source, makeInput()))

    expect(capturedController).not.toBeNull()
    expect(capturedController).toBeInstanceOf(AbortController)
  })

  it('abort via onAbortController stops the stream', async () => {
    let runnerController: AbortController | null = null
    const runner = new AdapterStreamRunner({
      onAbortController: (ctrl) => { runnerController = ctrl },
    })

    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open(_input, signal) {
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) return
          yield { kind: 'message', content: `msg-${i}` } as RawEvent
          await new Promise((r) => setTimeout(r, 1))
        }
      },
      mapRawEvent(raw, _ctx): AgentEvent | null {
        return {
          type: 'adapter:message',
          providerId: 'claude',
          content: (raw as RawEvent).content ?? '',
          role: 'assistant',
          timestamp: Date.now(),
        }
      },
    }

    let count = 0
    const events: AgentEvent[] = []
    for await (const ev of runner.run(source, makeInput())) {
      events.push(ev)
      count++
      if (count === 2 && runnerController) {
        runnerController.abort()
      }
    }

    expect(events.length).toBeLessThan(100)
  })

  it('emits multiple events when mapRawEvent returns an array', async () => {
    const runner = new AdapterStreamRunner()
    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open() {
        yield { kind: 'thread_start', sessionId: 's1' } as RawEvent
        yield { kind: 'done' } as RawEvent
      },
      mapRawEvent(raw, ctx): AgentEvent | AgentEvent[] | null {
        if (raw.kind === 'done') {
          return [
            { type: 'adapter:completed', providerId: 'claude', sessionId: ctx.sessionId, result: 'done', durationMs: 0, timestamp: Date.now() },
            { type: 'adapter:cache_stats', providerId: 'claude', sessionId: ctx.sessionId, cacheReadTokens: 100, cacheWriteTokens: 0, totalInputTokens: 200, cacheHitRatio: 0.5, timestamp: Date.now() } as AgentEvent,
          ]
        }
        return null
      },
      detectThreadStart(raw) {
        if (raw.kind === 'thread_start') return { threadId: raw.sessionId ?? 's1' }
        return null
      },
    }

    const events = await collect(runner.run(source, makeInput()))
    const types = events.map((e) => e.type)
    expect(types).toContain('adapter:started')
    expect(types).toContain('adapter:completed')
    expect(types).toContain('adapter:cache_stats')
    expect(types.indexOf('adapter:completed')).toBeLessThan(types.indexOf('adapter:cache_stats'))
  })

  it('merges extra fields from detectThreadStart into adapter:started', async () => {
    const runner = new AdapterStreamRunner()
    const source: AdapterStreamSource<RawEvent> = {
      providerId: 'claude',
      async *open() {
        yield { kind: 'thread_start', sessionId: 's2' } as RawEvent
      },
      mapRawEvent: () => null,
      detectThreadStart(raw) {
        if (raw.kind === 'thread_start') {
          return { threadId: 's2', extra: { model: 'claude-opus-4', workingDirectory: '/app' } }
        }
        return null
      },
    }

    const events = await collect(runner.run(source, makeInput()))
    const started = events.find((e) => e.type === 'adapter:started') as Record<string, unknown> | undefined
    expect(started?.['model']).toBe('claude-opus-4')
    expect(started?.['workingDirectory']).toBe('/app')
  })
})
