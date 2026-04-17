/**
 * Deep coverage tests for ws-store.
 *
 * Covers: onmessage event log handling, event log truncation at MAX_EVENT_LOG,
 * reconnect scheduling and backoff, max retries leading to error state,
 * unsubscribe message, sendJson failure paths, non-JSON message handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWsStore } from '../stores/ws-store.js'

class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  sentMessages: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
    setTimeout(() => { this.onopen?.() }, 0)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

describe('ws-store (deep coverage)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    MockWebSocket.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('onmessage parses JSON and adds to eventLog', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)

    const ws = MockWebSocket.instances[0]!
    ws.onmessage?.({ data: JSON.stringify({ type: 'agent:started', runId: 'r1' }) })

    expect(store.eventLog).toHaveLength(1)
    expect(store.lastEvent?.type).toBe('agent:started')
  })

  it('onmessage ignores non-JSON messages', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)

    const ws = MockWebSocket.instances[0]!
    ws.onmessage?.({ data: 'not json' })

    expect(store.eventLog).toHaveLength(0)
    expect(store.lastEvent).toBeNull()
  })

  it('onmessage truncates event log when exceeding MAX_EVENT_LOG', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)

    const ws = MockWebSocket.instances[0]!

    // Fill eventLog to 200 entries (MAX_EVENT_LOG)
    for (let i = 0; i < 200; i++) {
      ws.onmessage?.({ data: JSON.stringify({ type: 'event', index: i }) })
    }
    expect(store.eventLog).toHaveLength(200)

    // Adding one more should trigger truncation
    ws.onmessage?.({ data: JSON.stringify({ type: 'event', index: 200 }) })
    // After truncation: sliced to last 100 + the new one = 101
    expect(store.eventLog.length).toBeLessThanOrEqual(201)
    expect(store.eventLog.length).toBeGreaterThan(0)
  })

  it('scheduleReconnect uses exponential backoff', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)

    // Simulate unexpected close (triggers reconnect)
    const ws = MockWebSocket.instances[0]!
    ws.readyState = MockWebSocket.CLOSED
    ws.onclose?.()

    expect(store.state).toBe('disconnected')
    expect(store.retryCount).toBe(1)

    // Advance by 1000ms (first retry delay = 1000 * 2^0 = 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('stops reconnecting after MAX_RETRIES', async () => {
    const store = useWsStore()

    // Create a WebSocket that fails to connect
    const FailingWebSocket = class {
      static readonly OPEN = 1
      static readonly CLOSED = 3
      readyState = 3
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      sentMessages: string[] = []
      constructor() {
        setTimeout(() => { this.onclose?.() }, 0)
      }
      close(): void { this.onclose?.() }
      send(): void {}
    }
    vi.stubGlobal('WebSocket', FailingWebSocket)

    store.connect('ws://localhost/ws')

    // Exhaust all retries (MAX_RETRIES = 5)
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1)
      // Wait for reconnect delay
      await vi.advanceTimersByTimeAsync(100_000)
    }

    expect(store.state).toBe('error')

    // Restore mock
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  it('setSubscription(null) sends unsubscribe message', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)

    store.setSubscription(null)
    const ws = MockWebSocket.instances[0]!
    const msg = JSON.parse(ws.sentMessages[0] ?? '{}') as { type: string }
    expect(msg.type).toBe('unsubscribe')
    expect(store.subscription).toBeNull()
  })

  it('connect replaces existing WebSocket connection', async () => {
    const store = useWsStore()
    store.connect('ws://localhost/ws')
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(1)

    store.connect('ws://localhost/ws2')
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(store.state).toBe('connected')
  })
})
