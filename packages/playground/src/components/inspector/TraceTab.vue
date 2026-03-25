<script setup lang="ts">
/**
 * TraceTab -- Timeline of trace events with duration bars, color-coded by type.
 *
 * Displays events from the trace store as horizontal bars
 * proportional to their duration.
 */
import { computed } from 'vue'
import { useTraceStore } from '../../stores/trace-store.js'
import type { TraceEvent } from '../../types.js'

const traceStore = useTraceStore()

/** Map event types to CSS color variables */
function eventColor(type: TraceEvent['type']): string {
  switch (type) {
    case 'llm': return 'var(--pg-accent)'
    case 'tool': return 'var(--pg-success)'
    case 'memory': return 'var(--pg-info)'
    case 'guardrail': return 'var(--pg-warning)'
    case 'system': return 'var(--pg-text-muted)'
    default: return 'var(--pg-text-muted)'
  }
}

/** Calculate bar width as a percentage of the max duration */
const maxDuration = computed(() =>
  Math.max(1, ...traceStore.events.map((e) => e.durationMs)),
)

function barWidth(durationMs: number): string {
  const pct = Math.max(2, (durationMs / maxDuration.value) * 100)
  return `${pct}%`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
</script>

<template>
  <div class="pg-scrollbar flex flex-col gap-1 overflow-y-auto p-4">
    <!-- Empty state -->
    <div
      v-if="traceStore.events.length === 0"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-[var(--pg-text-muted)]">
        No trace events yet.
      </p>
    </div>

    <!-- Summary -->
    <div
      v-if="traceStore.events.length > 0"
      class="mb-3 flex items-center justify-between text-xs text-[var(--pg-text-muted)]"
    >
      <span>{{ traceStore.eventCount }} events</span>
      <span>Total: {{ formatDuration(traceStore.totalDurationMs) }}</span>
      <button
        class="text-xs text-[var(--pg-accent)] hover:underline"
        @click="traceStore.clearEvents()"
      >
        Clear
      </button>
    </div>

    <!-- Event list -->
    <div
      v-for="event in traceStore.events"
      :key="event.id"
      class="flex items-center gap-3 rounded-[var(--pg-radius-sm)] px-2 py-1.5 text-xs hover:bg-[var(--pg-surface-raised)]"
    >
      <!-- Type badge -->
      <span
        class="inline-block w-16 shrink-0 rounded-sm px-1.5 py-0.5 text-center font-mono text-[10px] font-medium text-[var(--pg-bg)]"
        :style="{ backgroundColor: eventColor(event.type) }"
      >
        {{ event.type }}
      </span>

      <!-- Name -->
      <span class="min-w-0 flex-1 truncate text-[var(--pg-text)]">
        {{ event.name }}
      </span>

      <!-- Duration bar -->
      <div class="w-32 shrink-0">
        <div
          class="h-2 rounded-full"
          :style="{
            width: barWidth(event.durationMs),
            backgroundColor: eventColor(event.type),
            opacity: 0.7,
          }"
        />
      </div>

      <!-- Duration text -->
      <span class="w-16 shrink-0 text-right font-mono text-[var(--pg-text-muted)]">
        {{ formatDuration(event.durationMs) }}
      </span>
    </div>
  </div>
</template>
