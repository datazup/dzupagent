<script setup lang="ts">
/**
 * EvalDashboard -- score summary cards and results table for eval runs.
 *
 * Shows aggregate pass rate, average score, and a per-run results table.
 * Wires to the eval store for fetching completed runs and their results.
 *
 * TODO: wire to GET /api/evals/dashboard if/when a dedicated dashboard
 * endpoint is added to the server. Currently aggregates from existing
 * eval run data.
 */
import { onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useEvalStore } from '../stores/eval-store.js'
import PgBadge from '../components/ui/PgBadge.vue'

const router = useRouter()
const evalStore = useEvalStore()

// ── Computed aggregations from eval runs ──────────────────

const completedRuns = computed(() =>
  evalStore.runs.filter((r) => r.status === 'completed' && r.result),
)

const totalRuns = computed(() => evalStore.runs.length)
const completedCount = computed(() => completedRuns.value.length)
const failedCount = computed(() => evalStore.runs.filter((r) => r.status === 'failed').length)

const avgScore = computed(() => {
  const runs = completedRuns.value
  if (runs.length === 0) return null
  const sum = runs.reduce((acc, r) => acc + (r.result?.aggregateScore ?? 0), 0)
  return sum / runs.length
})

const passRate = computed(() => {
  const runs = completedRuns.value
  if (runs.length === 0) return null
  const passing = runs.filter((r) => (r.result?.passRate ?? 0) >= 0.5).length
  return (passing / runs.length) * 100
})

const avgPassRate = computed(() => {
  const runs = completedRuns.value
  if (runs.length === 0) return null
  const sum = runs.reduce((acc, r) => acc + (r.result?.passRate ?? 0), 0)
  return (sum / runs.length) * 100
})

function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return '--'
  return score.toFixed(2)
}

function formatPercent(value: number | null): string {
  if (value === null) return '--'
  return `${value.toFixed(1)}%`
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

async function openRun(id: string): Promise<void> {
  await router.push({ name: 'eval-detail', params: { id } })
}

async function refresh(): Promise<void> {
  await evalStore.fetchRuns()
}

onMounted(() => {
  void evalStore.fetchRuns()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-pg-border pg-surface-glass px-6 py-4">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          Eval Dashboard
        </h1>
        <p class="text-xs text-pg-text-muted">
          Aggregate scores and pass rates across eval runs.
        </p>
      </div>
      <button
        class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
        :disabled="evalStore.isLoading"
        @click="refresh"
      >
        Refresh
      </button>
    </header>

    <!-- Error -->
    <div
      v-if="evalStore.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ evalStore.error }}
      <button
        class="ml-2 underline"
        @click="evalStore.clearError()"
      >
        Dismiss
      </button>
    </div>

    <!-- Loading -->
    <div
      v-if="evalStore.isLoading"
      class="flex flex-1 items-center justify-center"
    >
      <span class="text-sm text-pg-text-muted">Loading eval data...</span>
    </div>

    <!-- Content -->
    <div
      v-else
      class="pg-scrollbar flex-1 overflow-y-auto"
    >
      <!-- Summary cards -->
      <div class="grid grid-cols-2 gap-4 border-b border-pg-border p-6 md:grid-cols-5">
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-4 py-3">
          <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
            Total Runs
          </div>
          <div class="mt-1 text-2xl font-semibold text-pg-text">
            {{ totalRuns }}
          </div>
        </div>
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-4 py-3">
          <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
            Completed
          </div>
          <div class="mt-1 text-2xl font-semibold text-pg-success">
            {{ completedCount }}
          </div>
        </div>
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-4 py-3">
          <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
            Failed
          </div>
          <div class="mt-1 text-2xl font-semibold text-pg-error">
            {{ failedCount }}
          </div>
        </div>
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-4 py-3">
          <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
            Avg Score
          </div>
          <div class="mt-1 text-2xl font-semibold text-pg-text">
            {{ formatScore(avgScore) }}
          </div>
        </div>
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-4 py-3">
          <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
            Avg Pass Rate
          </div>
          <div class="mt-1 text-2xl font-semibold text-pg-accent">
            {{ formatPercent(avgPassRate) }}
          </div>
        </div>
      </div>

      <!-- Pass rate card -->
      <div
        v-if="passRate !== null"
        class="border-b border-pg-border px-6 py-4"
      >
        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
            Suite Pass Rate
          </div>
          <div class="flex items-end gap-3">
            <span class="text-3xl font-bold text-pg-accent">{{ formatPercent(passRate) }}</span>
            <span class="mb-1 text-xs text-pg-text-secondary">
              of {{ completedCount }} completed runs have pass rate >= 50%
            </span>
          </div>
          <!-- Simple bar -->
          <div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-pg-surface">
            <div
              class="h-full rounded-full bg-pg-accent transition-all"
              :style="{ width: `${passRate}%` }"
            />
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="evalStore.runs.length === 0"
        class="flex flex-1 items-center justify-center py-16"
      >
        <div class="text-center">
          <p class="text-sm text-pg-text-secondary">
            No eval runs yet
          </p>
          <p class="mt-1 text-xs text-pg-text-muted">
            Run evaluations from the Evals view to see results here.
          </p>
        </div>
      </div>

      <!-- Results table -->
      <div
        v-if="evalStore.runs.length > 0"
        class="p-6"
      >
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-pg-text-muted">
          Run Results
        </h2>
        <div class="overflow-hidden rounded-pg-lg border border-pg-border bg-pg-surface shadow-sm">
          <table class="min-w-full divide-y divide-pg-border text-left text-sm">
            <thead class="bg-pg-surface-raised text-xs uppercase tracking-wide text-pg-text-muted">
              <tr>
                <th class="px-4 py-3">
                  Run
                </th>
                <th class="px-4 py-3">
                  Suite
                </th>
                <th class="px-4 py-3">
                  Status
                </th>
                <th class="px-4 py-3">
                  Score
                </th>
                <th class="px-4 py-3">
                  Pass Rate
                </th>
                <th class="px-4 py-3">
                  Completed
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-pg-border">
              <tr
                v-for="run in evalStore.runs"
                :key="run.id"
                class="cursor-pointer transition-colors hover:bg-pg-surface-raised"
                @click="openRun(run.id)"
              >
                <td class="px-4 py-3 font-mono text-xs text-pg-text-secondary">
                  {{ run.id.slice(0, 8) }}
                </td>
                <td class="px-4 py-3">
                  <div class="font-medium text-pg-text">
                    {{ run.suiteId }}
                  </div>
                  <div class="text-xs text-pg-text-muted">
                    {{ run.suite.description ?? run.suite.name }}
                  </div>
                </td>
                <td class="px-4 py-3">
                  <PgBadge :status="run.status">
                    {{ run.status }}
                  </PgBadge>
                </td>
                <td class="px-4 py-3 font-mono text-sm text-pg-text">
                  {{ run.result ? formatScore(run.result.aggregateScore) : '--' }}
                </td>
                <td class="px-4 py-3 font-mono text-sm text-pg-text">
                  {{ run.result ? formatPercent(run.result.passRate * 100) : '--' }}
                </td>
                <td class="px-4 py-3 text-xs text-pg-text-secondary">
                  {{ run.completedAt ? formatDate(run.completedAt) : 'In progress' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
