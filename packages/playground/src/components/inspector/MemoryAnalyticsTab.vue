<script setup lang="ts">
/**
 * MemoryAnalyticsTab -- DuckDB-powered memory analytics dashboard.
 *
 * Displays decay trends, namespace stats, expiring memories, agent performance,
 * usage patterns, and duplicate candidates with auto-refresh.
 */
import { ref, computed, onMounted } from 'vue'
import {
  useMemoryAnalytics,
  type DecayTrendPoint,
  type NamespaceStatsRow,
  type ExpiringMemoryRow,
  type AgentPerformanceRow,
  type UsagePatternBucket,
  type DuplicateCandidateRow,
} from '../../composables/useMemoryAnalytics.js'

// ── Analytics composable ────────────────────────
const {
  decayTrends,
  namespaceStats,
  expiringMemories,
  agentPerformance,
  usagePatterns,
  duplicates,
  isLoading,
  error,
  isDuckDBUnavailable,
  refreshAll,
  startPolling,
  setPollInterval,
  pollIntervalMs,
} = useMemoryAnalytics()

// ── Sub-tab navigation ──────────────────────────
type SubTab = 'decay' | 'namespaces' | 'expiring' | 'agents' | 'usage' | 'duplicates'

interface SubTabDef {
  id: SubTab
  label: string
}

const subTabs: SubTabDef[] = [
  { id: 'decay', label: 'Decay Trends' },
  { id: 'namespaces', label: 'Namespaces' },
  { id: 'expiring', label: 'Expiring' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage' },
  { id: 'duplicates', label: 'Duplicates' },
]

const activeSubTab = ref<SubTab>('decay')

// ── Decay trend window selector ─────────────────
const decayWindow = ref<'hour' | 'day' | 'week'>('day')

// ── Auto-refresh config ─────────────────────────
const refreshIntervalSec = computed({
  get: () => Math.round(pollIntervalMs.value / 1000),
  set: (val: number) => setPollInterval(val * 1000),
})

// ── Summary stats ───────────────────────────────
const totalNamespaces = computed(() => namespaceStats.value?.rowCount ?? 0)
const totalMemories = computed(() => {
  if (!namespaceStats.value) return 0
  return namespaceStats.value.rows.reduce((sum: number, r: NamespaceStatsRow) => sum + r.total_memories, 0)
})
const expiringCount = computed(() => expiringMemories.value?.rowCount ?? 0)
const duplicateCount = computed(() => duplicates.value?.rowCount ?? 0)

// ── CSS bar chart helpers ───────────────────────

/** Maximum value in an array, minimum 1 to avoid division by zero. */
function maxOf(values: number[]): number {
  return Math.max(...values, 1)
}

/** Bar width percentage for a CSS-based chart. */
function barWidth(value: number, max: number): string {
  return `${Math.round((value / max) * 100)}%`
}

/** Color class for decay strength. */
function strengthColor(strength: number): string {
  if (strength >= 0.7) return 'bg-pg-success'
  if (strength >= 0.4) return 'bg-pg-warning'
  return 'bg-pg-error'
}

/** Text color for decay strength. */
function strengthTextColor(strength: number): string {
  if (strength >= 0.7) return 'text-pg-success'
  if (strength >= 0.4) return 'text-pg-warning'
  return 'text-pg-error'
}

/** Format milliseconds as human-readable duration. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

/** Format a timestamp bucket string into a readable date. */
function formatBucket(bucket: string): string {
  try {
    const ts = parseInt(bucket, 10)
    if (isNaN(ts)) return bucket
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
    })
  } catch {
    return bucket
  }
}

/** Format a number to 2 decimal places. */
function fmt2(n: number): string {
  return n.toFixed(2)
}

/** Format a percentage (0-1 range). */
function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`
}

/** Truncate text to given length. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

// ── Lifecycle ───────────────────────────────────
onMounted(() => {
  void refreshAll()
  startPolling()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header bar -->
    <div class="flex shrink-0 items-center justify-between border-b border-pg-border px-3 py-2">
      <div class="flex items-center gap-2">
        <h3 class="text-xs font-semibold text-pg-text-secondary">
          Memory Analytics
        </h3>
        <span
          v-if="isLoading"
          class="text-[10px] text-pg-text-muted"
        >
          Loading...
        </span>
      </div>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-[10px] text-pg-text-muted">
          Refresh:
          <select
            v-model.number="refreshIntervalSec"
            class="rounded border border-pg-border bg-pg-surface px-1 py-0.5 text-[10px] text-pg-text-secondary"
          >
            <option :value="0">
              Off
            </option>
            <option :value="10">
              10s
            </option>
            <option :value="30">
              30s
            </option>
            <option :value="60">
              60s
            </option>
          </select>
        </label>
        <button
          class="rounded-pg-sm border border-pg-border px-2 py-0.5 text-[10px] text-pg-text-muted hover:text-pg-text-secondary"
          :disabled="isLoading"
          @click="() => void refreshAll()"
        >
          Refresh
        </button>
      </div>
    </div>

    <!-- DuckDB unavailable warning -->
    <div
      v-if="isDuckDBUnavailable"
      class="flex flex-col items-center justify-center gap-2 p-8"
      role="alert"
    >
      <p class="text-sm font-medium text-pg-warning">
        Analytics Unavailable
      </p>
      <p class="text-center text-xs text-pg-text-muted">
        DuckDB-WASM is not installed. Memory analytics require the optional
        <code class="rounded bg-pg-surface-raised px-1 py-0.5 font-mono text-[10px]">@duckdb/duckdb-wasm</code>
        package.
      </p>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error && !isDuckDBUnavailable"
      class="px-4 py-3 text-xs text-pg-error"
      role="alert"
    >
      {{ error }}
    </div>

    <template v-else>
      <!-- Summary cards -->
      <div
        class="grid shrink-0 grid-cols-4 gap-2 border-b border-pg-border p-3"
        role="region"
        aria-label="Analytics summary"
      >
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-2">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Namespaces
          </p>
          <p class="mt-0.5 text-lg font-semibold text-pg-text">
            {{ totalNamespaces }}
          </p>
        </div>
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-2">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Memories
          </p>
          <p class="mt-0.5 text-lg font-semibold text-pg-text">
            {{ totalMemories }}
          </p>
        </div>
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-2">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Expiring
          </p>
          <p
            class="mt-0.5 text-lg font-semibold"
            :class="expiringCount > 0 ? 'text-pg-warning' : 'text-pg-text'"
          >
            {{ expiringCount }}
          </p>
        </div>
        <div class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-2">
          <p class="text-[10px] font-medium text-pg-text-muted">
            Duplicates
          </p>
          <p
            class="mt-0.5 text-lg font-semibold"
            :class="duplicateCount > 0 ? 'text-pg-warning' : 'text-pg-text'"
          >
            {{ duplicateCount }}
          </p>
        </div>
      </div>

      <!-- Sub-tab bar -->
      <div
        class="flex shrink-0 gap-1 overflow-x-auto border-b border-pg-border px-2 py-1.5"
        role="tablist"
        aria-label="Analytics views"
      >
        <button
          v-for="tab in subTabs"
          :key="tab.id"
          role="tab"
          :aria-selected="activeSubTab === tab.id"
          class="rounded-[8px] border px-2.5 py-1 text-[10px] font-medium transition-colors"
          :class="activeSubTab === tab.id
            ? 'border-pg-accent bg-pg-accent/10 text-pg-text'
            : 'border-transparent text-pg-text-muted hover:border-pg-border hover:text-pg-text-secondary'"
          @click="activeSubTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab content -->
      <div class="pg-scrollbar flex-1 overflow-y-auto">
        <!-- Decay Trends -->
        <div
          v-show="activeSubTab === 'decay'"
          class="p-3"
        >
          <!-- Window selector -->
          <div class="mb-3 flex items-center gap-2">
            <span class="text-[10px] text-pg-text-muted">Window:</span>
            <button
              v-for="w in (['hour', 'day', 'week'] as const)"
              :key="w"
              class="rounded border px-2 py-0.5 text-[10px]"
              :class="decayWindow === w
                ? 'border-pg-accent bg-pg-accent/10 text-pg-text'
                : 'border-pg-border text-pg-text-muted hover:text-pg-text-secondary'"
              @click="decayWindow = w"
            >
              {{ w }}
            </button>
          </div>

          <!-- No data -->
          <div
            v-if="!decayTrends || decayTrends.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No decay trend data available.
            </p>
          </div>

          <!-- CSS bar chart for decay trends -->
          <div
            v-else
            class="flex flex-col gap-1.5"
          >
            <div
              v-for="(point, idx) in (decayTrends.rows as DecayTrendPoint[])"
              :key="`decay-${idx}`"
              class="flex items-center gap-2"
            >
              <span class="w-20 shrink-0 truncate text-[10px] font-medium text-pg-text-secondary">
                {{ formatBucket(point.bucket) }}
              </span>
              <span class="w-14 shrink-0 truncate text-[10px] text-pg-text-muted">
                {{ point.namespace }}
              </span>
              <div class="h-3 flex-1 overflow-hidden rounded-full bg-pg-surface-raised">
                <div
                  class="h-full rounded-full transition-all"
                  :class="strengthColor(point.avg_strength)"
                  :style="{ width: barWidth(point.avg_strength, 1.0) }"
                />
              </div>
              <span
                class="w-10 shrink-0 text-right font-mono text-[10px]"
                :class="strengthTextColor(point.avg_strength)"
              >
                {{ fmt2(point.avg_strength) }}
              </span>
              <span class="w-8 shrink-0 text-right font-mono text-[10px] text-pg-text-muted">
                {{ point.count }}x
              </span>
            </div>
          </div>

          <p
            v-if="decayTrends"
            class="mt-2 text-[9px] text-pg-text-muted"
          >
            Query: {{ decayTrends.executionMs }}ms
          </p>
        </div>

        <!-- Namespace Stats -->
        <div
          v-show="activeSubTab === 'namespaces'"
          class="p-3"
        >
          <div
            v-if="!namespaceStats || namespaceStats.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No namespace data available.
            </p>
          </div>

          <div
            v-else
            class="overflow-auto"
          >
            <table
              class="w-full text-[11px]"
              role="table"
              aria-label="Namespace statistics"
            >
              <thead>
                <tr class="border-b border-pg-border">
                  <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                    Namespace
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Total
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Active
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Avg Strength
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Avg Importance
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, idx) in (namespaceStats.rows as NamespaceStatsRow[])"
                  :key="`ns-${idx}`"
                  class="border-b border-pg-border-subtle/50"
                >
                  <td class="py-1.5 font-medium text-pg-accent">
                    {{ row.namespace }}
                  </td>
                  <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                    {{ row.total_memories }}
                  </td>
                  <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                    {{ row.active_memories }}
                  </td>
                  <td class="py-1.5 text-right">
                    <div class="flex items-center justify-end gap-1">
                      <div class="h-1.5 w-10 overflow-hidden rounded-full bg-pg-surface-raised">
                        <div
                          class="h-full rounded-full"
                          :class="strengthColor(row.avg_strength)"
                          :style="{ width: barWidth(row.avg_strength, 1.0) }"
                        />
                      </div>
                      <span
                        class="font-mono text-[10px]"
                        :class="strengthTextColor(row.avg_strength)"
                      >
                        {{ fmt2(row.avg_strength) }}
                      </span>
                    </div>
                  </td>
                  <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                    {{ fmt2(row.avg_importance) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mt-2 text-[9px] text-pg-text-muted">
              Query: {{ namespaceStats.executionMs }}ms
            </p>
          </div>
        </div>

        <!-- Expiring Memories -->
        <div
          v-show="activeSubTab === 'expiring'"
          class="p-3"
        >
          <div
            v-if="!expiringMemories || expiringMemories.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No memories approaching expiration.
            </p>
          </div>

          <div
            v-else
            class="flex flex-col gap-2"
          >
            <div
              v-for="(mem, idx) in (expiringMemories.rows as ExpiringMemoryRow[])"
              :key="`exp-${idx}`"
              class="rounded-pg-sm border border-pg-border bg-pg-surface-raised p-2"
            >
              <div class="flex items-center justify-between">
                <span class="truncate font-mono text-[10px] text-pg-text-secondary">
                  {{ mem.id }}
                </span>
                <span class="shrink-0 text-[10px] text-pg-text-muted">
                  {{ mem.namespace }}
                </span>
              </div>
              <div class="mt-1 flex items-center gap-3">
                <div class="flex items-center gap-1">
                  <span class="text-[10px] text-pg-text-muted">Strength:</span>
                  <span
                    class="font-mono text-[10px] font-semibold"
                    :class="strengthTextColor(mem.decay_strength)"
                  >
                    {{ fmt2(mem.decay_strength) }}
                  </span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="text-[10px] text-pg-text-muted">Expires in:</span>
                  <span class="font-mono text-[10px] text-pg-warning">
                    {{ formatDuration(mem.expires_in_ms) }}
                  </span>
                </div>
              </div>
            </div>
            <p class="text-[9px] text-pg-text-muted">
              {{ expiringMemories.rowCount }} memor{{ expiringMemories.rowCount === 1 ? 'y' : 'ies' }} expiring.
              Query: {{ expiringMemories.executionMs }}ms
            </p>
          </div>
        </div>

        <!-- Agent Performance -->
        <div
          v-show="activeSubTab === 'agents'"
          class="p-3"
        >
          <div
            v-if="!agentPerformance || agentPerformance.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No agent performance data available.
            </p>
          </div>

          <div
            v-else
            class="overflow-auto"
          >
            <table
              class="w-full text-[11px]"
              role="table"
              aria-label="Agent performance comparison"
            >
              <thead>
                <tr class="border-b border-pg-border">
                  <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                    Agent
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Memories
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Avg Importance
                  </th>
                  <th class="pb-1.5 text-right font-medium text-pg-text-muted">
                    Active Ratio
                  </th>
                  <th class="pb-1.5 text-left font-medium text-pg-text-muted">
                    Categories
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, idx) in (agentPerformance.rows as AgentPerformanceRow[])"
                  :key="`agent-${idx}`"
                  class="border-b border-pg-border-subtle/50"
                >
                  <td class="py-1.5 font-medium text-pg-accent">
                    {{ row.agent_id }}
                  </td>
                  <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                    {{ row.total_memories }}
                  </td>
                  <td class="py-1.5 text-right font-mono text-pg-text-secondary">
                    {{ fmt2(row.avg_importance) }}
                  </td>
                  <td class="py-1.5 text-right">
                    <span
                      class="font-mono text-[10px]"
                      :class="row.active_ratio >= 0.7 ? 'text-pg-success' : row.active_ratio >= 0.4 ? 'text-pg-warning' : 'text-pg-error'"
                    >
                      {{ fmtPct(row.active_ratio) }}
                    </span>
                  </td>
                  <td class="py-1.5">
                    <div class="flex flex-wrap gap-1">
                      <span
                        v-for="cat in (row.categories ?? [])"
                        :key="cat"
                        class="rounded-sm bg-pg-surface px-1 py-0.5 text-[9px] text-pg-text-muted"
                      >
                        {{ cat }}
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="mt-2 text-[9px] text-pg-text-muted">
              Query: {{ agentPerformance.executionMs }}ms
            </p>
          </div>
        </div>

        <!-- Usage Patterns -->
        <div
          v-show="activeSubTab === 'usage'"
          class="p-3"
        >
          <div
            v-if="!usagePatterns || usagePatterns.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No usage pattern data available.
            </p>
          </div>

          <!-- CSS histogram -->
          <div
            v-else
            class="flex flex-col gap-1"
          >
            <div
              v-for="(bucket, idx) in (usagePatterns.rows as UsagePatternBucket[])"
              :key="`usage-${idx}`"
              class="flex items-center gap-2"
            >
              <span class="w-24 shrink-0 truncate text-[10px] text-pg-text-secondary">
                {{ formatBucket(String(bucket.bucket_start)) }}
              </span>
              <div class="h-4 flex-1 overflow-hidden rounded bg-pg-surface-raised">
                <div
                  class="flex h-full items-center rounded bg-pg-accent/30"
                  :style="{ width: barWidth(bucket.access_count, maxOf((usagePatterns!.rows as UsagePatternBucket[]).map((b: UsagePatternBucket) => b.access_count))) }"
                >
                  <span
                    v-if="bucket.access_count > 0"
                    class="px-1 font-mono text-[9px] text-pg-text"
                  >
                    {{ bucket.access_count }}
                  </span>
                </div>
              </div>
              <span class="w-12 shrink-0 text-right font-mono text-[10px] text-pg-text-muted">
                {{ bucket.unique_memories }} mem
              </span>
            </div>
            <p class="mt-2 text-[9px] text-pg-text-muted">
              {{ usagePatterns.rowCount }} bucket{{ usagePatterns.rowCount === 1 ? '' : 's' }}.
              Query: {{ usagePatterns.executionMs }}ms
            </p>
          </div>
        </div>

        <!-- Duplicates -->
        <div
          v-show="activeSubTab === 'duplicates'"
          class="p-3"
        >
          <div
            v-if="!duplicates || duplicates.rowCount === 0"
            class="flex h-24 items-center justify-center"
          >
            <p class="text-xs text-pg-text-muted">
              No potential duplicates found.
            </p>
          </div>

          <div
            v-else
            class="flex flex-col gap-2"
          >
            <div
              v-for="(pair, idx) in (duplicates.rows as DuplicateCandidateRow[])"
              :key="`dup-${idx}`"
              class="rounded-pg-sm border border-pg-warning/30 bg-pg-warning/5 p-2"
            >
              <div class="mb-1 flex items-center justify-between">
                <span class="text-[10px] font-medium text-pg-text-secondary">
                  {{ pair.namespace }}
                </span>
              </div>
              <div class="flex flex-col gap-1">
                <div class="flex items-start gap-2">
                  <span class="shrink-0 font-mono text-[9px] text-pg-text-muted">A:</span>
                  <span class="font-mono text-[10px] text-pg-text-secondary">
                    {{ truncate(pair.text_a, 80) }}
                  </span>
                </div>
                <div class="flex items-start gap-2">
                  <span class="shrink-0 font-mono text-[9px] text-pg-text-muted">B:</span>
                  <span class="font-mono text-[10px] text-pg-text-secondary">
                    {{ truncate(pair.text_b, 80) }}
                  </span>
                </div>
              </div>
              <div class="mt-1 flex gap-3">
                <span class="font-mono text-[9px] text-pg-text-muted">
                  {{ pair.id_a }}
                </span>
                <span class="font-mono text-[9px] text-pg-text-muted">
                  {{ pair.id_b }}
                </span>
              </div>
            </div>
            <p class="text-[9px] text-pg-text-muted">
              {{ duplicates.rowCount }} potential duplicate{{ duplicates.rowCount === 1 ? '' : 's' }}.
              Query: {{ duplicates.executionMs }}ms
            </p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
