/**
 * Tests for the WebSocket Pinia store.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWsStore } from '../stores/ws-store.js'

// Mock WebSocket
class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(_url: string) {
    // Simulate async open
    setTimeout(() => {
      this.onopen?.()
    }, 0)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  send(_data: string): void {
    // no-op
  }
}

// Install mock
vi.stubGlobal('WebSocket', MockWebSocket)

describe('ws-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts disconnected', () => {
    const store = useWsStore()
    expect(store.state).toBe('disconnected')
    expect(store.isConnected).toBe(false)
    expect(store.retryCount).toBe(0)
  })

  it('connect transitions to connecting then connected', async () => {
    const store = useWsStore()

    store.connect('ws://localhost:4000/ws')
    expect(store.state).toBe('connecting')

    // Flush the setTimeout in MockWebSocket constructor
    await vi.advanceTimersByTimeAsync(1)

    expect(store.state).toBe('connected')
    expect(store.isConnected).toBe(true)
  })

  it('disconnect transitions to disconnected', async () => {
    const store = useWsStore()

    store.connect('ws://localhost:4000/ws')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.state).toBe('connected')

    store.disconnect()
    expect(store.state).toBe('disconnected')
    expect(store.isConnected).toBe(false)
  })

  it('disconnect resets retry count', async () => {
    const store = useWsStore()

    store.connect('ws://localhost:4000/ws')
    await vi.advanceTimersByTimeAsync(1)

    store.disconnect()
    expect(store.retryCount).toBe(0)
  })

  it('clearEventLog clears events and lastEvent', async () => {
    const store = useWsStore()

    store.connect('ws://localhost:4000/ws')
    await vi.advanceTimersByTimeAsync(1)

    // Manually set some state to verify clearing
    store.eventLog = [{ type: 'test', timestamp: '2025-01-01T00:00:00Z' }]
    store.lastEvent = { type: 'test' }

    store.clearEventLog()

    expect(store.eventLog).toEqual([])
    expect(store.lastEvent).toBeNull()
  })
})
