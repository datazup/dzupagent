<script setup lang="ts">
/**
 * BenchmarkRunDetailView -- inspect a single benchmark run and compare against a baseline.
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBenchmarkStore } from '../stores/benchmark-store.js'

const route = useRoute()
const router = useRouter()
const benchmarkStore = useBenchmarkStore()

const runId = computed(() => String(route.params.runId ?? ''))
const run = computed(() => {
  const current = benchmarkStore.selectedRun
  return current?.id === runId.value ? current : null
})
const baseline = computed(() => {
  const current = run.value
  if (!current) return null
  return benchmarkStore.findBaseline(current.suiteId, current.targetId)
})
const comparison = computed(() => benchmarkStore.comparison)
const sortedScores = computed(() => {
  const current = run.value
  if (!current) return []

  return Object.entries(current.result.scores).sort((a, b) => b[1] - a[1])
})

function formatDate(value?: string): string {
  if (!value) return '--'
  return new Date(value).toLocaleString()
}

function formatScore(value: number): string {
  return value.toFixed(2)
}

function scoreClass(passedBaseline: boolean): string {
  return passedBaseline
    ? 'bg-pg-success/15 text-pg-success'
    : 'bg-pg-warning/15 text-pg-warning'
}

function shortBuildSha(value?: string): string {
  if (!value) return '--'
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

function artifactEntries(artifact?: {
  suiteVersion?: string
  datasetHash?: string
  promptConfigVersion?: string
  promptVersion?: string
  configVersion?: string
  buildSha?: string
  modelProfile?: string
}): Array<{ label: string; value: string }> {
  if (!artifact) return []

  const promptConfigVersion = artifact.promptConfigVersion
    ?? [artifact.promptVersion, artifact.configVersion].filter((value): value is string => Boolean(value)).join(' / ')

  return [
    { label: 'Model profile', value: artifact.modelProfile ?? '--' },
    { label: 'Suite version', value: artifact.suiteVersion ?? '--' },
    { label: 'Dataset hash', value: artifact.datasetHash ?? '--' },
    { label: 'Prompt/config version', value: promptConfigVersion || '--' },
    { label: 'Build SHA', value: artifact.buildSha ? shortBuildSha(artifact.buildSha) : '--' },
  ]
}

async function loadRun(): Promise<void> {
  if (!runId.value) return
  benchmarkStore.clearSelection()
  benchmarkStore.clearComparison()
  await Promise.all([
    benchmarkStore.fetchRun(runId.value),
    benchmarkStore.fetchBaselines(),
  ])
}

async function handleRefresh(): Promise<void> {
  await loadRun()
}

async function handleCompare(): Promise<void> {
  if (!run.value) return
  if (baseline.value) {
    await benchmarkStore.compareRun(run.value.id, baseline.value.runId)
    return
  }

  await benchmarkStore.compareRun(run.value.id)
}

async function handleSetBaseline(): Promise<void> {
  if (!run.value) return
  const updated = await benchmarkStore.setBaseline({
    suiteId: run.value.suiteId,
    targetId: run.value.targetId,
    runId: run.value.id,
  })
  if (updated) {
    await benchmarkStore.fetchBaselines({
      suiteId: run.value.suiteId,
      targetId: run.value.targetId,
    })
  }
}

async function handleBack(): Promise<void> {
  await router.push({ name: 'benchmarks' })
}

onMounted(() => {
  void loadRun()
})

watch(runId, () => {
  void loadRun()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex flex-col gap-4 border-b border-pg-border pg-surface-glass px-6 py-4 xl:flex-row xl:items-center xl:justify-between">
      <div>
        <p class="text-xs uppercase tracking-wide text-pg-text-muted">
          Benchmark run
        </p>
        <h1 class="text-base font-semibold text-pg-text">
          {{ run?.suiteId ?? runId }}
        </h1>
        <p class="text-xs text-pg-text-muted">
          Inspect scores, baselines, and baseline comparisons.
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="handleBack"
        >
          Back to benchmarks
        </button>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="handleRefresh"
        >
          Refresh
        </button>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!run || benchmarkStore.isComparing"
          @click="handleCompare"
        >
          {{ benchmarkStore.isComparing ? 'Comparing...' : 'Compare' }}
        </button>
        <button
          class="rounded-pg-sm bg-pg-accent px-3 py-1.5 text-xs font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!run || benchmarkStore.isSettingBaseline"
          @click="handleSetBaseline"
        >
          {{ benchmarkStore.isSettingBaseline ? 'Saving...' : 'Set baseline' }}
        </button>
      </div>
    </header>

    <div
      v-if="benchmarkStore.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ benchmarkStore.error }}
      <button
        class="ml-2 underline"
        @click="benchmarkStore.clearError()"
      >
        Dismiss
      </button>
    </div>

    <div
      v-if="benchmarkStore.isLoadingDetail && !run"
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Loading benchmark run...
    </div>

    <div
      v-else-if="run"
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div class="grid gap-6 xl:grid-cols-[1fr_360px]">
        <section class="space-y-4 rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
          <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="scoreClass(run.result.passedBaseline)">
                  {{ run.result.passedBaseline ? 'Passed baseline' : 'Regression' }}
                </span>
                <span class="font-mono text-xs text-pg-text-muted">{{ run.id }}</span>
              </div>
              <p class="mt-2 text-sm text-pg-text-secondary">
                Target {{ run.targetId }} · {{ run.strict ? 'Strict mode' : 'Default mode' }}
              </p>
            </div>
            <div class="text-right text-xs text-pg-text-muted">
              Created {{ formatDate(run.createdAt) }}
            </div>
          </div>

          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Suite</div>
              <div class="mt-1 text-sm text-pg-text">{{ run.suiteId }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Target</div>
              <div class="mt-1 text-sm text-pg-text">{{ run.targetId }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Strict</div>
              <div class="mt-1 text-sm text-pg-text">{{ run.strict ? 'Yes' : 'No' }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Updated</div>
              <div class="mt-1 text-sm text-pg-text">{{ formatDate(run.result.timestamp) }}</div>
            </div>
          </div>

          <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
                  Scores
                </div>
                <p class="text-sm text-pg-text-secondary">
                  Passed baseline: {{ run.result.passedBaseline ? 'yes' : 'no' }}.
                </p>
              </div>
              <div class="text-right text-xs text-pg-text-muted">
                {{ Object.keys(run.result.scores).length }} scorers
              </div>
            </div>

            <div class="mt-4 overflow-hidden rounded-pg border border-pg-border">
              <table class="min-w-full divide-y divide-pg-border text-left text-sm">
                <thead class="bg-pg-surface text-xs uppercase tracking-wide text-pg-text-muted">
                  <tr>
                    <th class="px-3 py-2">Scorer</th>
                    <th class="px-3 py-2">Score</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-pg-border">
                  <tr
                    v-for="[scorerId, score] in sortedScores"
                    :key="scorerId"
                  >
                    <td class="px-3 py-2 font-mono text-xs text-pg-text-secondary">{{ scorerId }}</td>
                    <td class="px-3 py-2 text-pg-text">{{ formatScore(score) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              v-if="run.result.regressions.length > 0"
              class="mt-4 rounded-pg border border-pg-warning/30 bg-pg-warning/10 p-3 text-sm text-pg-text-secondary"
            >
              <div class="text-xs font-semibold uppercase tracking-wide text-pg-warning">
                Regressions
              </div>
              <div class="mt-2 flex flex-wrap gap-2">
                <span
                  v-for="regression in run.result.regressions"
                  :key="regression"
                  class="rounded-full border border-pg-warning/30 bg-pg-surface px-2.5 py-1 text-xs text-pg-text"
                >
                  {{ regression }}
                </span>
              </div>
            </div>
          </div>

          <div
            v-if="baseline"
            class="rounded-pg border border-pg-border bg-pg-surface-raised p-4 text-sm text-pg-text-secondary"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Baseline
            </div>
            <div class="mt-2">
              Current baseline run {{ baseline.runId.slice(0, 8) }} updated {{ formatDate(baseline.updatedAt) }}.
            </div>
          </div>

          <div
            v-if="comparison"
            class="rounded-pg border border-pg-border bg-pg-surface-raised p-4"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Comparison
            </div>
            <p class="mt-2 text-sm text-pg-text-secondary">
              Current run {{ comparison.currentRun.id.slice(0, 8) }} vs previous run {{ comparison.previousRun.id.slice(0, 8) }}.
            </p>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <div class="rounded-pg border border-pg-border bg-pg-surface p-3 text-sm">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Improved</div>
                <div class="mt-1 text-lg font-semibold text-pg-text">{{ comparison.comparison.improved.length }}</div>
              </div>
              <div class="rounded-pg border border-pg-border bg-pg-surface p-3 text-sm">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Regressed</div>
                <div class="mt-1 text-lg font-semibold text-pg-text">{{ comparison.comparison.regressed.length }}</div>
              </div>
              <div class="rounded-pg border border-pg-border bg-pg-surface p-3 text-sm">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Unchanged</div>
                <div class="mt-1 text-lg font-semibold text-pg-text">{{ comparison.comparison.unchanged.length }}</div>
              </div>
            </div>
          </div>

          <div
            v-if="run.metadata && Object.keys(run.metadata).length > 0"
            class="rounded-pg border border-pg-border bg-pg-surface-raised p-4"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Metadata
            </div>
            <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(run.metadata, null, 2) }}</pre>
          </div>

          <div
            v-if="run.artifact && artifactEntries(run.artifact).length > 0"
            class="rounded-pg border border-pg-border bg-pg-surface-raised p-4"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Artifact provenance
            </div>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <div
                v-for="entry in artifactEntries(run.artifact)"
                :key="entry.label"
                class="rounded-pg border border-pg-border bg-pg-surface px-3 py-2"
              >
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
                  {{ entry.label }}
                </div>
                <div class="mt-1 font-mono text-sm text-pg-text">
                  {{ entry.value }}
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside class="space-y-4">
          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Benchmark health
            </div>
            <div class="mt-3 space-y-2 text-sm text-pg-text-secondary">
              <div class="flex items-center justify-between gap-3">
                <span>Status</span>
                <span>{{ run.result.passedBaseline ? 'Healthy' : 'Regression detected' }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span>Scores</span>
                <span>{{ Object.keys(run.result.scores).length }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span>Regressions</span>
                <span>{{ run.result.regressions.length }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span>Strict</span>
                <span>{{ run.strict ? 'Yes' : 'No' }}</span>
              </div>
            </div>
          </div>

          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Baseline actions
            </div>
            <p class="mt-2 text-sm text-pg-text-secondary">
              Compare against the current baseline or promote this run as the baseline.
            </p>
            <div class="mt-4 flex flex-col gap-2">
              <button
                class="rounded-pg-sm border border-pg-border px-3 py-2 text-left text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="!baseline || benchmarkStore.isComparing"
                @click="handleCompare"
              >
                {{ benchmarkStore.isComparing ? 'Comparing...' : 'Compare with baseline' }}
              </button>
              <button
                class="rounded-pg-sm bg-pg-accent px-3 py-2 text-left text-xs font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="benchmarkStore.isSettingBaseline"
                @click="handleSetBaseline"
              >
                {{ benchmarkStore.isSettingBaseline ? 'Saving...' : 'Set this run as baseline' }}
              </button>
            </div>
          </div>

          <div
            v-if="comparison"
            class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Comparison details
            </div>
            <div class="mt-3 space-y-2 text-sm text-pg-text-secondary">
              <div>
                Improved: {{ comparison.comparison.improved.join(', ') || '--' }}
              </div>
              <div>
                Regressed: {{ comparison.comparison.regressed.join(', ') || '--' }}
              </div>
              <div>
                Unchanged: {{ comparison.comparison.unchanged.join(', ') || '--' }}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>

    <div
      v-else
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Benchmark run not found.
    </div>
  </div>
</template>
