<script setup lang="ts">
/**
 * TraceTimeline -- Vertical timeline that visualizes run execution steps.
 *
 * Displays trace events from the trace store as a vertical timeline with
 * color-coded cards. Events are sorted by startedAt and can be expanded
 * to show metadata. Auto-scrolls to the latest event when new ones arrive.
 *
 * Includes replay controls for stepping through events one at a time or
 * auto-advancing at configurable speed.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useTraceStore } from '../stores/trace-store.js'
import { formatDuration } from '../utils/format.js'
import { useReplayControls } from '../composables/useReplayControls.js'
import TraceTimelineCard from './TraceTimelineCard.vue'

const traceStore = useTraceStore()

/** Set of expanded event IDs */
const expandedIds = ref<Set<string>>(new Set())

/** Ref to the scrollable container for auto-scroll */
const scrollContainer = ref<HTMLElement | null>(null)

/** Events sorted by startedAt (ascending) */
const sortedEvents = computed(() =>
  [...traceStore.events].sort((a, b) => {
    const dateA = new Date(a.startedAt).getTime()
    const dateB = new Date(b.startedAt).getTime()
    return dateA - dateB
  }),
)

/** Total number of sorted events (for replay controls) */
const totalSteps = computed(() => sortedEvents.value.length)

/** Replay controls composable */
const replay = useReplayControls(totalSteps)

/** Whether replay mode is active */
const isReplayActive = computed(() => replay.currentIndex.value >= 0)

/** Events to display: all when inactive, up to currentIndex when replaying */
const visibleEvents = computed(() => {
  if (!isReplayActive.value) {
    return sortedEvents.value
  }
  return sortedEvents.value.slice(0, replay.currentIndex.value + 1)
})

/** Toggle expanded state for an event */
function toggleEvent(eventId: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(eventId)) {
    next.delete(eventId)
  } else {
    next.add(eventId)
  }
  expandedIds.value = next
}

/** Check if an event is expanded */
function isExpanded(eventId: string): boolean {
  // Auto-expand the current replay event
  if (isReplayActive.value) {
    const currentEvent = sortedEvents.value[replay.currentIndex.value]
    if (currentEvent && currentEvent.id === eventId) {
      return true
    }
  }
  return expandedIds.value.has(eventId)
}

/** Check if an event is the current replay step */
function isHighlighted(eventId: string): boolean {
  if (!isReplayActive.value) return false
  const currentEvent = sortedEvents.value[replay.currentIndex.value]
  return currentEvent !== undefined && currentEvent.id === eventId
}

/** Auto-scroll to bottom when new events arrive (only when not replaying) */
watch(
  () => traceStore.events.length,
  () => {
    if (isReplayActive.value) return
    void nextTick(() => {
      if (scrollContainer.value) {
        scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
      }
    })
  },
)

/** Scroll to the current replay event when index changes */
watch(
  () => replay.currentIndex.value,
  () => {
    if (!isReplayActive.value) return
    void nextTick(() => {
      if (scrollContainer.value) {
        const cards = scrollContainer.value.querySelectorAll('[data-timeline-card]')
        const currentCard = cards[replay.currentIndex.value]
        if (currentCard) {
          currentCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }
    })
  },
)
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Summary header -->
    <div
      v-if="traceStore.events.length > 0"
      class="flex shrink-0 items-center justify-between border-b border-pg-border px-4 py-2"
    >
      <span class="text-xs text-pg-text-muted">
        {{ traceStore.eventCount }} event{{ traceStore.eventCount === 1 ? '' : 's' }}
      </span>
      <span class="font-mono text-xs text-pg-text-muted">
        {{ formatDuration(traceStore.totalDurationMs) }} total
      </span>
      <button
        class="text-xs text-pg-accent hover:underline"
        aria-label="Clear all trace events"
        @click="traceStore.clearEvents()"
      >
        Clear
      </button>
    </div>

    <!-- Replay controls bar -->
    <div
      v-if="sortedEvents.length > 0"
      class="flex shrink-0 items-center gap-2 border-b border-pg-border px-3 py-1.5"
      role="toolbar"
      aria-label="Replay controls"
    >
      <!-- Step back -->
      <button
        class="rounded px-2 py-1 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="replay.currentIndex.value <= 0"
        aria-label="Step back"
        @click="replay.stepBack()"
      >
        &#9664;&#9664;
      </button>

      <!-- Play / Pause toggle -->
      <button
        class="rounded px-2.5 py-1 text-xs font-medium text-pg-text transition-colors hover:bg-pg-surface-raised"
        :aria-label="replay.isPlaying.value ? 'Pause replay' : 'Play replay'"
        @click="replay.isPlaying.value ? replay.pause() : replay.play()"
      >
        {{ replay.isPlaying.value ? 'Pause' : 'Play' }}
      </button>

      <!-- Step forward -->
      <button
        class="rounded px-2 py-1 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="replay.currentIndex.value >= sortedEvents.length - 1"
        aria-label="Step forward"
        @click="replay.stepForward()"
      >
        &#9654;&#9654;
      </button>

      <!-- Reset -->
      <button
        class="rounded px-2 py-1 text-xs text-pg-text-muted transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
        aria-label="Reset replay"
        @click="replay.reset()"
      >
        Reset
      </button>

      <!-- Speed selector -->
      <select
        :value="replay.speed.value"
        class="rounded border border-pg-border bg-pg-surface px-1.5 py-0.5 text-xs text-pg-text-secondary"
        aria-label="Playback speed"
        @change="replay.setSpeed(Number(($event.target as HTMLSelectElement).value) as 0.5 | 1 | 2)"
      >
        <option :value="0.5">
          0.5x
        </option>
        <option :value="1">
          1x
        </option>
        <option :value="2">
          2x
        </option>
      </select>

      <!-- Progress indicator -->
      <span
        v-if="isReplayActive"
        class="ml-auto font-mono text-xs text-pg-text-muted"
      >
        {{ replay.currentIndex.value + 1 }} / {{ sortedEvents.length }}
      </span>
    </div>

    <!-- Scrollable timeline area -->
    <div
      ref="scrollContainer"
      class="pg-scrollbar flex-1 overflow-y-auto"
    >
      <!-- Empty state -->
      <div
        v-if="sortedEvents.length === 0"
        class="flex h-full min-h-32 items-center justify-center"
      >
        <p class="text-sm text-pg-text-muted">
          No trace events yet.
        </p>
      </div>

      <!-- Timeline -->
      <div
        v-if="visibleEvents.length > 0"
        class="relative px-4 py-3"
      >
        <!-- Vertical timeline line -->
        <div
          class="absolute bottom-3 left-[1.625rem] top-3 w-px bg-pg-border"
          aria-hidden="true"
        />

        <!-- Event entries -->
        <div class="flex flex-col gap-2">
          <div
            v-for="event in visibleEvents"
            :key="event.id"
            class="relative pl-6"
            data-timeline-card
          >
            <!-- Timeline dot -->
            <div
              class="absolute left-0 top-3 h-2.5 w-2.5 rounded-full border-2 border-pg-surface bg-pg-border"
              aria-hidden="true"
            />

            <TraceTimelineCard
              :event="event"
              :expanded="isExpanded(event.id)"
              :highlighted="isHighlighted(event.id)"
              @toggle="toggleEvent(event.id)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
