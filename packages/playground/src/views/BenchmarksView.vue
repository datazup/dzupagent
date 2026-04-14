<script setup lang="ts">
/**
 * BenchmarksView -- create and inspect benchmark runs and baselines.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useBenchmarkStore } from '../stores/benchmark-store.js'

const router = useRouter()
const benchmarkStore = useBenchmarkStore()

const newSuiteId = ref('')
const newTargetId = ref('')
const newStrict = ref(false)
const newMetadata = ref('')

const summaryItems = computed(() => [
  { label: 'Runs', value: benchmarkStore.historyRuns.length },
  { label: 'Baselines', value: benchmarkStore.baselineCount },
  { label: 'Passing runs', value: benchmarkStore.historyRuns.filter((run) => run.result.passedBaseline).length },
  { label: 'Strict', value: benchmarkStore.historyRuns.filter((run) => run.strict).length },
])

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

function formatScore(value: number): string {
  return value.toFixed(2)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function artifactSummary(run: { artifact?: { modelProfile?: string; buildSha?: string; datasetHash?: string; suiteVersion?: string; promptConfigVersion?: string } }): string | null {
  const artifact = run.artifact
  if (!artifact) return null

  const parts = [
    artifact.modelProfile,
    artifact.suiteVersion ? `suite ${artifact.suiteVersion}` : null,
    artifact.datasetHash ? `dataset ${artifact.datasetHash.slice(0, 8)}` : null,
    artifact.promptConfigVersion ? `cfg ${artifact.promptConfigVersion}` : null,
    artifact.buildSha ? `build ${shortBuildSha(artifact.buildSha)}` : null,
  ].filter((value): value is string => Boolean(value))

  return parts.length > 0 ? parts.join(' · ') : null
}

async function refresh(): Promise<void> {
  await Promise.all([
    benchmarkStore.loadHistory(),
    benchmarkStore.fetchBaselines(),
  ])
}

async function handleCreateRun(): Promise<void> {
  const suiteId = newSuiteId.value.trim()
  const targetId = newTargetId.value.trim()
  if (!suiteId || !targetId) return

  let metadata: Record<string, unknown> | undefined
  const rawMetadata = newMetadata.value.trim()
  if (rawMetadata) {
    try {
      const parsed = JSON.parse(rawMetadata) as unknown
      if (!isPlainObject(parsed)) {
        benchmarkStore.error = 'Metadata must be a JSON object'
        return
      }
      metadata = parsed
    } catch {
      benchmarkStore.error = 'Metadata must be valid JSON'
      return
    }
  }

  const created = await benchmarkStore.createRun({
    suiteId,
    targetId,
    strict: newStrict.value,
    metadata,
  })
  if (created) {
    newSuiteId.value = ''
    newTargetId.value = ''
    newStrict.value = false
    newMetadata.value = ''
    await benchmarkStore.fetchBaselines({ suiteId: created.suiteId, targetId: created.targetId })
    await router.push({ name: 'benchmark-detail', params: { runId: created.id } })
  }
}

async function openRun(runId: string): Promise<void> {
  await router.push({ name: 'benchmark-detail', params: { runId } })
}

async function handleLoadMore(): Promise<void> {
  await benchmarkStore.loadMoreHistory()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex flex-col gap-4 border-b border-pg-border pg-surface-glass px-6 py-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          Benchmarks
        </h1>
        <p class="text-xs text-pg-text-muted">
          Queue benchmark runs, inspect recent results, and manage baselines.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-xs text-pg-text-secondary">
        <span class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
          {{ benchmarkStore.recentRuns.length }} recent
        </span>
        <span class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
          {{ benchmarkStore.baselineCount }} baselines
        </span>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          :disabled="benchmarkStore.isLoading || benchmarkStore.isLoadingBaselines"
          @click="refresh"
        >
          Refresh
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

    <section class="grid gap-4 border-b border-pg-border bg-pg-surface px-6 py-4 xl:grid-cols-[1fr_380px]">
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div
            v-for="item in summaryItems"
            :key="item.label"
            class="rounded-pg-lg border border-pg-border bg-pg-surface-raised px-3 py-2"
          >
            <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">
              {{ item.label }}
            </div>
            <div class="mt-1 text-lg font-semibold text-pg-text">
              {{ item.value }}
            </div>
          </div>
        </div>

        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
                Run history
              </div>
              <p class="text-sm text-pg-text-secondary">
                Server-backed history is shown first. Browser-session runs are used when the server list is unavailable.
              </p>
            </div>
            <div class="flex items-center gap-2 text-xs text-pg-text-muted">
              <span
                v-if="benchmarkStore.isLoadingHistory"
                class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1 text-[11px] font-medium text-pg-text-secondary"
              >
                Loading server history...
              </span>
              <span
                v-else-if="benchmarkStore.isLoadingHistoryMore"
                class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1 text-[11px] font-medium text-pg-text-secondary"
              >
                Loading more history...
              </span>
              <span
                v-else-if="benchmarkStore.isSessionFallback"
                class="rounded-full border border-pg-warning/30 bg-pg-warning/10 px-2 py-0.5 text-[11px] font-medium text-pg-warning"
              >
                Session fallback
              </span>
              <span>{{ benchmarkStore.historyRuns.length }} visible</span>
            </div>
          </div>

          <div
            v-if="benchmarkStore.historyRuns.length === 0"
            class="mt-4 rounded-pg border border-dashed border-pg-border bg-pg-surface px-4 py-5 text-sm text-pg-text-muted"
          >
            No benchmark runs yet. Create one from the form or refresh once the server exposes history.
          </div>

          <div
            v-else
            class="mt-4 overflow-hidden rounded-pg border border-pg-border bg-pg-surface"
          >
            <table class="min-w-full divide-y divide-pg-border text-left text-sm">
              <thead class="bg-pg-surface-raised text-xs uppercase tracking-wide text-pg-text-muted">
                <tr>
                  <th class="px-4 py-3">Run</th>
                  <th class="px-4 py-3">Suite / Target</th>
                  <th class="px-4 py-3">Baseline</th>
                  <th class="px-4 py-3">Strict</th>
                  <th class="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pg-border">
                <tr
                  v-for="run in benchmarkStore.historyRuns"
                  :key="run.id"
                  class="cursor-pointer transition-colors hover:bg-pg-surface-raised"
                  @click="openRun(run.id)"
                >
                  <td class="px-4 py-3 font-mono text-xs text-pg-text-secondary">
                    {{ run.id.slice(0, 8) }}
                  </td>
                  <td class="px-4 py-3">
                    <div class="font-medium text-pg-text">{{ run.suiteId }}</div>
                    <div class="text-xs text-pg-text-muted">
                      Target {{ run.targetId }}
                    </div>
                    <div
                      v-if="artifactSummary(run)"
                      class="mt-1 text-[11px] text-pg-text-muted"
                    >
                      Artifact {{ artifactSummary(run) }}
                    </div>
                  </td>
                  <td class="px-4 py-3">
                    <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="scoreClass(run.result.passedBaseline)">
                      {{ run.result.passedBaseline ? 'Passed' : 'Regressed' }}
                    </span>
                    <div class="mt-1 text-xs text-pg-text-muted">
                      {{ run.result.regressions.length }} regressions
                    </div>
                  </td>
                  <td class="px-4 py-3 text-pg-text-secondary">
                    {{ run.strict ? 'Yes' : 'No' }}
                  </td>
                  <td class="px-4 py-3 text-pg-text-secondary">
                    {{ formatDate(run.createdAt) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            v-if="benchmarkStore.historyHasMore"
            class="mt-4 flex justify-center"
          >
            <button
              type="button"
              class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="benchmarkStore.isLoadingHistoryMore || benchmarkStore.isLoadingHistory"
              @click="handleLoadMore"
            >
              {{ benchmarkStore.isLoadingHistoryMore ? 'Loading more...' : 'Load more' }}
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <form class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4" @submit.prevent="handleCreateRun">
          <div class="text-sm font-semibold text-pg-text">
            Start a benchmark
          </div>
          <p class="mt-1 text-xs text-pg-text-muted">
            Provide a suite id and target id. Metadata is optional.
          </p>

          <label class="mt-4 block text-xs font-medium text-pg-text-secondary">
            Suite ID
            <input
              v-model="newSuiteId"
              type="text"
              placeholder="code-gen"
              class="pg-input mt-1 w-full"
            >
          </label>

          <label class="mt-3 block text-xs font-medium text-pg-text-secondary">
            Target ID
            <input
              v-model="newTargetId"
              type="text"
              placeholder="agent-1"
              class="pg-input mt-1 w-full"
            >
          </label>

          <label class="mt-3 flex items-center gap-2 text-xs font-medium text-pg-text-secondary">
            <input
              v-model="newStrict"
              type="checkbox"
              class="rounded border-pg-border bg-pg-surface text-pg-accent focus:ring-pg-accent"
            >
            Strict mode
          </label>

          <label class="mt-3 block text-xs font-medium text-pg-text-secondary">
            Metadata JSON
            <textarea
              v-model="newMetadata"
              rows="4"
              placeholder='{"build":"2026.03.31"}'
              class="pg-input mt-1 w-full"
            />
          </label>

          <button
            type="submit"
            class="mt-4 rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="benchmarkStore.isSubmitting || !newSuiteId.trim() || !newTargetId.trim()"
          >
            {{ benchmarkStore.isSubmitting ? 'Queueing...' : 'Queue benchmark' }}
          </button>
        </form>

        <div class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
                Baselines
              </div>
              <p class="text-sm text-pg-text-secondary">
                The latest baseline entries available from the server.
              </p>
            </div>
            <div class="text-xs text-pg-text-muted">
              {{ benchmarkStore.baselineCount }}
            </div>
          </div>

          <div
            v-if="benchmarkStore.isLoadingBaselines && benchmarkStore.baselines.length === 0"
            class="mt-4 rounded-pg border border-dashed border-pg-border bg-pg-surface px-4 py-5 text-sm text-pg-text-muted"
          >
            Loading baselines...
          </div>

          <div
            v-else-if="benchmarkStore.baselines.length === 0"
            class="mt-4 rounded-pg border border-dashed border-pg-border bg-pg-surface px-4 py-5 text-sm text-pg-text-muted"
          >
            No baselines yet.
          </div>

          <div
            v-else
            class="mt-4 space-y-3"
          >
            <article
              v-for="baseline in benchmarkStore.baselines"
              :key="`${baseline.suiteId}:${baseline.targetId}`"
              class="rounded-pg border border-pg-border bg-pg-surface p-3 text-sm"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <div class="font-medium text-pg-text">
                    {{ baseline.suiteId }}
                  </div>
                  <div class="text-xs text-pg-text-muted">
                    Target {{ baseline.targetId }}
                  </div>
                </div>
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="scoreClass(baseline.result.passedBaseline)">
                  {{ baseline.result.passedBaseline ? 'Passed' : 'Regressed' }}
                </span>
              </div>
              <div class="mt-2 text-xs text-pg-text-secondary">
                Run {{ baseline.runId.slice(0, 8) }} · Updated {{ formatDate(baseline.updatedAt) }}
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
