/**
 * WebSocket store -- manages WebSocket connection state for the playground.
 *
 * Wraps the useWebSocket composable in a Pinia store so connection
 * state is shared across all components.
 *
 * @module ws-store
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { WsConnectionState, WsEvent, WsSubscriptionFilter } from '../types.js'

export const useWsStore = defineStore('ws', () => {
  // ── State ─────────────────────────────────────────
  const state = ref<WsConnectionState>('disconnected')
  const lastEvent = ref<WsEvent | null>(null)
  const retryCount = ref(0)
  const eventLog = ref<WsEvent[]>([])
  const subscription = ref<WsSubscriptionFilter | null>(null)

  /** Internal refs for WebSocket management */
  let ws: WebSocket | null = null
  let currentUrl = ''
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false

  const MAX_RETRIES = 5
  const BASE_DELAY_MS = 1000
  const MAX_EVENT_LOG = 200

  // ── Getters ───────────────────────────────────────
  const isConnected = computed(() => state.value === 'connected')

  // ── Actions ───────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose || retryCount.value >= MAX_RETRIES) {
      state.value = retryCount.value >= MAX_RETRIES ? 'error' : 'disconnected'
      return
    }

    clearReconnectTimer()
    const delay = BASE_DELAY_MS * Math.pow(2, retryCount.value)
    retryCount.value++

    reconnectTimer = setTimeout(() => {
      connect(currentUrl)
    }, delay)
  }

  function sendJson(data: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    try {
      ws.send(JSON.stringify(data))
      return true
    } catch {
      return false
    }
  }

  function sendSubscription(filter: WsSubscriptionFilter): void {
    sendJson({ type: 'subscribe', filter })
  }

  /** Connect to a WebSocket URL */
  function connect(url: string): void {
    clearReconnectTimer()

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
      if (subscription.value) {
        sendSubscription(subscription.value)
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as WsEvent
        lastEvent.value = data

        // Keep bounded event log
        if (eventLog.value.length >= MAX_EVENT_LOG) {
          eventLog.value = eventLog.value.slice(-Math.floor(MAX_EVENT_LOG / 2))
        }
        eventLog.value.push(data)
      } catch {
        // Non-JSON messages ignored
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
      // onclose fires after onerror
    }
  }

  /** Disconnect and stop reconnection */
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

  /** Clear the event log */
  function clearEventLog(): void {
    eventLog.value = []
    lastEvent.value = null
  }

  function setSubscription(filter: WsSubscriptionFilter | null): void {
    subscription.value = filter
    if (filter) {
      sendSubscription(filter)
    } else {
      sendJson({ type: 'unsubscribe' })
    }
  }

  return {
    // State
    state,
    lastEvent,
    retryCount,
    eventLog,
    subscription,

    // Getters
    isConnected,

    // Actions
    connect,
    disconnect,
    clearEventLog,
    setSubscription,
  }
})
