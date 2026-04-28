<script setup lang="ts">
/**
 * TraceSummary -- Dashboard panel that displays aggregate statistics
 * from a ReplaySummary.
 *
 * Shows total nodes, passed/failed counts, total duration, bottleneck
 * nodes (longest duration), and an error summary with event type
 * breakdown.
 */
import { computed } from 'vue'
import type { ReplaySummary } from '../../replay/replay-inspector.js'
import {
  formatCost,
  formatMs,
  getBottleneckNodes,
  getErrorEventTypes,
  getFailedNodeCount,
  traceToneStyles,
  traceUiStyles,
} from './utils.js'

/** Component props */
interface Props {
  /** The replay summary to display */
  summary: ReplaySummary
}

const props = defineProps<Props>()

/** Number of successful nodes (no errors) */
const passedCount = computed(() => props.summary.nodeCount - failedNodeCount.value)

/** Number of nodes that had at least one error */
const failedNodeCount = computed(() => {
  return getFailedNodeCount(props.summary)
})

/** Top 3 bottleneck nodes sorted by total duration descending */
const bottleneckNodes = computed(() => {
  return getBottleneckNodes(props.summary)
})

/** Event types that contain errors, sorted by count descending */
const errorEventTypes = computed(() => {
  return getErrorEventTypes(props.summary)
})

/** Width percentage for bottleneck bar relative to the longest duration */
function bottleneckBarWidth(durationMs: number): string {
  const maxDuration = bottleneckNodes.value[0]?.totalDurationMs ?? 1
  return `${Math.max((durationMs / maxDuration) * 100, 5)}%`
}
</script>

<template>
  <div
    class="flex flex-col gap-5"
    role="region"
    aria-label="Trace summary dashboard"
  >
    <!-- Run ID header -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold" :class="traceUiStyles.textPrimary">
        Trace Summary
      </h3>
      <span class="font-mono text-xs" :class="traceUiStyles.textMuted">
        {{ summary.runId }}
      </span>
    </div>

    <!-- Stats grid -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <!-- Total events -->
      <div class="p-3" :class="traceUiStyles.panel">
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Events</p>
        <p class="mt-1 font-mono text-xl font-bold" :class="traceUiStyles.textPrimary">
          {{ summary.totalEvents }}
        </p>
      </div>

      <!-- Nodes -->
      <div class="p-3" :class="traceUiStyles.panel">
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Nodes</p>
        <p class="mt-1 font-mono text-xl font-bold" :class="traceUiStyles.textPrimary">
          {{ summary.nodeCount }}
        </p>
        <div class="mt-1 flex gap-2 text-[10px]">
          <span :class="traceToneStyles.success.text">{{ passedCount }} passed</span>
          <span
            v-if="failedNodeCount > 0"
            :class="traceToneStyles.danger.text"
          >{{ failedNodeCount }} failed</span>
        </div>
      </div>

      <!-- Duration -->
      <div class="p-3" :class="traceUiStyles.panel">
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Duration</p>
        <p class="mt-1 font-mono text-xl font-bold" :class="traceUiStyles.textPrimary">
          {{ formatMs(summary.totalDurationMs) }}
        </p>
      </div>

      <!-- Tokens / Cost -->
      <div class="p-3" :class="traceUiStyles.panel">
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Tokens / Cost</p>
        <p class="mt-1 font-mono text-xl font-bold" :class="traceUiStyles.textPrimary">
          {{ summary.totalTokens.toLocaleString() }}
        </p>
        <p class="mt-0.5 font-mono text-xs" :class="traceUiStyles.textMuted">
          {{ formatCost(summary.totalCostCents) }}
        </p>
      </div>
    </div>

    <!-- Error / Recovery indicators -->
    <div
      v-if="summary.errorCount > 0 || summary.recoveryCount > 0"
      class="flex flex-wrap gap-3"
    >
      <div
        v-if="summary.errorCount > 0"
        class="flex items-center gap-1.5 rounded-full px-3 py-1"
        :class="traceToneStyles.danger.panel"
        role="status"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="traceToneStyles.danger.dot" aria-hidden="true" />
        <span class="text-xs font-medium" :class="traceToneStyles.danger.textStrong">
          {{ summary.errorCount }} error{{ summary.errorCount === 1 ? '' : 's' }}
        </span>
      </div>
      <div
        v-if="summary.recoveryCount > 0"
        class="flex items-center gap-1.5 rounded-full px-3 py-1"
        :class="traceToneStyles.warning.panel"
        role="status"
      >
        <span class="inline-block h-2 w-2 rounded-full" :class="traceToneStyles.warning.dot" aria-hidden="true" />
        <span class="text-xs font-medium" :class="traceToneStyles.warning.textStrong">
          {{ summary.recoveryCount }} recovery attempt{{ summary.recoveryCount === 1 ? '' : 's' }}
        </span>
      </div>
    </div>

    <!-- Bottleneck nodes -->
    <div v-if="bottleneckNodes.length > 0">
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider" :class="traceUiStyles.textMuted">
        Bottleneck Nodes
      </h4>
      <div class="flex flex-col gap-2">
        <div
          v-for="(metrics, idx) in bottleneckNodes"
          :key="metrics.nodeId"
          class="flex items-center gap-3"
        >
          <span class="w-5 shrink-0 text-right font-mono text-xs font-bold" :class="traceUiStyles.textDisabled">
            #{{ idx + 1 }}
          </span>
          <span class="w-32 shrink-0 truncate font-mono text-xs font-medium" :class="traceUiStyles.textPrimary">
            {{ metrics.nodeId }}
          </span>
          <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full" :class="traceUiStyles.track">
            <div
              class="h-full rounded-full transition-all"
              :class="traceToneStyles.warning.bar"
              :style="{ width: bottleneckBarWidth(metrics.totalDurationMs) }"
            />
          </div>
          <span class="w-16 shrink-0 text-right font-mono text-xs" :class="traceUiStyles.textSubtle">
            {{ formatMs(metrics.totalDurationMs) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Error event types -->
    <div v-if="errorEventTypes.length > 0">
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider" :class="traceUiStyles.textMuted">
        Error Summary
      </h4>
      <div class="overflow-hidden" :class="traceUiStyles.panelSubtle">
        <table class="w-full text-xs" role="table" aria-label="Error event type counts">
          <thead>
            <tr class="border-b" :class="traceUiStyles.tableHeader">
              <th class="px-3 py-1.5 text-left font-semibold" :class="traceUiStyles.textSubtle">
                Event Type
              </th>
              <th class="px-3 py-1.5 text-right font-semibold" :class="traceUiStyles.textSubtle">
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in errorEventTypes"
              :key="entry.type"
              class="border-b"
              :class="traceUiStyles.tableRow"
            >
              <td class="px-3 py-1.5 font-mono" :class="traceUiStyles.textSecondary">
                {{ entry.type }}
              </td>
              <td class="px-3 py-1.5 text-right font-mono font-medium" :class="traceToneStyles.danger.text">
                {{ entry.count }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Event type breakdown -->
    <div>
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider" :class="traceUiStyles.textMuted">
        Event Types
      </h4>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="(count, type) in summary.eventTypeCounts"
          :key="type"
          class="inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px]"
          :class="traceUiStyles.badgeNeutral"
        >
          {{ type }}
          <span class="font-bold">{{ count }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
