/**
 * Composable for A2A task views to receive real-time task state updates via SSE.
 *
 * Opens an EventSource to the global `/api/events/stream` endpoint and fires a
 * callback when agent lifecycle events indicate task state changes (e.g.
 * `agent:completed`, `agent:failed`, `agent:started`).
 *
 * Replaces setInterval-based polling in A2A views.
 *
 * @module useA2AEventStream
 */
import { onUnmounted, getCurrentInstance, ref, type Ref } from 'vue'

/** Events that signal a task state change and should trigger a refresh. */
const TASK_STATE_EVENT_TYPES = new Set([
  'agent:started',
  'agent:completed',
  'agent:failed',
  'agent:cancelled',
  'a2a:task_updated',
  'a2a:task_created',
])

export interface UseA2AEventStreamOptions {
  /** Callback invoked when an event indicates task state changed. */
  onTaskEvent: () => void
  /**
   * If provided, only events matching this task/run ID trigger the callback.
   * When null/undefined, all matching event types trigger.
   */
  taskId?: Ref<string | null> | string | null
}

export interface UseA2AEventStreamReturn {
  /** Whether the EventSource is currently connected. */
  isConnected: Ref<boolean>
  /** Last SSE error message, if any. */
  sseError: Ref<string | null>
  /** Manually close the SSE connection. */
  close: () => void
  /** Manually (re-)open the SSE connection. */
  open: () => void
}

/**
 * Build the SSE URL for the global event stream.
 * In production, this resolves relative to the page origin.
 * During tests, the caller can override via the `baseUrl` parameter.
 */
function buildSseUrl(baseUrl?: string): string {
  const origin = baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '')
  return `${origin}/api/events/stream`
}

/**
 * Parse a generic SSE message payload and extract the event type and run/task IDs.
 */
function parseEventPayload(raw: string): {
  type: string
  runId: string | null
  taskId: string | null
} | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    // Support envelope format { payload: { type, runId, ... } } and flat format.
    const payload =
      data['payload'] && typeof data['payload'] === 'object' && !Array.isArray(data['payload'])
        ? (data['payload'] as Record<string, unknown>)
        : data

    const type = (payload['type'] as string | undefined) ?? (data['type'] as string | undefined) ?? ''
    const runId = (payload['runId'] as string | undefined) ?? (data['runId'] as string | undefined) ?? null
    const taskId = (payload['taskId'] as string | undefined) ?? (data['taskId'] as string | undefined) ?? null

    return { type, runId, taskId }
  } catch {
    return null
  }
}

/**
 * Composable that opens an SSE connection for A2A task updates.
 *
 * Usage:
 * ```ts
 * const { isConnected, sseError, close, open } = useA2AEventStream({
 *   onTaskEvent: () => fetchTasks(),
 * })
 * ```
 */
export function useA2AEventStream(
  options: UseA2AEventStreamOptions,
  baseUrl?: string,
): UseA2AEventStreamReturn {
  const isConnected = ref(false)
  const sseError = ref<string | null>(null)
  let source: EventSource | null = null

  function getFilterId(): string | null {
    const tid = options.taskId
    if (!tid) return null
    if (typeof tid === 'string') return tid
    return tid.value
  }

  function handleMessage(event: MessageEvent): void {
    const parsed = parseEventPayload(event.data as string)
    if (!parsed) return

    if (!TASK_STATE_EVENT_TYPES.has(parsed.type)) return

    // If filtering by taskId, only trigger on matching events.
    const filterId = getFilterId()
    if (filterId) {
      // Match on taskId or runId (tasks are often correlated to runs).
      if (parsed.taskId !== filterId && parsed.runId !== filterId) return
    }

    options.onTaskEvent()
  }

  function open(): void {
    close()
    sseError.value = null

    const url = buildSseUrl(baseUrl)
    try {
      source = new EventSource(url)
    } catch {
      sseError.value = 'Failed to open SSE connection'
      isConnected.value = false
      return
    }

    source.onopen = () => {
      isConnected.value = true
      sseError.value = null
    }

    source.onmessage = handleMessage

    source.onerror = () => {
      isConnected.value = false
      sseError.value = 'SSE connection error'
      // The browser auto-reconnects EventSource; we keep the reference.
      // If the connection is permanently broken, the caller can close + re-open.
    }
  }

  function close(): void {
    if (source) {
      source.close()
      source = null
    }
    isConnected.value = false
  }

  // Auto-cleanup when the host component unmounts.
  if (getCurrentInstance()) {
    onUnmounted(() => close())
  }

  return { isConnected, sseError, close, open }
}
