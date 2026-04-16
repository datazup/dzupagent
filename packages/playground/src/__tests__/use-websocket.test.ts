/**
 * Tests for the useWebSocket composable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  url: string

  constructor(url: string) {
    this.url = url
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

  /** Simulate receiving a message from the server */
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  /** Simulate an error followed by close */
  simulateError(): void {
    this.onerror?.()
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  /** Simulate unexpected close (server drops connection) */
  simulateUnexpectedClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

import { useWebSocket } from '../composables/useWebSocket.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createComposable(options?: Parameters<typeof useWebSocket>[0]) {
  const scope = effectScope()
  const result = scope.run(() => useWebSocket(options))!
  return { scope, ...result }
}

function getLatestWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Initial state ────────────────────────────────────

  describe('initial state', () => {
    it('starts disconnected', () => {
      const { state } = createComposable()
      expect(state.value).toBe('disconnected')
    })

    it('starts with lastEvent as null', () => {
      const { lastEvent } = createComposable()
      expect(lastEvent.value).toBeNull()
    })

    it('starts with retryCount at 0', () => {
      const { retryCount } = createComposable()
      expect(retryCount.value).toBe(0)
    })
  })

  // ── connect ──────────────────────────────────────────

  describe('connect', () => {
    it('transitions to connecting on connect()', () => {
      const { connect, state } = createComposable()
      connect('ws://localhost:4000/ws')
      expect(state.value).toBe('connecting')
    })

    it('transitions to connected after WebSocket opens', async () => {
      const { connect, state } = createComposable()
      connect('ws://localhost:4000/ws')

      await vi.advanceTimersByTimeAsync(1)
      expect(state.value).toBe('connected')
    })

    it('resets retryCount on successful connection', async () => {
      const { connect, retryCount } = createComposable()
      connect('ws://localhost:4000/ws')

      await vi.advanceTimersByTimeAsync(1)
      expect(retryCount.value).toBe(0)
    })

    it('creates a new WebSocket instance', () => {
      const { connect } = createComposable()
      connect('ws://localhost:4000/ws')
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(getLatestWs().url).toBe('ws://localhost:4000/ws')
    })

    it('closes existing WebSocket before creating a new one', async () => {
      const { connect } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      const firstWs = getLatestWs()
      connect('ws://localhost:4000/ws?runId=2')

      expect(firstWs.readyState).toBe(MockWebSocket.CLOSED)
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  // ── Message handling ─────────────────────────────────

  describe('message handling', () => {
    it('populates lastEvent with parsed JSON message', async () => {
      const { connect, lastEvent } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      getLatestWs().simulateMessage({ type: 'agent:started', runId: 'r1' })
      expect(lastEvent.value).toEqual({ type: 'agent:started', runId: 'r1' })
    })

    it('updates lastEvent on each new message', async () => {
      const { connect, lastEvent } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      getLatestWs().simulateMessage({ type: 'event-1' })
      expect(lastEvent.value!.type).toBe('event-1')

      getLatestWs().simulateMessage({ type: 'event-2' })
      expect(lastEvent.value!.type).toBe('event-2')
    })

    it('calls onMessage callback when provided', async () => {
      const onMessage = vi.fn()
      const { connect } = createComposable({ onMessage })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      getLatestWs().simulateMessage({ type: 'tool:called' })
      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:called' }))
    })

    it('ignores non-JSON messages silently', async () => {
      const { connect, lastEvent } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      // Send raw non-JSON string
      getLatestWs().onmessage?.({ data: 'not-json' })
      expect(lastEvent.value).toBeNull()
    })
  })

  // ── disconnect ───────────────────────────────────────

  describe('disconnect', () => {
    it('transitions to disconnected', async () => {
      const { connect, disconnect, state } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      disconnect()
      expect(state.value).toBe('disconnected')
    })

    it('resets retryCount to 0', async () => {
      const { connect, disconnect, retryCount } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      disconnect()
      expect(retryCount.value).toBe(0)
    })

    it('closes the WebSocket', async () => {
      const { connect, disconnect } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      const ws = getLatestWs()
      disconnect()
      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    })

    it('prevents auto-reconnect after intentional disconnect', async () => {
      const { connect, disconnect, state } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      disconnect()

      // Even after waiting a long time, no reconnect attempt
      await vi.advanceTimersByTimeAsync(60_000)
      expect(state.value).toBe('disconnected')
      expect(MockWebSocket.instances).toHaveLength(1)
    })
  })

  // ── Auto-reconnect ──────────────────────────────────

  describe('auto-reconnect', () => {
    it('attempts reconnect on unexpected close', async () => {
      const { connect, retryCount } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      getLatestWs().simulateUnexpectedClose()
      expect(retryCount.value).toBe(1)

      // Wait for base delay (1000ms)
      await vi.advanceTimersByTimeAsync(1000)
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    it('uses exponential backoff for reconnect delays', async () => {
      const { connect, retryCount } = createComposable({ baseDelay: 100 })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      // First unexpected close — retry after 100ms (100 * 2^0)
      getLatestWs().simulateUnexpectedClose()
      expect(retryCount.value).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(MockWebSocket.instances).toHaveLength(2)

      // Second unexpected close — retry after 200ms (100 * 2^1)
      getLatestWs().simulateUnexpectedClose()
      expect(retryCount.value).toBe(2)
      await vi.advanceTimersByTimeAsync(199)
      expect(MockWebSocket.instances).toHaveLength(2) // not yet
      await vi.advanceTimersByTimeAsync(1)
      expect(MockWebSocket.instances).toHaveLength(3)
    })

    it('increments retryCount on unexpected close', async () => {
      const { connect, retryCount } = createComposable({ baseDelay: 10 })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)
      expect(retryCount.value).toBe(0)

      getLatestWs().simulateUnexpectedClose()
      expect(retryCount.value).toBe(1)
    })

    it('resets retryCount when reconnection succeeds', async () => {
      const { connect, retryCount } = createComposable({ baseDelay: 10 })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      // Unexpected close
      getLatestWs().simulateUnexpectedClose()
      expect(retryCount.value).toBe(1)

      // Wait for backoff + constructor open
      await vi.advanceTimersByTimeAsync(11)
      expect(retryCount.value).toBe(0)
    })

    it('state transitions through reconnect cycle', async () => {
      const { connect, state } = createComposable({ baseDelay: 10 })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)
      expect(state.value).toBe('connected')

      getLatestWs().simulateUnexpectedClose()
      expect(state.value).toBe('disconnected')

      // Wait for reconnect
      await vi.advanceTimersByTimeAsync(11)
      expect(state.value).toBe('connected')
    })
  })

  // ── onUnmounted cleanup ──────────────────────────────

  describe('cleanup via disconnect', () => {
    it('disconnect after connect cleans up completely', async () => {
      const { connect, disconnect, state } = createComposable()
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)
      expect(state.value).toBe('connected')

      disconnect()
      expect(state.value).toBe('disconnected')

      // No further reconnect attempts
      await vi.advanceTimersByTimeAsync(60_000)
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('no reconnect attempts after disconnect even with prior retries', async () => {
      const { connect, disconnect } = createComposable({ baseDelay: 100 })
      connect('ws://localhost:4000/ws')
      await vi.advanceTimersByTimeAsync(1)

      // Simulate one unexpected close to start reconnect cycle
      getLatestWs().simulateUnexpectedClose()
      // Now disconnect before reconnect fires
      disconnect()

      const countAfterDisconnect = MockWebSocket.instances.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(MockWebSocket.instances.length).toBe(countAfterDisconnect)
    })
  })
})
