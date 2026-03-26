<script setup lang="ts">
/**
 * TraceTimelineCard -- Individual card for a single trace event in the timeline.
 *
 * Displays type badge, event name, duration, and an expandable metadata section.
 * Color-coded by event type using playground design tokens.
 */
import { computed } from 'vue'
import type { TraceEvent } from '../types.js'
import { formatDuration, formatRelativeTime, typeColor, typeBarColor, typeIcon } from '../utils/format.js'

interface Props {
  /** The trace event to display */
  event: TraceEvent
  /** Whether the detail section is expanded */
  expanded: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** Toggle the expanded state of this card */
  toggle: []
}>()

/** Formatted duration string */
const duration = computed(() => formatDuration(props.event.durationMs))

/** Relative timestamp string */
const relativeTime = computed(() => formatRelativeTime(props.event.startedAt))

/** Badge classes based on event type */
const badgeClasses = computed(() => typeColor(props.event.type))

/** Inline color for the left border accent */
const accentColor = computed(() => typeBarColor(props.event.type))

/** Badge label */
const label = computed(() => typeIcon(props.event.type))

/** Whether the event has metadata to show */
const hasMetadata = computed(() =>
  props.event.metadata !== undefined && Object.keys(props.event.metadata).length > 0,
)

/** Formatted metadata JSON */
const metadataJson = computed(() => {
  if (!props.event.metadata) return ''
  return JSON.stringify(props.event.metadata, null, 2)
})

function handleToggle(): void {
  emit('toggle')
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('toggle')
  }
}
</script>

<template>
  <div
    class="group relative rounded-pg-sm border border-pg-border-subtle bg-pg-surface transition-colors hover:border-pg-border hover:bg-pg-surface-raised"
    :style="{ borderLeftWidth: '3px', borderLeftColor: accentColor }"
  >
    <!-- Clickable header -->
    <div
      class="flex cursor-pointer items-center gap-2.5 px-3 py-2"
      role="button"
      :tabindex="0"
      :aria-expanded="expanded"
      :aria-label="`${event.type} event: ${event.name}, duration ${duration}`"
      @click="handleToggle"
      @keydown="handleKeydown"
    >
      <!-- Type badge -->
      <span
        class="inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
        :class="badgeClasses"
      >
        {{ label }}
      </span>

      <!-- Event name -->
      <span class="min-w-0 flex-1 truncate text-xs font-medium text-pg-text">
        {{ event.name }}
      </span>

      <!-- Relative timestamp -->
      <span class="shrink-0 text-[10px] text-pg-text-muted">
        {{ relativeTime }}
      </span>

      <!-- Duration -->
      <span class="shrink-0 font-mono text-xs text-pg-text-secondary">
        {{ duration }}
      </span>

      <!-- Expand indicator -->
      <span
        v-if="hasMetadata"
        class="shrink-0 text-[10px] text-pg-text-muted transition-transform"
        :class="expanded ? 'rotate-90' : ''"
        aria-hidden="true"
      >
        &#9656;
      </span>
    </div>

    <!-- Expandable metadata section -->
    <div
      v-if="expanded && hasMetadata"
      class="border-t border-pg-border-subtle px-3 py-2"
    >
      <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-pg-text-muted">
        Metadata
      </p>
      <pre
        class="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-2 font-mono text-[11px] leading-relaxed text-pg-text-secondary"
      >{{ metadataJson }}</pre>
    </div>

    <!-- Expanded but no metadata -->
    <div
      v-if="expanded && !hasMetadata"
      class="border-t border-pg-border-subtle px-3 py-2"
    >
      <p class="text-[10px] text-pg-text-muted">
        No metadata available.
      </p>
    </div>
  </div>
</template>
