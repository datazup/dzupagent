<script setup lang="ts">
/**
 * ToolStatsTab -- Displays tool performance analytics in the inspector panel.
 *
 * Shows summary cards (tool count, avg success rate, fastest tool),
 * a ranked table of tools sorted by score, aggregated error list,
 * and real-time tool usage counters with per-tool latency sparklines
 * from live WebSocket events.
 */
import { computed, ref } from 'vue'
import { useToolStatsStore } from '../../stores/tool-stats-store.js'
import { useEventStream } from '../../composables/useEventStream.js'
import { useLiveTrace, type NodeMetrics } from '../../composables/useLiveTrace.js'
import { useChatStore } from '../../stores/chat-store.js'

const toolStats = useToolStatsStore()
const chatStore = useChatStore()

// ── Live event stream integration ──────────────────
const serverUrl = ref(
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
    : 'ws://localhost:4000/ws',
)

const activeRunId = computed(() => chatStore.activeRunId)
const { events: liveEvents, isConnected: liveConnected } = useEventStream(serverUrl, activeRunId)
const { nodeMetrics } = useLiveTrace(liveEvents)

/** Whether we have live tool metrics */
const hasLiveMetrics = computed(() => {
  for (const [, metrics] of nodeMetrics.value) {
    if (metrics.name.startsWith('memory:')) continue
    if (metrics.callCount > 0) return true
  }
  return false
})

/** Live tool metrics sorted by call count descending */
const sortedLiveTools = computed<NodeMetrics[]>(() => {
  const tools: NodeMetrics[] = []
  for (const [, metrics] of nodeMetrics.value) {
    // Only include tool-related metrics (not memory ops)
    if (!metrics.name.startsWith('memory:')) {
      tools.push(metrics)
    }
  }
  return tools.sort((a, b) => b.callCount - a.callCount)
})

/** SVG sparkline path for latency samples */
function sparklinePath(samples: number[]): string {
  if (samples.length < 2) return ''
  const maxVal = Math.max(...samples, 1)
  const width = 60
  const height = 16
  const stepX = width / (samples.length - 1)

  const points = samples.map((val, i) => {
    const x = i * stepX
    const y = height - (val / maxVal) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return `M${points.join(' L')}`
}

/** Color class for live success rate */
function liveSuccessColor(rate: number): string {
  if (rate >= 0.9) return 'text-pg-success'
  if (rate >= 0.7) return 'text-pg-warning'
  return 'text-pg-error'
}

/** Sparkline stroke color based on success rate */
function sparklineStroke(rate: number): string {
  if (rate >= 0.9) return 'var(--color-pg-success)'
  if (rate >= 0.7) return 'var(--color-pg-warning)'
  return 'var(--color-pg-error)'
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Values under 1000ms show as "Xms", otherwise "X.Ys".
 */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Format a success rate (0-1) as a percentage string.
 */
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/**
 * Return Tailwind classes for success rate color coding.
 * Green >= 90%, yellow >= 70%, red < 70%.
 */
function successRateColorClass(rate: number): string {
  if (rate >= 0.9) return 'text-pg-success'
  if (rate >= 0.7) return 'text-pg-warning'
  return 'text-pg-error'
}

/**
 * Return Tailwind classes for the success rate background bar.
 */
function successRateBarClass(rate: number): string {
  if (rate >= 0.9) return 'bg-pg-success/20'
  if (rate >= 0.7) return 'bg-pg-warning/20'
  return 'bg-pg-error/20'
}

/**
 * Return Tailwind classes for the success rate fill bar.
 */
function successRateFillClass(rate: number): string {
  if (rate >= 0.9) return 'bg-pg-success'
  if (rate >= 0.7) return 'bg-pg-warning'
  return 'bg-pg-error'
}

const hasStats = computed(() => toolStats.toolCount > 0)
</script>

<template>
  <div class="pg-scrollbar flex h-full flex-col overflow-y-auto">
    <!-- Live tool metrics section -->
    <div
      v-if="hasLiveMetrics"
      class="border-b border-pg-border"
    >
      <!-- Live header -->
      <div class="flex items-center gap-2 px-4 py-2">
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="liveConnected ? 'bg-pg-success animate-pulse' : 'bg-pg-text-muted'"
          aria-hidden="true"
        />
        <h3 class="text-xs font-semibold text-pg-text-secondary">
          Live Tool Usage
        </h3>
        <span class="text-[10px] text-pg-text-muted">
          {{ sortedLiveTools.length }} tool{{ sortedLiveTools.length === 1 ? '' : 's' }}
        </span>
      </div>

      <!-- Live tool cards -->
      <div class="grid grid-cols-1 gap-2 px-4 pb-3">
        <div
          v-for="tool in sortedLiveTools"
          :key="tool.name"
          class="flex items-center gap-3 rounded-pg-sm border border-pg-border-subtle bg-pg-surface p-2"
        >
          <!-- Tool name & call count -->
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-xs font-medium text-pg-text">
                {{ tool.name }}
              </span>
              <span class="shrink-0 rounded-sm bg-pg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-pg-text-secondary">
                {{ tool.callCount }}x
              </span>
            </div>
            <div class="mt-0.5 flex items-center gap-2">
              <span class="font-mono text-[10px] text-pg-text-muted">
                avg {{ tool.avgDurationMs > 0 ? `${Math.round(tool.avgDurationMs)}ms` : '--' }}
              </span>
              <span
                class="font-mono text-[10px]"
                :class="liveSuccessColor(tool.successRate)"
              >
                {{ Math.round(tool.successRate * 100) }}%
              </span>
            </div>
          </div>

          <!-- Latency sparkline -->
          <div
            v-if="tool.latencySamples.length >= 2"
            class="shrink-0"
            :aria-label="`Latency trend for ${tool.name}`"
          >
            <svg
              width="60"
              height="16"
              class="overflow-visible"
            >
              <path
                :d="sparklinePath(tool.latencySamples)"
                fill="none"
                :stroke="sparklineStroke(tool.successRate)"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-if="!hasStats && !hasLiveMetrics"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-pg-text-muted">
        No tool stats available. Run an agent to collect tool performance data.
      </p>
    </div>

    <template v-if="hasStats">
      <!-- Summary cards -->
      <div
        class="grid grid-cols-3 gap-3 border-b border-pg-border p-4"
        role="region"
        aria-label="Tool stats summary"
      >
        <!-- Total tools -->
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-3">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Tools Used
          </p>
          <p class="mt-1 text-lg font-semibold text-pg-text">
            {{ toolStats.toolCount }}
          </p>
        </div>

        <!-- Avg success rate -->
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-3">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Avg Success Rate
          </p>
          <p
            class="mt-1 text-lg font-semibold"
            :class="successRateColorClass(toolStats.avgSuccessRate)"
          >
            {{ formatPercent(toolStats.avgSuccessRate) }}
          </p>
        </div>

        <!-- Fastest tool -->
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-3">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Fastest Tool
          </p>
          <p class="mt-1 truncate text-sm font-semibold text-pg-accent">
            {{ toolStats.fastestTool?.toolName ?? '--' }}
          </p>
          <p
            v-if="toolStats.fastestTool"
            class="text-[10px] text-pg-text-muted"
          >
            {{ formatLatency(toolStats.fastestTool.avgDurationMs) }} avg
          </p>
        </div>
      </div>

      <!-- Tool ranking table -->
      <div class="flex-1 px-4 py-3">
        <h3 class="mb-2 text-xs font-semibold text-pg-text-secondary">
          Tool Rankings
        </h3>
        <div class="overflow-auto">
          <table
            class="w-full text-[11px]"
            role="table"
            aria-label="Tool performance rankings"
          >
            <thead>
              <tr class="border-b border-pg-border">
                <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                  #
                </th>
                <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                  Tool
                </th>
                <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                  Calls
                </th>
                <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                  Success Rate
                </th>
                <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                  Avg
                </th>
                <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                  P95
                </th>
                <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in toolStats.sortedStats"
                :key="entry.toolName"
                class="border-b border-pg-border-subtle/50"
              >
                <!-- Rank -->
                <td class="py-1.5 font-mono text-pg-text-muted">
                  {{ index + 1 }}
                </td>
                <!-- Tool name -->
                <td class="py-1.5 font-medium text-pg-text">
                  {{ entry.toolName }}
                </td>
                <!-- Calls -->
                <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                  {{ entry.totalCalls }}
                </td>
                <!-- Success Rate with color bar -->
                <td class="py-1.5">
                  <div class="flex items-center gap-2">
                    <div
                      class="h-1.5 w-16 overflow-hidden rounded-full"
                      :class="successRateBarClass(entry.successRate)"
                    >
                      <div
                        class="h-full rounded-full transition-all"
                        :class="successRateFillClass(entry.successRate)"
                        :style="{ width: `${Math.round(entry.successRate * 100)}%` }"
                      />
                    </div>
                    <span
                      class="font-mono text-[10px]"
                      :class="successRateColorClass(entry.successRate)"
                    >
                      {{ formatPercent(entry.successRate) }}
                    </span>
                  </div>
                </td>
                <!-- Avg Latency -->
                <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                  {{ formatLatency(entry.avgDurationMs) }}
                </td>
                <!-- P95 Latency -->
                <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                  {{ formatLatency(entry.p95DurationMs) }}
                </td>
                <!-- Score -->
                <td class="py-1.5 text-right font-mono font-semibold text-pg-accent">
                  {{ entry.score.toFixed(2) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Top errors -->
      <div
        v-if="toolStats.aggregatedErrors.length > 0"
        class="border-t border-pg-border px-4 py-3"
      >
        <h3 class="mb-2 text-xs font-semibold text-pg-text-secondary">
          Top Errors
        </h3>
        <div class="flex flex-col gap-1">
          <div
            v-for="err in toolStats.aggregatedErrors"
            :key="err.type"
            class="flex items-center justify-between rounded-pg-sm bg-pg-error/5 px-2 py-1"
          >
            <span class="font-mono text-[10px] text-pg-error">
              {{ err.type }}
            </span>
            <span class="font-mono text-[10px] text-pg-text-muted">
              {{ err.count }}x
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
