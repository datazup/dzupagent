<script setup lang="ts">
/**
 * TraceTimeline -- Vertical timeline that visualizes run execution steps.
 *
 * Displays trace events from the trace store as a vertical timeline with
 * color-coded cards. Events are sorted by startedAt and can be expanded
 * to show metadata. Auto-scrolls to the latest event when new ones arrive.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useTraceStore } from '../stores/trace-store.js'
import { formatDuration } from '../utils/format.js'
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
  return expandedIds.value.has(eventId)
}

/** Auto-scroll to bottom when new events arrive */
watch(
  () => traceStore.events.length,
  () => {
    void nextTick(() => {
      if (scrollContainer.value) {
        scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
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
        v-if="sortedEvents.length > 0"
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
            v-for="event in sortedEvents"
            :key="event.id"
            class="relative pl-6"
          >
            <!-- Timeline dot -->
            <div
              class="absolute left-0 top-3 h-2.5 w-2.5 rounded-full border-2 border-pg-surface bg-pg-border"
              aria-hidden="true"
            />

            <TraceTimelineCard
              :event="event"
              :expanded="isExpanded(event.id)"
              @toggle="toggleEvent(event.id)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
