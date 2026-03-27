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
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  sentMessages: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
    // Simulate async open
    setTimeout(() => {
      this.onopen?.()
    }, 0)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }
}

// Install mock
vi.stubGlobal('WebSocket', MockWebSocket)

describe('ws-store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    MockWebSocket.instances = []
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

  it('sends subscription message after connect when subscription exists', async () => {
    const store = useWsStore()
    store.setSubscription({ runId: 'run-1' })

    store.connect('ws://localhost:4000/ws')
    await vi.advanceTimersByTimeAsync(1)

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    expect(ws?.sentMessages.length).toBe(1)

    const payload = JSON.parse(ws?.sentMessages[0] ?? '{}') as { type?: string; filter?: { runId?: string } }
    expect(payload.type).toBe('subscribe')
    expect(payload.filter?.runId).toBe('run-1')
  })

  it('can update subscription while connected', async () => {
    const store = useWsStore()
    store.connect('ws://localhost:4000/ws')
    await vi.advanceTimersByTimeAsync(1)

    store.setSubscription({ agentId: 'agent-1', eventTypes: ['agent:started'] })

    const ws = MockWebSocket.instances[0]
    const payload = JSON.parse(ws?.sentMessages[0] ?? '{}') as { type?: string; filter?: { agentId?: string } }
    expect(payload.type).toBe('subscribe')
    expect(payload.filter?.agentId).toBe('agent-1')
  })
})
