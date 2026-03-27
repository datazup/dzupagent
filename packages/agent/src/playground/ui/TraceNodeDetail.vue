<script setup lang="ts">
/**
 * TraceNodeDetail -- Detail panel for a single selected timeline node.
 *
 * Displays the node's ID, type, status, duration, input/output data
 * (JSON-formatted), error message (if failed), and retry count.
 * Optionally accepts NodeMetrics for aggregate statistics.
 */
import { computed } from 'vue'
import type { TimelineNode } from '../../replay/replay-types.js'
import type { NodeMetrics } from '../../replay/replay-inspector.js'

/** Component props */
interface Props {
  /** The timeline node to display details for */
  node: TimelineNode
  /** Optional aggregate metrics for this node */
  metrics?: NodeMetrics
}

const props = withDefaults(defineProps<Props>(), {
  metrics: undefined,
})

/** Visual status label */
const statusLabel = computed(() => {
  if (props.node.isError) return 'Error'
  if (props.node.durationMs !== undefined && props.node.durationMs > 0) return 'Success'
  if (props.node.type.endsWith(':started') || props.node.type.includes('running')) return 'Running'
  return 'Pending'
})

/** Status badge color classes */
const statusClasses = computed(() => {
  const status = statusLabel.value
  switch (status) {
    case 'Error':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
    case 'Success':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
    case 'Running':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  }
})

/** Format milliseconds to a human-readable string */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Extract error message from node data */
const errorMessage = computed(() => {
  const err = props.node.isError
    ? (typeof props.node.nodeId === 'string'
        ? String(
            (props.node as unknown as Record<string, unknown>)['error'] ??
            'An error occurred during execution',
          )
        : 'An error occurred during execution')
    : undefined
  return err
})

/** Formatted node data as JSON */
const formattedData = computed(() => {
  const data: Record<string, unknown> = {
    index: props.node.index,
    timestamp: props.node.timestamp,
    type: props.node.type,
  }
  if (props.node.nodeId !== undefined) data['nodeId'] = props.node.nodeId
  if (props.node.durationMs !== undefined) data['durationMs'] = props.node.durationMs
  if (props.node.tokenUsage !== undefined) data['tokenUsage'] = props.node.tokenUsage
  if (props.node.costCents !== undefined) data['costCents'] = props.node.costCents
  if (props.node.latencyMs !== undefined) data['latencyMs'] = props.node.latencyMs
  return JSON.stringify(data, null, 2)
})
</script>

<template>
  <div
    class="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
    role="region"
    :aria-label="`Details for node ${node.nodeId ?? node.type}`"
  >
    <!-- Header -->
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
          {{ node.nodeId ?? `Event #${node.index}` }}
        </h3>
        <p class="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
          {{ node.type }}
        </p>
      </div>
      <span
        class="inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
        :class="statusClasses"
      >
        {{ statusLabel }}
      </span>
    </div>

    <!-- Duration -->
    <div
      v-if="node.durationMs !== undefined || node.latencyMs !== undefined"
      class="flex items-center gap-2"
    >
      <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Duration:</span>
      <span class="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
        {{ formatMs(node.durationMs ?? node.latencyMs ?? 0) }}
      </span>
    </div>

    <!-- Token usage / cost -->
    <div
      v-if="node.tokenUsage !== undefined || node.costCents !== undefined"
      class="flex flex-wrap gap-4"
    >
      <div v-if="node.tokenUsage !== undefined" class="flex items-center gap-1.5">
        <span class="text-xs text-gray-500 dark:text-gray-400">Tokens:</span>
        <span class="font-mono text-xs font-medium text-gray-800 dark:text-gray-200">
          {{ node.tokenUsage.toLocaleString() }}
        </span>
      </div>
      <div v-if="node.costCents !== undefined" class="flex items-center gap-1.5">
        <span class="text-xs text-gray-500 dark:text-gray-400">Cost:</span>
        <span class="font-mono text-xs font-medium text-gray-800 dark:text-gray-200">
          ${{ (node.costCents / 100).toFixed(4) }}
        </span>
      </div>
    </div>

    <!-- Error message -->
    <div
      v-if="node.isError && errorMessage"
      class="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950"
      role="alert"
    >
      <p class="mb-1 text-xs font-semibold text-red-800 dark:text-red-200">Error</p>
      <p class="text-xs text-red-700 dark:text-red-300">
        {{ errorMessage }}
      </p>
    </div>

    <!-- Retry count from metrics -->
    <div
      v-if="metrics && metrics.retryCount > 0"
      class="flex items-center gap-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 dark:border-yellow-800 dark:bg-yellow-950"
    >
      <span class="text-xs font-medium text-yellow-800 dark:text-yellow-200">Retries:</span>
      <span class="font-mono text-xs font-bold text-yellow-900 dark:text-yellow-100">
        {{ metrics.retryCount }}
      </span>
    </div>

    <!-- Metrics summary -->
    <div
      v-if="metrics"
      class="grid grid-cols-2 gap-3 rounded-md bg-gray-50 p-3 dark:bg-gray-800"
    >
      <div>
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Events</p>
        <p class="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
          {{ metrics.eventCount }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Total Duration</p>
        <p class="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
          {{ formatMs(metrics.totalDurationMs) }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Errors</p>
        <p class="font-mono text-sm font-medium" :class="metrics.errorCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'">
          {{ metrics.errorCount }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Retries</p>
        <p class="font-mono text-sm font-medium" :class="metrics.retryCount > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-900 dark:text-gray-100'">
          {{ metrics.retryCount }}
        </p>
      </div>
    </div>

    <!-- Raw node data -->
    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Node Data
      </p>
      <pre
        class="max-h-64 overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700 dark:bg-gray-800 dark:text-gray-300"
      >{{ formattedData }}</pre>
    </div>
  </div>
</template>
