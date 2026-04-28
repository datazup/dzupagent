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
import {
  formatMs,
  getNodeStatus,
  getTraceStatusStyles,
  traceToneStyles,
  traceUiStyles,
} from './utils.js'

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
  switch (getNodeStatus(props.node)) {
    case 'error':
      return 'Error'
    case 'success':
      return 'Success'
    case 'running':
      return 'Running'
    case 'pending':
      return 'Pending'
  }
})

/** Status badge color classes */
const statusClasses = computed(() => {
  return getTraceStatusStyles(getNodeStatus(props.node)).badge
})

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
    class="flex flex-col gap-4 p-4"
    :class="traceUiStyles.panel"
    role="region"
    :aria-label="`Details for node ${node.nodeId ?? node.type}`"
  >
    <!-- Header -->
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold" :class="traceUiStyles.textPrimary">
          {{ node.nodeId ?? `Event #${node.index}` }}
        </h3>
        <p class="mt-0.5 font-mono text-xs" :class="traceUiStyles.textMuted">
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
      <span class="text-xs font-medium" :class="traceUiStyles.textMuted">Duration:</span>
      <span class="font-mono text-sm font-medium" :class="traceUiStyles.textPrimary">
        {{ formatMs(node.durationMs ?? node.latencyMs ?? 0) }}
      </span>
    </div>

    <!-- Token usage / cost -->
    <div
      v-if="node.tokenUsage !== undefined || node.costCents !== undefined"
      class="flex flex-wrap gap-4"
    >
      <div v-if="node.tokenUsage !== undefined" class="flex items-center gap-1.5">
        <span class="text-xs" :class="traceUiStyles.textMuted">Tokens:</span>
        <span class="font-mono text-xs font-medium" :class="traceUiStyles.textSecondary">
          {{ node.tokenUsage.toLocaleString() }}
        </span>
      </div>
      <div v-if="node.costCents !== undefined" class="flex items-center gap-1.5">
        <span class="text-xs" :class="traceUiStyles.textMuted">Cost:</span>
        <span class="font-mono text-xs font-medium" :class="traceUiStyles.textSecondary">
          ${{ (node.costCents / 100).toFixed(4) }}
        </span>
      </div>
    </div>

    <!-- Error message -->
    <div
      v-if="node.isError && errorMessage"
      class="rounded-md p-3"
      :class="traceToneStyles.danger.panel"
      role="alert"
    >
      <p class="mb-1 text-xs font-semibold" :class="traceToneStyles.danger.textStrong">Error</p>
      <p class="text-xs" :class="traceToneStyles.danger.textStrong">
        {{ errorMessage }}
      </p>
    </div>

    <!-- Retry count from metrics -->
    <div
      v-if="metrics && metrics.retryCount > 0"
      class="flex items-center gap-2 rounded-md px-3 py-2"
      :class="traceToneStyles.warning.panel"
    >
      <span class="text-xs font-medium" :class="traceToneStyles.warning.textStrong">Retries:</span>
      <span class="font-mono text-xs font-bold" :class="traceToneStyles.warning.textStrong">
        {{ metrics.retryCount }}
      </span>
    </div>

    <!-- Metrics summary -->
    <div
      v-if="metrics"
      class="grid grid-cols-2 gap-3 p-3"
      :class="traceUiStyles.panelMuted"
    >
      <div>
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Events</p>
        <p class="font-mono text-sm font-medium" :class="traceUiStyles.textPrimary">
          {{ metrics.eventCount }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Total Duration</p>
        <p class="font-mono text-sm font-medium" :class="traceUiStyles.textPrimary">
          {{ formatMs(metrics.totalDurationMs) }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Errors</p>
        <p class="font-mono text-sm font-medium" :class="metrics.errorCount > 0 ? traceToneStyles.danger.text : traceUiStyles.textPrimary">
          {{ metrics.errorCount }}
        </p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wider" :class="traceUiStyles.textMuted">Retries</p>
        <p class="font-mono text-sm font-medium" :class="metrics.retryCount > 0 ? traceToneStyles.warning.text : traceUiStyles.textPrimary">
          {{ metrics.retryCount }}
        </p>
      </div>
    </div>

    <!-- Raw node data -->
    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" :class="traceUiStyles.textMuted">
        Node Data
      </p>
      <pre
        class="max-h-64 overflow-auto p-3 font-mono text-xs leading-relaxed"
        :class="[traceUiStyles.panelMuted, traceUiStyles.textSecondary]"
      >{{ formattedData }}</pre>
    </div>
  </div>
</template>
