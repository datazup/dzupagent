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
  let count = 0
  for (const metrics of Object.values(props.summary.nodeMetrics)) {
    if (metrics.errorCount > 0) count++
  }
  return count
})

/** Top 3 bottleneck nodes sorted by total duration descending */
const bottleneckNodes = computed(() => {
  const entries = Object.values(props.summary.nodeMetrics)
    .filter(m => m.totalDurationMs > 0)
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
    .slice(0, 3)
  return entries
})

/** Event types that contain errors, sorted by count descending */
const errorEventTypes = computed(() => {
  const types: Array<{ type: string; count: number }> = []
  for (const [type, count] of Object.entries(props.summary.eventTypeCounts)) {
    if (type.endsWith(':failed') || type.endsWith(':error') || type.includes('retry') || type.includes('recovery')) {
      types.push({ type, count })
    }
  }
  types.sort((a, b) => b.count - a.count)
  return types
})

/** Format milliseconds to a human-readable string */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/** Format cost in cents to dollars */
function formatCost(cents: number): string {
  if (cents === 0) return '$0.00'
  return `$${(cents / 100).toFixed(4)}`
}

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
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Trace Summary
      </h3>
      <span class="font-mono text-xs text-gray-500 dark:text-gray-400">
        {{ summary.runId }}
      </span>
    </div>

    <!-- Stats grid -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <!-- Total events -->
      <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Events</p>
        <p class="mt-1 font-mono text-xl font-bold text-gray-900 dark:text-gray-100">
          {{ summary.totalEvents }}
        </p>
      </div>

      <!-- Nodes -->
      <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Nodes</p>
        <p class="mt-1 font-mono text-xl font-bold text-gray-900 dark:text-gray-100">
          {{ summary.nodeCount }}
        </p>
        <div class="mt-1 flex gap-2 text-[10px]">
          <span class="text-emerald-600 dark:text-emerald-400">{{ passedCount }} passed</span>
          <span
            v-if="failedNodeCount > 0"
            class="text-red-600 dark:text-red-400"
          >{{ failedNodeCount }} failed</span>
        </div>
      </div>

      <!-- Duration -->
      <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Duration</p>
        <p class="mt-1 font-mono text-xl font-bold text-gray-900 dark:text-gray-100">
          {{ formatMs(summary.totalDurationMs) }}
        </p>
      </div>

      <!-- Tokens / Cost -->
      <div class="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Tokens / Cost</p>
        <p class="mt-1 font-mono text-xl font-bold text-gray-900 dark:text-gray-100">
          {{ summary.totalTokens.toLocaleString() }}
        </p>
        <p class="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
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
        class="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 dark:border-red-800 dark:bg-red-950"
        role="status"
      >
        <span class="inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
        <span class="text-xs font-medium text-red-800 dark:text-red-200">
          {{ summary.errorCount }} error{{ summary.errorCount === 1 ? '' : 's' }}
        </span>
      </div>
      <div
        v-if="summary.recoveryCount > 0"
        class="flex items-center gap-1.5 rounded-full border border-yellow-200 bg-yellow-50 px-3 py-1 dark:border-yellow-800 dark:bg-yellow-950"
        role="status"
      >
        <span class="inline-block h-2 w-2 rounded-full bg-yellow-500" aria-hidden="true" />
        <span class="text-xs font-medium text-yellow-800 dark:text-yellow-200">
          {{ summary.recoveryCount }} recovery attempt{{ summary.recoveryCount === 1 ? '' : 's' }}
        </span>
      </div>
    </div>

    <!-- Bottleneck nodes -->
    <div v-if="bottleneckNodes.length > 0">
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Bottleneck Nodes
      </h4>
      <div class="flex flex-col gap-2">
        <div
          v-for="(metrics, idx) in bottleneckNodes"
          :key="metrics.nodeId"
          class="flex items-center gap-3"
        >
          <span class="w-5 shrink-0 text-right font-mono text-xs font-bold text-gray-400 dark:text-gray-500">
            #{{ idx + 1 }}
          </span>
          <span class="w-32 shrink-0 truncate font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
            {{ metrics.nodeId }}
          </span>
          <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div
              class="h-full rounded-full bg-orange-500 transition-all"
              :style="{ width: bottleneckBarWidth(metrics.totalDurationMs) }"
            />
          </div>
          <span class="w-16 shrink-0 text-right font-mono text-xs text-gray-600 dark:text-gray-400">
            {{ formatMs(metrics.totalDurationMs) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Error event types -->
    <div v-if="errorEventTypes.length > 0">
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Error Summary
      </h4>
      <div class="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
        <table class="w-full text-xs" role="table" aria-label="Error event type counts">
          <thead>
            <tr class="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
              <th class="px-3 py-1.5 text-left font-semibold text-gray-600 dark:text-gray-400">
                Event Type
              </th>
              <th class="px-3 py-1.5 text-right font-semibold text-gray-600 dark:text-gray-400">
                Count
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in errorEventTypes"
              :key="entry.type"
              class="border-b border-gray-100 last:border-b-0 dark:border-gray-800"
            >
              <td class="px-3 py-1.5 font-mono text-gray-800 dark:text-gray-200">
                {{ entry.type }}
              </td>
              <td class="px-3 py-1.5 text-right font-mono font-medium text-red-600 dark:text-red-400">
                {{ entry.count }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Event type breakdown -->
    <div>
      <h4 class="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Event Types
      </h4>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="(count, type) in summary.eventTypeCounts"
          :key="type"
          class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300"
        >
          {{ type }}
          <span class="font-bold">{{ count }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
