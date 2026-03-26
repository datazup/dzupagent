<script setup lang="ts">
/**
 * TraceTab -- Wrapper that renders the TraceTimeline inside the inspector panel.
 *
 * Integrates with useEventStream and useLiveTrace to provide:
 * - Live connection status indicator
 * - Real-time trace timeline that updates as events arrive
 * - Auto-scroll to latest event
 * - Pause/resume live updates toggle
 * - Token usage and cost estimate display
 */
import { ref, computed, watch, onMounted } from 'vue'
import TraceTimeline from '../TraceTimeline.vue'
import { useEventStream } from '../../composables/useEventStream.js'
import { useLiveTrace } from '../../composables/useLiveTrace.js'
import { useChatStore } from '../../stores/chat-store.js'
import { useTraceStore } from '../../stores/trace-store.js'
import { formatDuration } from '../../utils/format.js'

const chatStore = useChatStore()
const traceStore = useTraceStore()

/** WebSocket server URL (same origin, /ws path) */
const serverUrl = ref(
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    : 'ws://localhost:4000/ws',
)

/** Active run ID from the chat store */
const activeRunId = computed(() => chatStore.activeRunId)

/** Event stream composable */
const { events, isConnected, connectionError, connect, disconnect, clearEvents } =
  useEventStream(serverUrl, activeRunId)

/** Live trace composable */
const { timelineData, tokenUsage, costEstimate } = useLiveTrace(events)

/** Whether live updates are paused */
const isPaused = ref(false)

/** Snapshot of events at pause time */
const pausedEventCount = ref(0)

/** Toggle pause/resume of live updates */
function togglePause(): void {
  if (isPaused.value) {
    // Resume: push any new events accumulated during pause into trace store
    isPaused.value = false
    syncEventsToTraceStore()
  } else {
    isPaused.value = true
    pausedEventCount.value = events.value.length
  }
}

/** Sync live timeline events into the trace store for the TraceTimeline component */
function syncEventsToTraceStore(): void {
  if (isPaused.value) return
  const liveEvents = timelineData.value.events
  if (liveEvents.length > 0) {
    traceStore.setEvents(liveEvents)
  }
}

/** Number of new events since pause */
const newEventsSincePause = computed(() => {
  if (!isPaused.value) return 0
  return Math.max(0, events.value.length - pausedEventCount.value)
})

/** Format cost to display string */
function formatCost(cost: number): string {
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

/** Connection status text */
const statusText = computed(() => {
  if (connectionError.value) return 'Error'
  if (isConnected.value) return 'Live'
  return 'Disconnected'
})

/** Connection status dot color class */
const statusDotClass = computed(() => {
  if (connectionError.value) return 'bg-pg-error'
  if (isConnected.value) return 'bg-pg-success'
  return 'bg-pg-text-muted'
})

// Watch for new events and push to trace store (when not paused)
watch(
  () => events.value.length,
  () => {
    syncEventsToTraceStore()
  },
)

// Auto-connect on mount if there's an active run
onMounted(() => {
  if (activeRunId.value) {
    connect()
  }
})

// Auto-connect/disconnect when run changes
watch(activeRunId, (newRunId) => {
  if (newRunId) {
    if (!isConnected.value) {
      connect()
    }
  }
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Live status bar -->
    <div class="flex shrink-0 items-center gap-2 border-b border-pg-border px-3 py-1.5">
      <!-- Connection indicator -->
      <div
        class="flex items-center gap-1.5"
        role="status"
        :aria-label="`Connection status: ${statusText}`"
      >
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="[statusDotClass, isConnected && !isPaused ? 'animate-pulse' : '']"
          aria-hidden="true"
        />
        <span class="text-[10px] font-medium text-pg-text-muted">
          {{ statusText }}
        </span>
      </div>

      <!-- Connection error -->
      <span
        v-if="connectionError"
        class="truncate text-[10px] text-pg-error"
        role="alert"
      >
        {{ connectionError }}
      </span>

      <!-- Spacer -->
      <div class="flex-1" />

      <!-- Token usage display -->
      <div
        v-if="tokenUsage.total > 0"
        class="flex items-center gap-2"
        aria-label="Token usage summary"
      >
        <span class="text-[10px] text-pg-text-muted">
          {{ tokenUsage.total.toLocaleString() }} tokens
        </span>
        <span class="text-[10px] text-pg-text-muted">
          {{ formatCost(costEstimate) }}
        </span>
      </div>

      <!-- Pause/Resume toggle -->
      <button
        class="rounded px-2 py-0.5 text-[10px] font-medium transition-colors"
        :class="isPaused
          ? 'bg-pg-warning/15 text-pg-warning hover:bg-pg-warning/25'
          : 'text-pg-text-muted hover:bg-pg-surface-raised hover:text-pg-text-secondary'"
        :aria-label="isPaused ? 'Resume live updates' : 'Pause live updates'"
        @click="togglePause"
      >
        {{ isPaused ? 'Resume' : 'Pause' }}
        <span
          v-if="isPaused && newEventsSincePause > 0"
          class="ml-1"
        >
          ({{ newEventsSincePause }} new)
        </span>
      </button>

      <!-- Connect/Disconnect button -->
      <button
        class="rounded px-2 py-0.5 text-[10px] font-medium text-pg-text-muted transition-colors hover:bg-pg-surface-raised hover:text-pg-text-secondary"
        :aria-label="isConnected ? 'Disconnect WebSocket' : 'Connect WebSocket'"
        @click="isConnected ? disconnect() : connect()"
      >
        {{ isConnected ? 'Disconnect' : 'Connect' }}
      </button>

      <!-- Clear events -->
      <button
        v-if="events.length > 0"
        class="rounded px-2 py-0.5 text-[10px] font-medium text-pg-text-muted transition-colors hover:bg-pg-surface-raised hover:text-pg-text-secondary"
        aria-label="Clear live events"
        @click="clearEvents(); traceStore.clearEvents()"
      >
        Clear
      </button>
    </div>

    <!-- Live event count summary -->
    <div
      v-if="events.length > 0"
      class="flex shrink-0 items-center gap-3 border-b border-pg-border px-3 py-1"
    >
      <span class="text-[10px] text-pg-text-muted">
        {{ timelineData.eventCount }} live event{{ timelineData.eventCount === 1 ? '' : 's' }}
      </span>
      <span class="font-mono text-[10px] text-pg-text-muted">
        {{ formatDuration(timelineData.totalDurationMs) }} total
      </span>
    </div>

    <!-- TraceTimeline component handles all timeline rendering -->
    <TraceTimeline />
  </div>
</template>
