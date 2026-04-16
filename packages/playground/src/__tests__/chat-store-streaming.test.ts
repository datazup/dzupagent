/**
 * Tests for connectStreamingRun SSE action in chat-store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../stores/chat-store.js'

// ── Mock EventSource ─────────────────────────────────────

type EventHandler = (event: MessageEvent | Event) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  listeners = new Map<string, EventHandler[]>()
  closed = false

  constructor(public url: string) {
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: EventHandler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(handler)
  }

  close(): void {
    this.closed = true
  }

  /** Test helper: emit a named SSE event with JSON data */
  emit(type: string, data?: unknown): void {
    const event =
      data !== undefined
        ? new MessageEvent(type, { data: JSON.stringify(data) })
        : new Event(type)
    this.listeners.get(type)?.forEach((h) => h(event))
  }

  /** Test helper: emit an error Event (no data) */
  emitBareError(): void {
    const event = new Event('error')
    this.listeners.get('error')?.forEach((h) => h(event))
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// ── Mock useApi (required by chat-store) ─────────────────

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: { id: 'run-1', status: 'queued' } })),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

// ── Tests ────────────────────────────────────────────────

describe('connectStreamingRun', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockEventSource.instances = []
  })

  function latestSource(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1]!
  }

  it('returns a cleanup function', () => {
    const store = useChatStore()
    const cleanup = store.connectStreamingRun('run-1')
    expect(typeof cleanup).toBe('function')
  })

  it('opens EventSource to correct URL', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-42')
    expect(latestSource().url).toBe('/api/runs/run-42/stream')
  })

  it('text_delta events append to streaming message content', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'Hello' })

    const assistantMsgs = store.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]?.content).toBe('Hello')
  })

  it('multiple text_delta events accumulate in order', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'Hello' })
    source.emit('text_delta', { delta: ' ' })
    source.emit('text_delta', { delta: 'world' })

    const assistantMsgs = store.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]?.content).toBe('Hello world')
  })

  it('done event finalizes the streaming message with finalContent', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'partial' })
    source.emit('done', { finalContent: 'complete response' })

    const assistantMsgs = store.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]?.content).toBe('complete response')
  })

  it('done event closes the EventSource', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'data' })
    source.emit('done', { finalContent: 'final' })

    expect(source.closed).toBe(true)
  })

  it('done event without finalContent still closes and cleans up', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'data' })
    source.emit('done', {})

    expect(source.closed).toBe(true)
  })

  it('error event with data sets error state and closes EventSource', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('error', { message: 'Model overloaded' })

    expect(source.closed).toBe(true)
    expect(store.error).toBe('Model overloaded')
  })

  it('error event without data sets generic error message', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emitBareError()

    expect(source.closed).toBe(true)
    expect(store.error).toBe('SSE stream error')
  })

  it('error event with malformed JSON sets generic error', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    // Emit a MessageEvent with non-JSON data
    const event = new MessageEvent('error', { data: 'not json' })
    source.listeners.get('error')?.forEach((h) => h(event))

    expect(source.closed).toBe(true)
    expect(store.error).toBe('SSE stream error')
  })

  it('ping events are ignored (no message appended)', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('ping', {})
    source.emit('ping', {})

    expect(store.messages).toHaveLength(0)
  })

  it('cleanup function closes EventSource when called', () => {
    const store = useChatStore()
    const cleanup = store.connectStreamingRun('run-1')
    const source = latestSource()

    expect(source.closed).toBe(false)
    cleanup()
    expect(source.closed).toBe(true)
  })

  it('multiple concurrent runs get separate streaming buffers', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-A')
    const sourceA = latestSource()

    store.connectStreamingRun('run-B')
    const sourceB = latestSource()

    sourceA.emit('text_delta', { delta: 'From A' })
    sourceB.emit('text_delta', { delta: 'From B' })

    const assistantMsgs = store.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(2)

    const msgA = assistantMsgs.find((m) => m.id.includes('run-A'))
    const msgB = assistantMsgs.find((m) => m.id.includes('run-B'))
    expect(msgA?.content).toBe('From A')
    expect(msgB?.content).toBe('From B')
  })

  it('text_delta with empty delta does not create a message', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: '' })

    expect(store.messages).toHaveLength(0)
  })

  it('text_delta with missing delta field does not create a message', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { something: 'else' })

    expect(store.messages).toHaveLength(0)
  })

  it('tool_call_start and tool_call_end events do not add messages', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('tool_call_start', { toolName: 'search', callId: 'c1' })
    source.emit('tool_call_end', { callId: 'c1', result: 'found' })

    expect(store.messages).toHaveLength(0)
  })

  it('clearMessages removes SSE-created streaming messages', () => {
    const store = useChatStore()
    store.connectStreamingRun('run-1')
    const source = latestSource()

    source.emit('text_delta', { delta: 'streaming...' })
    expect(store.messages).toHaveLength(1)

    store.clearMessages()
    expect(store.messages).toHaveLength(0)
  })
})
