/**
 * Composable for subscribing to live WebSocket event streams from a ForgeAgent run.
 *
 * Provides a reactive event list that accumulates events from the WebSocket,
 * auto-reconnects on disconnect, and buffers events when the tab is not visible.
 *
 * @module useEventStream
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import { useWsStore } from '../stores/ws-store.js'
import type { WsEvent } from '../types.js'

/** Maximum events to retain before pruning oldest half */
const MAX_EVENTS = 2000

/**
 * A replay-compatible event shape derived from WebSocket events.
 * Each event has a type, timestamp, and an arbitrary payload.
 */
export interface ReplayEvent {
  /** Unique event ID */
  id: string
  /** Event type, e.g. 'tool:called', 'memory:written', 'agent:stream_delta' */
  type: string
  /** ISO timestamp of when the event occurred */
  timestamp: string
  /** Run ID this event belongs to */
  runId: string
  /** Arbitrary event payload */
  payload: Record<string, unknown>
}

/**
 * Convert a WsEvent to a ReplayEvent.
 */
function wsEventToReplayEvent(event: WsEvent): ReplayEvent | null {
  const type = event.type
  if (!type) return null

  const runId = (event.runId ?? event.payload?.['runId'] ?? '') as string
  const timestamp =
    (event.timestamp as string | undefined) ?? new Date().toISOString()
  const id =
    (event.id as string | undefined) ??
    `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

  const payload: Record<string, unknown> = { ...event.payload }
  // Hoist top-level fields into payload for uniform access
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'id' && key !== 'type' && key !== 'timestamp' && key !== 'runId' && key !== 'payload' && key !== 'version') {
      payload[key] = value
    }
  }

  return { id, type, timestamp, runId, payload }
}

export interface UseEventStreamReturn {
  /** Accumulated replay events from the WebSocket stream */
  events: Ref<ReplayEvent[]>
  /** Whether the WebSocket is currently connected */
  isConnected: Ref<boolean>
  /** Current connection error message, or null */
  connectionError: Ref<string | null>
  /** Connect to the WebSocket and subscribe to a run */
  connect: () => void
  /** Disconnect from the WebSocket */
  disconnect: () => void
  /** Clear all accumulated events */
  clearEvents: () => void
}

/**
 * Composable for subscribing to live WebSocket event streams.
 *
 * Connects to the playground WebSocket store and filters events for the given runId.
 * Buffers events when the document is hidden (Page Visibility API) and flushes
 * them when the tab becomes visible again.
 *
 * @param serverUrl - Reactive ref with the WebSocket server URL
 * @param runId - Reactive ref with the current run ID (null = not subscribed)
 * @returns Reactive event stream state and control methods
 */
export function useEventStream(
  serverUrl: Ref<string>,
  runId: Ref<string | null>,
): UseEventStreamReturn {
  const events = ref<ReplayEvent[]>([])
  const isConnected = ref(false)
  const connectionError = ref<string | null>(null)

  const wsStore = useWsStore()

  /** Buffer for events received while the tab is hidden */
  let visibilityBuffer: ReplayEvent[] = []
  let isTabVisible = true

  // ── Visibility buffering ─────────────────────────────

  function handleVisibilityChange(): void {
    if (document.hidden) {
      isTabVisible = false
    } else {
      isTabVisible = true
      // Flush buffered events
      if (visibilityBuffer.length > 0) {
        appendEvents(visibilityBuffer)
        visibilityBuffer = []
      }
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  // ── Event management ─────────────────────────────────

  function appendEvents(newEvents: ReplayEvent[]): void {
    const current = events.value
    if (current.length + newEvents.length > MAX_EVENTS) {
      // Prune oldest half when exceeding max
      const pruned = current.slice(-Math.floor(MAX_EVENTS / 2))
      events.value = [...pruned, ...newEvents]
    } else {
      events.value = [...current, ...newEvents]
    }
  }

  function appendEvent(event: ReplayEvent): void {
    if (!isTabVisible) {
      visibilityBuffer.push(event)
      return
    }
    appendEvents([event])
  }

  // ── WebSocket event processing ───────────────────────

  function processWsEvent(wsEvent: WsEvent): void {
    const currentRunId = runId.value
    if (!currentRunId) return

    // Filter events to the subscribed run
    const eventRunId = (wsEvent.runId ?? wsEvent.payload?.['runId']) as string | undefined
    if (eventRunId && eventRunId !== currentRunId) return

    const replayEvent = wsEventToReplayEvent(wsEvent)
    if (replayEvent) {
      // Ensure runId is set on the event
      if (!replayEvent.runId) {
        replayEvent.runId = currentRunId
      }
      appendEvent(replayEvent)
    }
  }

  // Watch for new WsStore events
  const stopWsWatch = watch(
    () => wsStore.lastEvent,
    (event) => {
      if (!event) return
      processWsEvent(event)
    },
  )

  // Sync connection state
  const stopStateWatch = watch(
    () => wsStore.state,
    (state) => {
      isConnected.value = state === 'connected'
      if (state === 'error') {
        connectionError.value = 'WebSocket connection failed after max retries'
      } else if (state === 'connected') {
        connectionError.value = null
      }
    },
    { immediate: true },
  )

  // ── Public methods ───────────────────────────────────

  function connect(): void {
    connectionError.value = null
    const url = serverUrl.value
    if (!url) {
      connectionError.value = 'No server URL provided'
      return
    }
    wsStore.connect(url)

    // Subscribe to run events if we have a runId
    const currentRunId = runId.value
    if (currentRunId) {
      wsStore.setSubscription({
        runId: currentRunId,
        eventTypes: [
          'agent:started',
          'agent:completed',
          'agent:failed',
          'agent:stream_delta',
          'agent:stream_done',
          'tool:called',
          'tool:result',
          'tool:error',
          'memory:written',
          'memory:searched',
          'memory:error',
          'pipeline:phase_changed',
        ],
      })
    }
  }

  function disconnect(): void {
    wsStore.disconnect()
    isConnected.value = false
  }

  function clearEvents(): void {
    events.value = []
    visibilityBuffer = []
  }

  // Re-subscribe when runId changes
  const stopRunIdWatch = watch(runId, (newRunId) => {
    if (newRunId && isConnected.value) {
      wsStore.setSubscription({
        runId: newRunId,
        eventTypes: [
          'agent:started',
          'agent:completed',
          'agent:failed',
          'agent:stream_delta',
          'agent:stream_done',
          'tool:called',
          'tool:result',
          'tool:error',
          'memory:written',
          'memory:searched',
          'memory:error',
          'pipeline:phase_changed',
        ],
      })
    } else if (!newRunId) {
      wsStore.setSubscription(null)
    }
  })

  // ── Cleanup ──────────────────────────────────────────

  onUnmounted(() => {
    stopWsWatch()
    stopStateWatch()
    stopRunIdWatch()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  })

  return {
    events,
    isConnected,
    connectionError,
    connect,
    disconnect,
    clearEvents,
  }
}
