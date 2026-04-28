<script setup lang="ts">
/**
 * TraceTimeline -- Horizontal timeline that visualizes an array of
 * TimelineNode entries from the replay debugger.
 *
 * Each node renders as a horizontal bar whose width is proportional to
 * its duration relative to the longest node. Bars are color-coded by
 * status: green for success, red for error, yellow for running, and
 * gray for pending. Clicking a node emits the `select-node` event.
 *
 * The total pipeline duration is displayed at the bottom.
 */
import { computed } from 'vue'
import type { TimelineNode } from '../../replay/replay-types.js'
import {
  barWidthPercent,
  formatMs,
  getMaxDuration,
  getNodeStatus,
  getTotalDuration,
  getTraceStatusStyles,
  traceUiStyles,
} from './utils.js'

/** Component props */
interface Props {
  /** Array of timeline nodes to render */
  timeline: TimelineNode[]
  /** Currently selected node ID (highlights the row) */
  selectedNodeId?: string
  /** Whether to display duration labels on each bar */
  showDurations?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  selectedNodeId: undefined,
  showDurations: true,
})

const emit = defineEmits<{
  /** Emitted when a node row is clicked */
  'select-node': [nodeId: string]
}>()

/** Maximum duration across all nodes (used to scale bar widths) */
const maxDuration = computed(() => {
  return getMaxDuration(props.timeline)
})

/** Total pipeline duration in ms */
const totalDuration = computed(() => {
  return getTotalDuration(props.timeline)
})

/** Determine the visual status of a node */
function nodeStatus(node: TimelineNode): 'error' | 'success' | 'running' | 'pending' {
  return getNodeStatus(node)
}

/** Bar color classes based on status */
function barClasses(node: TimelineNode): string {
  return getTraceStatusStyles(nodeStatus(node)).bar
}

/** Status dot color classes */
function dotClasses(node: TimelineNode): string {
  const status = nodeStatus(node)
  const pulseClass = status === 'running' ? ' animate-pulse' : ''
  return `${getTraceStatusStyles(status).dot}${pulseClass}`
}

/** Bar width as a percentage string */
function barWidth(node: TimelineNode): string {
  const d = node.durationMs ?? node.latencyMs ?? 0
  return barWidthPercent(d, maxDuration.value)
}

/** Handle row click */
function handleSelect(node: TimelineNode): void {
  const id = node.nodeId ?? `event-${String(node.index)}`
  emit('select-node', id)
}

/** Handle keyboard activation */
function handleKeydown(e: KeyboardEvent, node: TimelineNode): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    handleSelect(node)
  }
}

/** Check if a node is currently selected */
function isSelected(node: TimelineNode): boolean {
  if (!props.selectedNodeId) return false
  return (node.nodeId ?? `event-${String(node.index)}`) === props.selectedNodeId
}
</script>

<template>
  <div
    class="flex flex-col gap-1"
    role="list"
    aria-label="Trace timeline"
  >
    <!-- Empty state -->
    <div
      v-if="timeline.length === 0"
      class="flex items-center justify-center py-8 text-sm"
      :class="traceUiStyles.textMuted"
    >
      No timeline data available.
    </div>

    <!-- Timeline rows -->
    <div
      v-for="node in timeline"
      :key="node.index"
      role="listitem"
      :tabindex="0"
      class="group flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition-colors"
      :class="[
        isSelected(node)
          ? traceUiStyles.selected
          : traceUiStyles.interactive,
      ]"
      :aria-selected="isSelected(node)"
      :aria-label="`Node ${node.nodeId ?? node.type}, status ${nodeStatus(node)}, duration ${formatMs(node.durationMs ?? 0)}`"
      @click="handleSelect(node)"
      @keydown="handleKeydown($event, node)"
    >
      <!-- Status dot -->
      <span
        class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        :class="dotClasses(node)"
        aria-hidden="true"
      />

      <!-- Node ID / type label -->
      <span class="w-36 shrink-0 truncate text-xs font-medium" :class="traceUiStyles.textPrimary">
        {{ node.nodeId ?? node.type }}
      </span>

      <!-- Type badge -->
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider" :class="traceUiStyles.badgeNeutral">
        {{ node.type }}
      </span>

      <!-- Duration bar -->
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <div class="h-2 flex-1 overflow-hidden rounded-full" :class="traceUiStyles.track">
          <div
            class="h-full rounded-full transition-all"
            :class="barClasses(node)"
            :style="{ width: barWidth(node) }"
          />
        </div>

        <!-- Duration label -->
        <span
          v-if="showDurations"
          class="w-16 shrink-0 text-right font-mono text-[11px]"
          :class="traceUiStyles.textMuted"
        >
          {{ formatMs(node.durationMs ?? node.latencyMs ?? 0) }}
        </span>
      </div>
    </div>

    <!-- Total duration footer -->
    <div
      v-if="timeline.length > 0"
      class="mt-2 flex items-center justify-between border-t px-3 pt-2"
      :class="traceUiStyles.divider"
    >
      <span class="text-xs" :class="traceUiStyles.textMuted">
        {{ timeline.length }} node{{ timeline.length === 1 ? '' : 's' }}
      </span>
      <span class="font-mono text-xs font-medium" :class="traceUiStyles.textSecondary">
        Total: {{ formatMs(totalDuration) }}
      </span>
    </div>
  </div>
</template>
