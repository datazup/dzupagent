/**
 * Composable for WebSocket connections with exponential backoff reconnection.
 *
 * Provides reactive connection state and automatic reconnection (max 5 retries).
 *
 * @example
 * ```ts
 * const { connect, disconnect, state, lastEvent } = useWebSocket()
 * connect('ws://localhost:4000/ws?runId=abc')
 * watch(lastEvent, (event) => { ... })
 * ```
 */
import { ref, onUnmounted, type Ref } from 'vue'
import type { WsConnectionState, WsEvent } from '../types.js'

const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000

interface UseWebSocketOptions {
  /** Maximum reconnection attempts (default: 5) */
  maxRetries?: number
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number
  /** Called when a message is received */
  onMessage?: (event: WsEvent) => void
}

interface UseWebSocketReturn {
  /** Current connection state */
  state: Ref<WsConnectionState>
  /** Last received event */
  lastEvent: Ref<WsEvent | null>
  /** Current retry count */
  retryCount: Ref<number>
  /** Open a WebSocket connection */
  connect: (url: string) => void
  /** Close the connection (no auto-reconnect) */
  disconnect: () => void
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  const baseDelay = options.baseDelay ?? BASE_DELAY_MS

  const state = ref<WsConnectionState>('disconnected')
  const lastEvent = ref<WsEvent | null>(null)
  const retryCount = ref(0)

  let ws: WebSocket | null = null
  let currentUrl = ''
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose || retryCount.value >= maxRetries) {
      state.value = retryCount.value >= maxRetries ? 'error' : 'disconnected'
      return
    }

    const delay = baseDelay * Math.pow(2, retryCount.value)
    retryCount.value++

    reconnectTimer = setTimeout(() => {
      connect(currentUrl)
    }, delay)
  }

  function connect(url: string): void {
    // Clean up existing connection
    if (ws) {
      intentionalClose = true
      ws.close()
      ws = null
    }

    intentionalClose = false
    currentUrl = url
    state.value = 'connecting'

    try {
      ws = new WebSocket(url)
    } catch {
      state.value = 'error'
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      state.value = 'connected'
      retryCount.value = 0
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as WsEvent
        lastEvent.value = data
        options.onMessage?.(data)
      } catch {
        // Ignore non-JSON messages
      }
    }

    ws.onclose = () => {
      ws = null
      if (!intentionalClose) {
        state.value = 'disconnected'
        scheduleReconnect()
      } else {
        state.value = 'disconnected'
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    }
  }

  function disconnect(): void {
    intentionalClose = true
    clearReconnectTimer()
    retryCount.value = 0

    if (ws) {
      ws.close()
      ws = null
    }

    state.value = 'disconnected'
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    state,
    lastEvent,
    retryCount,
    connect,
    disconnect,
  }
}
