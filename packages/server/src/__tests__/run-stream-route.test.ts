import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createForgeApp, type ForgeServerConfig } from '../app.js'
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type DzupEventBus,
} from '@dzupagent/core'

function createTestConfig(): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
  }
}

/**
 * Read SSE lines from a streaming response.
 *
 * Reads chunks from the response body until the stream closes or
 * the timeout elapses. Returns an array of raw SSE lines (e.g.
 * "event: init", "data: {...}").
 */
async function readSSELines(response: Response, timeoutMs = 2000): Promise<string[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ])
      if (result.done) break
      const chunk = decoder.decode(result.value, { stream: true })
      const chunkLines = chunk.split('\n').filter((l) => l.length > 0)
      lines.push(...chunkLines)
      // If we see a done or error event, stop reading
      if (chunk.includes('event: done') || chunk.includes('event: error')) break
    }
  } finally {
    reader.releaseLock()
  }

  return lines
}

/** Parse SSE lines into structured events: { event, data }. */
function parseSSEEvents(lines: string[]): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = []
  let currentEvent = ''
  let currentData = ''

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
      if (currentEvent) {
        events.push({ event: currentEvent, data: currentData })
        currentEvent = ''
        currentData = ''
      }
    }
  }

  return events
}

/**
 * Helper: create agent, run, and optionally update run status before streaming.
 */
async function setupRunForStream(
  config: ForgeServerConfig,
  overrides?: { runStatus?: string },
): Promise<{ runId: string; agentId: string }> {
  const agentId = 'agent-stream'
  await config.agentStore.save({
    id: agentId,
    name: 'Stream Agent',
    instructions: 'test agent',
    modelTier: 'chat',
  })
  const run = await config.runStore.create({ agentId, input: { task: 'test' } })
  if (overrides?.runStatus) {
    await config.runStore.update(run.id, { status: overrides.runStatus as 'running' })
  }
  return { runId: run.id, agentId }
}

describe('GET /api/runs/:id/stream — SSE integration', () => {
  let config: ForgeServerConfig
  let app: ReturnType<typeof createForgeApp>
  let eventBus: DzupEventBus

  beforeEach(() => {
    config = createTestConfig()
    eventBus = config.eventBus
    app = createForgeApp(config)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ──────────────────────────────────────────────────────────────────
  // 1. 404 for non-existent runs
  // ──────────────────────────────────────────────────────────────────

  it('returns 404 when runId does not exist', async () => {
    const res = await app.request('/api/runs/nonexistent-id/stream')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 404 JSON for a run id that looks like a UUID but is not stored', async () => {
    const res = await app.request('/api/runs/00000000-0000-0000-0000-000000000000/stream')
    expect(res.status).toBe(404)
  })

  // ──────────────────────────────────────────────────────────────────
  // 2. SSE headers
  // ──────────────────────────────────────────────────────────────────

  it('returns 200 with text/event-stream content type', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'completed' })
    const res = await app.request(`/api/runs/${runId}/stream`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('sets cache-control to no-cache for SSE', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'completed' })
    const res = await app.request(`/api/runs/${runId}/stream`)
    expect(res.headers.get('cache-control')).toContain('no-cache')
  })

  // ──────────────────────────────────────────────────────────────────
  // 3. Init event
  // ──────────────────────────────────────────────────────────────────

  it('sends an init event immediately with current run status', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    // Emit completion after a short delay so the stream ends
    setTimeout(() => {
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 100,
      })
    }, 50)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]!.event).toBe('init')
    const initData = JSON.parse(events[0]!.data) as { status: string }
    expect(initData.status).toBe('running')
  })

  it('sends init with queued status for new runs', async () => {
    const { runId } = await setupRunForStream(config)

    // The run is in 'queued' status (default). Complete it after a delay.
    setTimeout(() => {
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 50)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const initEvent = events.find((e) => e.event === 'init')
    expect(initEvent).toBeDefined()
    const initData = JSON.parse(initEvent!.data) as { status: string }
    expect(initData.status).toBe('queued')
  })

  // ──────────────────────────────────────────────────────────────────
  // 4. text_delta forwarding from agent:stream_delta
  // ──────────────────────────────────────────────────────────────────

  it('forwards text_delta when bus emits agent:stream_delta', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'Hello world',
      })
      // Small delay then complete
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const delta = events.find((e) => e.event === 'text_delta')
    expect(delta).toBeDefined()
    const deltaData = JSON.parse(delta!.data) as { type: string; content: string }
    expect(deltaData.type).toBe('text_delta')
    expect(deltaData.content).toBe('Hello world')
  })

  it('forwards multiple text_delta events in order', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'chunk-1',
      })
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'chunk-2',
      })
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'chunk-3',
      })
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const deltas = events.filter((e) => e.event === 'text_delta')
    expect(deltas.length).toBe(3)
    expect(JSON.parse(deltas[0]!.data).content).toBe('chunk-1')
    expect(JSON.parse(deltas[1]!.data).content).toBe('chunk-2')
    expect(JSON.parse(deltas[2]!.data).content).toBe('chunk-3')
  })

  // ──────────────────────────────────────────────────────────────────
  // 5. tool_call_start forwarding from tool:called
  // ──────────────────────────────────────────────────────────────────

  it('forwards tool_call_start when bus emits tool:called', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'tool:called',
        toolName: 'web_search',
        input: { query: 'test' },
        executionRunId: runId,
        runId,
        callId: 'tc-42',
      } as Parameters<typeof eventBus.emit>[0])
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const toolStart = events.find((e) => e.event === 'tool_call_start')
    expect(toolStart).toBeDefined()
    const data = JSON.parse(toolStart!.data) as { type: string; toolName: string; callId: string }
    expect(data.type).toBe('tool_call_start')
    expect(data.toolName).toBe('web_search')
    expect(data.callId).toBe('tc-42')
  })

  it('forwards tool_call_start with empty callId when not provided', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'tool:called',
        toolName: 'read_file',
        input: {},
        executionRunId: runId,
        runId,
      } as Parameters<typeof eventBus.emit>[0])
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const toolStart = events.find((e) => e.event === 'tool_call_start')
    expect(toolStart).toBeDefined()
    const data = JSON.parse(toolStart!.data) as { callId: string }
    expect(data.callId).toBe('')
  })

  // ──────────────────────────────────────────────────────────────────
  // 6. tool_call_end forwarding from tool:result
  // ──────────────────────────────────────────────────────────────────

  it('forwards tool_call_end when bus emits tool:result', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'tool:result',
        toolName: 'web_search',
        durationMs: 50,
        executionRunId: runId,
        runId,
        callId: 'tc-99',
        result: { items: [1, 2, 3] },
      } as Parameters<typeof eventBus.emit>[0])
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const toolEnd = events.find((e) => e.event === 'tool_call_end')
    expect(toolEnd).toBeDefined()
    const data = JSON.parse(toolEnd!.data) as { type: string; callId: string; result: unknown }
    expect(data.type).toBe('tool_call_end')
    expect(data.callId).toBe('tc-99')
  })

  // ──────────────────────────────────────────────────────────────────
  // 7. Stream ends with done event on agent:completed
  // ──────────────────────────────────────────────────────────────────

  it('sends done event when bus emits agent:completed', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 100,
        output: 'final answer',
      } as Parameters<typeof eventBus.emit>[0])
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const done = events.find((e) => e.event === 'done')
    expect(done).toBeDefined()
    const data = JSON.parse(done!.data) as { type: string; finalOutput: string }
    expect(data.type).toBe('done')
  })

  it('sends done event when bus emits agent:stream_done', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_done',
        agentId: 'agent-stream',
        runId,
        finalContent: 'stream final content',
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const done = events.find((e) => e.event === 'done')
    expect(done).toBeDefined()
    const data = JSON.parse(done!.data) as { type: string; finalOutput: string }
    expect(data.type).toBe('done')
    expect(data.finalOutput).toBe('stream final content')
  })

  // ──────────────────────────────────────────────────────────────────
  // 8. Stream ends with error event on agent:failed
  // ──────────────────────────────────────────────────────────────────

  it('sends error event when bus emits agent:failed', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:failed',
        agentId: 'agent-stream',
        runId,
        errorCode: 'LLM_TIMEOUT',
        message: 'LLM timed out',
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    const data = JSON.parse(errorEvent!.data) as { type: string; error: { message: string } }
    expect(data.type).toBe('error')
    expect(data.error.message).toContain('LLM timed out')
  })

  it('sends error with errorCode when message is missing', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:failed',
        agentId: 'agent-stream',
        runId,
        errorCode: 'INTERNAL_ERROR',
        message: '',
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
  })

  // ──────────────────────────────────────────────────────────────────
  // 9. Events from other runs are not forwarded
  // ──────────────────────────────────────────────────────────────────

  it('does not forward events from other runs', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      // Emit delta for a different run
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'other-agent',
        runId: 'other-run-id',
        content: 'should not appear',
      })
      // Then complete our run
      setTimeout(() => {
        eventBus.emit({
          type: 'agent:completed',
          agentId: 'agent-stream',
          runId,
          durationMs: 100,
        })
      }, 30)
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const deltas = events.filter((e) => e.event === 'text_delta')
    expect(deltas.length).toBe(0)
  })

  // ──────────────────────────────────────────────────────────────────
  // 10. Full lifecycle: init -> deltas -> tool -> done
  // ──────────────────────────────────────────────────────────────────

  it('receives full lifecycle: init, text_delta, tool_call_start, done', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'Let me search...',
      })
      eventBus.emit({
        type: 'tool:called',
        toolName: 'search',
        input: {},
        executionRunId: runId,
        runId,
        callId: 'tc-1',
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'Found the answer.',
      })
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 200,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const eventTypes = events.map((e) => e.event)
    expect(eventTypes[0]).toBe('init')
    expect(eventTypes).toContain('text_delta')
    expect(eventTypes).toContain('tool_call_start')
    expect(eventTypes).toContain('done')

    // done should be the last event
    expect(eventTypes[eventTypes.length - 1]).toBe('done')
  })

  // ──────────────────────────────────────────────────────────────────
  // 11. Already-completed run emits done via polling
  // ──────────────────────────────────────────────────────────────────

  it('stream ends for already-completed run via polling check', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'completed' })

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res, 5000)
    const events = parseSSEEvents(lines)

    // Should get init and eventually done (from the setInterval poller)
    const initEvent = events.find((e) => e.event === 'init')
    expect(initEvent).toBeDefined()
    const doneEvent = events.find((e) => e.event === 'done')
    expect(doneEvent).toBeDefined()
  })

  it('stream ends for already-failed run via polling check', async () => {
    const agentId = 'agent-stream'
    await config.agentStore.save({
      id: agentId,
      name: 'Stream Agent',
      instructions: 'test agent',
      modelTier: 'chat',
    })
    const run = await config.runStore.create({ agentId, input: { task: 'test' } })
    await config.runStore.update(run.id, { status: 'failed', error: 'boom' })

    const res = await app.request(`/api/runs/${run.id}/stream`)
    const lines = await readSSELines(res, 5000)
    const events = parseSSEEvents(lines)

    const initEvent = events.find((e) => e.event === 'init')
    expect(initEvent).toBeDefined()
    const initData = JSON.parse(initEvent!.data) as { status: string }
    expect(initData.status).toBe('failed')
  })

  // ──────────────────────────────────────────────────────────────────
  // 12. All SSE data fields are valid JSON
  // ──────────────────────────────────────────────────────────────────

  it('all SSE data fields are valid JSON', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'test content',
      })
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    for (const evt of events) {
      expect(() => JSON.parse(evt.data)).not.toThrow()
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // 13. SSE event field matches StreamEvent type
  // ──────────────────────────────────────────────────────────────────

  it('SSE event field matches the data.type discriminator', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'test',
      })
      eventBus.emit({
        type: 'tool:called',
        toolName: 'foo',
        input: {},
        executionRunId: runId,
        runId,
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    // Skip init (which is not a StreamEvent from the handle)
    const streamEvents = events.filter((e) => e.event !== 'init')
    for (const evt of streamEvents) {
      const parsed = JSON.parse(evt.data) as { type: string }
      expect(evt.event).toBe(parsed.type)
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // 14. Interleaved text and tool events maintain order
  // ──────────────────────────────────────────────────────────────────

  it('interleaved text and tool events maintain order', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'before tool',
      })
      eventBus.emit({
        type: 'tool:called',
        toolName: 'search',
        input: {},
        executionRunId: runId,
        runId,
        callId: 'c1',
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'tool:result',
        toolName: 'search',
        durationMs: 10,
        executionRunId: runId,
        runId,
        callId: 'c1',
        result: 'found',
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'after tool',
      })
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    // Remove init, check ordering
    const streamEvents = events.filter((e) => e.event !== 'init')
    const types = streamEvents.map((e) => e.event)
    expect(types).toEqual([
      'text_delta',
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'done',
    ])
  })

  // ──────────────────────────────────────────────────────────────────
  // 15. Unicode content in text_delta
  // ──────────────────────────────────────────────────────────────────

  it('handles unicode content in text_delta', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: 'Hello \u{1F30D} world',
      })
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const delta = events.find((e) => e.event === 'text_delta')
    expect(delta).toBeDefined()
    const data = JSON.parse(delta!.data) as { content: string }
    expect(data.content).toBe('Hello \u{1F30D} world')
  })

  // ──────────────────────────────────────────────────────────────────
  // 16. Multiple tool calls in a single stream
  // ──────────────────────────────────────────────────────────────────

  it('handles multiple tool calls in a single stream', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'tool:called',
        toolName: 'search',
        input: {},
        executionRunId: runId,
        runId,
        callId: 'tc-a',
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'tool:called',
        toolName: 'read',
        input: {},
        executionRunId: runId,
        runId,
        callId: 'tc-b',
      } as Parameters<typeof eventBus.emit>[0])
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const toolStarts = events.filter((e) => e.event === 'tool_call_start')
    expect(toolStarts.length).toBe(2)
    expect(JSON.parse(toolStarts[0]!.data).toolName).toBe('search')
    expect(JSON.parse(toolStarts[1]!.data).toolName).toBe('read')
  })

  // ──────────────────────────────────────────────────────────────────
  // 17. Empty content text_delta
  // ──────────────────────────────────────────────────────────────────

  it('forwards text_delta with empty string content', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_delta',
        agentId: 'agent-stream',
        runId,
        content: '',
      })
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const delta = events.find((e) => e.event === 'text_delta')
    expect(delta).toBeDefined()
    const data = JSON.parse(delta!.data) as { content: string }
    expect(data.content).toBe('')
  })

  // ──────────────────────────────────────────────────────────────────
  // 18. Burst of text_delta events
  // ──────────────────────────────────────────────────────────────────

  it('handles a burst of 20 text_delta events', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      for (let i = 0; i < 20; i++) {
        eventBus.emit({
          type: 'agent:stream_delta',
          agentId: 'agent-stream',
          runId,
          content: `chunk-${i}`,
        })
      }
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 50,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const deltas = events.filter((e) => e.event === 'text_delta')
    expect(deltas.length).toBe(20)
    for (let i = 0; i < 20; i++) {
      expect(JSON.parse(deltas[i]!.data).content).toBe(`chunk-${i}`)
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // 19. done event includes finalOutput
  // ──────────────────────────────────────────────────────────────────

  it('done event includes finalOutput from agent:stream_done', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_done',
        agentId: 'agent-stream',
        runId,
        finalContent: 'the final answer is 42',
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const done = events.find((e) => e.event === 'done')
    expect(done).toBeDefined()
    const data = JSON.parse(done!.data) as { finalOutput: string }
    expect(data.finalOutput).toBe('the final answer is 42')
  })

  // ──────────────────────────────────────────────────────────────────
  // 20. Cancelled run via polling
  // ──────────────────────────────────────────────────────────────────

  it('stream ends for cancelled run via polling check', async () => {
    const agentId = 'agent-stream'
    await config.agentStore.save({
      id: agentId,
      name: 'Stream Agent',
      instructions: 'test agent',
      modelTier: 'chat',
    })
    const run = await config.runStore.create({ agentId, input: { task: 'test' } })
    await config.runStore.update(run.id, { status: 'cancelled' })

    const res = await app.request(`/api/runs/${run.id}/stream`)
    const lines = await readSSELines(res, 5000)
    const events = parseSSEEvents(lines)

    const initEvent = events.find((e) => e.event === 'init')
    expect(initEvent).toBeDefined()
    const initData = JSON.parse(initEvent!.data) as { status: string }
    expect(initData.status).toBe('cancelled')
  })

  // ──────────────────────────────────────────────────────────────────
  // 21b. memoryFrame exposure
  // ──────────────────────────────────────────────────────────────────

  it('emits run:memory-frame before done when run.metadata.memoryFrame is set (agent:completed)', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    // Stash a memoryFrame on the run metadata so the stream handler can find it.
    await config.runStore.update(runId, {
      metadata: { memoryFrame: { snapshot: 'frozen-v1', rows: 3 } },
    })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 100,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const frame = events.find((e) => e.event === 'run:memory-frame')
    expect(frame).toBeDefined()
    const frameData = JSON.parse(frame!.data) as { runId: string; memoryFrame: unknown }
    expect(frameData.runId).toBe(runId)
    expect(frameData.memoryFrame).toEqual({ snapshot: 'frozen-v1', rows: 3 })

    // run:memory-frame must precede the done event
    const frameIdx = events.findIndex((e) => e.event === 'run:memory-frame')
    const doneIdx = events.findIndex((e) => e.event === 'done')
    expect(frameIdx).toBeLessThan(doneIdx)
  })

  it('emits run:memory-frame before done when run.metadata.memoryFrame is set (agent:stream_done)', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    await config.runStore.update(runId, {
      metadata: { memoryFrame: { snapshot: 'frozen-v2' } },
    })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:stream_done',
        agentId: 'agent-stream',
        runId,
        finalContent: 'done via stream_done',
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const frame = events.find((e) => e.event === 'run:memory-frame')
    expect(frame).toBeDefined()
    const frameData = JSON.parse(frame!.data) as { runId: string; memoryFrame: unknown }
    expect(frameData.memoryFrame).toEqual({ snapshot: 'frozen-v2' })

    const frameIdx = events.findIndex((e) => e.event === 'run:memory-frame')
    const doneIdx = events.findIndex((e) => e.event === 'done')
    expect(frameIdx).toBeLessThan(doneIdx)
  })

  it('does NOT emit run:memory-frame when run.metadata.memoryFrame is absent', async () => {
    const { runId } = await setupRunForStream(config, { runStatus: 'running' })

    setTimeout(() => {
      eventBus.emit({
        type: 'agent:completed',
        agentId: 'agent-stream',
        runId,
        durationMs: 100,
      })
    }, 30)

    const res = await app.request(`/api/runs/${runId}/stream`)
    const lines = await readSSELines(res)
    const events = parseSSEEvents(lines)

    const frame = events.find((e) => e.event === 'run:memory-frame')
    expect(frame).toBeUndefined()

    // Sanity: done still fires
    const done = events.find((e) => e.event === 'done')
    expect(done).toBeDefined()
  })

  // ──────────────────────────────────────────────────────────────────
  // 21. Rejected run via polling
  // ──────────────────────────────────────────────────────────────────

  it('stream ends for rejected run via polling check', async () => {
    const agentId = 'agent-stream'
    await config.agentStore.save({
      id: agentId,
      name: 'Stream Agent',
      instructions: 'test agent',
      modelTier: 'chat',
    })
    const run = await config.runStore.create({ agentId, input: { task: 'test' } })
    await config.runStore.update(run.id, { status: 'rejected' })

    const res = await app.request(`/api/runs/${run.id}/stream`)
    const lines = await readSSELines(res, 5000)
    const events = parseSSEEvents(lines)

    const initEvent = events.find((e) => e.event === 'init')
    expect(initEvent).toBeDefined()
  })
})

describe('GET /api/runs/:id/stream — keep-alive ping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ping event appears when keep-alive fires (mock timer)', async () => {
    // Override the SSE_KEEPALIVE_INTERVAL_MS env to a small value
    const originalEnv = process.env['SSE_KEEPALIVE_INTERVAL_MS']
    process.env['SSE_KEEPALIVE_INTERVAL_MS'] = '100'

    const config = createTestConfig()
    const app = createForgeApp(config)

    await config.agentStore.save({
      id: 'agent-ping',
      name: 'Ping Agent',
      instructions: 'test',
      modelTier: 'chat',
    })
    const run = await config.runStore.create({ agentId: 'agent-ping', input: {} })
    await config.runStore.update(run.id, { status: 'running' })

    const resPromise = app.request(`/api/runs/${run.id}/stream`)

    // Advance timers to trigger keep-alive ping
    await vi.advanceTimersByTimeAsync(200)

    // Complete the run so the stream ends
    config.eventBus.emit({
      type: 'agent:completed',
      agentId: 'agent-ping',
      runId: run.id,
      durationMs: 50,
    })
    await vi.advanceTimersByTimeAsync(100)

    const res = await resPromise
    const lines = await readSSELines(res, 500)
    const events = parseSSEEvents(lines)

    // We expect at least one ping event
    const pings = events.filter((e) => e.event === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(1)
    expect(pings[0]!.data).toBe('{}')

    // Restore env
    if (originalEnv === undefined) {
      delete process.env['SSE_KEEPALIVE_INTERVAL_MS']
    } else {
      process.env['SSE_KEEPALIVE_INTERVAL_MS'] = originalEnv
    }
  })
})
