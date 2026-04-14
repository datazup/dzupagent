<script setup lang="ts">
/**
 * EvalRunDetailView -- inspect a single eval run and control retry/cancel.
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEvalStore } from '../stores/eval-store.js'
import type { EvalRunStatus } from '../types.js'

const route = useRoute()
const router = useRouter()
const evalStore = useEvalStore()

const runId = computed(() => String(route.params.id ?? ''))
const run = computed(() => evalStore.selectedRun)
const attemptHistory = computed(() => run.value?.attemptHistory ?? [])

function formatDate(value?: string): string {
  if (!value) return '--'
  return new Date(value).toLocaleString()
}

function statusClass(status: EvalRunStatus): string {
  switch (status) {
    case 'queued': return 'bg-pg-warning/15 text-pg-warning'
    case 'running': return 'bg-pg-accent/15 text-pg-accent'
    case 'completed': return 'bg-pg-success/15 text-pg-success'
    case 'failed': return 'bg-pg-error/15 text-pg-error'
    case 'cancelled': return 'bg-pg-text-muted/15 text-pg-text-muted'
  }
}

function isActive(runStatus?: EvalRunStatus | null): boolean {
  return runStatus === 'queued' || runStatus === 'running'
}

function recoveryLabel(previousStatus?: string): string {
  if (!previousStatus) return 'Recovered'
  return `Recovered from ${previousStatus}`
}

async function loadRun(): Promise<void> {
  if (!runId.value) return
  await Promise.all([
    evalStore.fetchHealth(),
    evalStore.fetchRun(runId.value),
  ])
}

async function handleCancel(): Promise<void> {
  if (!run.value) return
  const updated = await evalStore.cancelRun(run.value.id)
  if (updated) {
    await evalStore.fetchRun(run.value.id)
  }
}

async function handleRetry(): Promise<void> {
  if (!run.value) return
  const updated = await evalStore.retryRun(run.value.id)
  if (updated) {
    await evalStore.fetchRun(run.value.id)
  }
}

async function handleRefresh(): Promise<void> {
  await loadRun()
}

async function handleBack(): Promise<void> {
  await router.push({ name: 'evals' })
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
          Eval run
        </p>
        <h1 class="text-base font-semibold text-pg-text">
          {{ run?.suiteId ?? runId }}
        </h1>
        <p class="text-xs text-pg-text-muted">
          Inspect lifecycle state, result payloads, and retry/cancel controls.
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="handleBack"
        >
          Back to evals
        </button>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="handleRefresh"
        >
          Refresh
        </button>
      </div>
    </header>

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

    <div
      v-if="evalStore.isLoadingDetail && !run"
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Loading eval run...
    </div>

    <div
      v-else-if="run"
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div class="grid gap-6 xl:grid-cols-[1fr_360px]">
        <section class="space-y-4 rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
          <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div class="flex items-center gap-3">
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(run.status)">
                  {{ run.status }}
                </span>
                <span class="font-mono text-xs text-pg-text-muted">{{ run.id }}</span>
              </div>
              <p class="mt-2 text-sm text-pg-text-secondary">
                {{ run.suite.description ?? run.suite.name }}
              </p>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                v-if="isActive(run.status)"
                class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="evalStore.activeActionRunId === run.id"
                @click="handleCancel"
              >
                {{ evalStore.activeActionRunId === run.id ? 'Cancelling...' : 'Cancel' }}
              </button>
              <button
                v-if="run.status === 'failed'"
                class="rounded-pg-sm bg-pg-accent px-3 py-1.5 text-xs font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="evalStore.activeActionRunId === run.id"
                @click="handleRetry"
              >
                {{ evalStore.activeActionRunId === run.id ? 'Retrying...' : 'Retry' }}
              </button>
            </div>
          </div>

          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Suite</div>
              <div class="mt-1 text-sm text-pg-text">{{ run.suiteId }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Attempts</div>
              <div class="mt-1 text-sm text-pg-text">{{ run.attempts }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Created</div>
              <div class="mt-1 text-sm text-pg-text">{{ formatDate(run.createdAt) }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Queued</div>
              <div class="mt-1 text-sm text-pg-text">{{ formatDate(run.queuedAt) }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Started</div>
              <div class="mt-1 text-sm text-pg-text">{{ formatDate(run.startedAt) }}</div>
            </div>
            <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Completed</div>
              <div class="mt-1 text-sm text-pg-text">{{ formatDate(run.completedAt) }}</div>
            </div>
          </div>

          <div v-if="run.metadata && Object.keys(run.metadata).length > 0" class="rounded-pg border border-pg-border bg-pg-surface-raised p-4">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Metadata
            </div>
            <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(run.metadata, null, 2) }}</pre>
          </div>

          <div v-if="run.result" class="rounded-pg border border-pg-border bg-pg-surface-raised p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">Result</div>
                <p class="text-sm text-pg-text-secondary">
                  Aggregate score {{ run.result.aggregateScore.toFixed(2) }}, pass rate {{ (run.result.passRate * 100).toFixed(0) }}%
                </p>
              </div>
              <div class="text-right text-xs text-pg-text-muted">
                {{ run.result.results.length }} cases
              </div>
            </div>

            <div class="mt-4 overflow-hidden rounded-pg border border-pg-border">
              <table class="min-w-full divide-y divide-pg-border text-left text-sm">
                <thead class="bg-pg-surface text-xs uppercase tracking-wide text-pg-text-muted">
                  <tr>
                    <th class="px-3 py-2">Case</th>
                    <th class="px-3 py-2">Score</th>
                    <th class="px-3 py-2">Pass</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-pg-border">
                  <tr v-for="caseResult in run.result.results" :key="caseResult.caseId">
                    <td class="px-3 py-2 font-mono text-xs text-pg-text-secondary">{{ caseResult.caseId }}</td>
                    <td class="px-3 py-2 text-pg-text">{{ caseResult.aggregateScore.toFixed(2) }}</td>
                    <td class="px-3 py-2 text-pg-text">{{ caseResult.pass ? 'Pass' : 'Fail' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="attemptHistory.length > 0" class="rounded-pg border border-pg-border bg-pg-surface-raised p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
                  Attempt history
                </div>
                <p class="text-sm text-pg-text-secondary">
                  Execution lifecycle for each attempt.
                </p>
              </div>
              <div class="text-xs text-pg-text-muted">
                {{ attemptHistory.length }} attempt{{ attemptHistory.length === 1 ? '' : 's' }}
              </div>
            </div>

            <div class="mt-4 space-y-3">
              <article
                v-for="attempt in attemptHistory"
                :key="attempt.attempt"
                class="rounded-pg border border-pg-border bg-pg-surface p-3"
              >
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(attempt.status)">
                      {{ attempt.status }}
                    </span>
                    <span class="font-mono text-xs text-pg-text-muted">
                      Attempt {{ attempt.attempt }}
                    </span>
                    <span
                      v-if="attempt.recovery"
                      class="rounded-full border border-pg-border bg-pg-surface-raised px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-pg-text-secondary"
                    >
                      Recovered
                    </span>
                  </div>
                  <div class="text-xs text-pg-text-muted">
                    Queue wait {{ formatDate(attempt.queuedAt) }}
                  </div>
                </div>

                <div class="mt-3 grid gap-2 md:grid-cols-3">
                  <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-2.5 text-xs text-pg-text-secondary">
                    <div class="uppercase tracking-wide text-pg-text-muted">Queued</div>
                    <div class="mt-1 text-pg-text">{{ formatDate(attempt.queuedAt) }}</div>
                  </div>
                  <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-2.5 text-xs text-pg-text-secondary">
                    <div class="uppercase tracking-wide text-pg-text-muted">Started</div>
                    <div class="mt-1 text-pg-text">{{ formatDate(attempt.startedAt) }}</div>
                  </div>
                  <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-2.5 text-xs text-pg-text-secondary">
                    <div class="uppercase tracking-wide text-pg-text-muted">Completed</div>
                    <div class="mt-1 text-pg-text">{{ formatDate(attempt.completedAt) }}</div>
                  </div>
                </div>

                <div
                  v-if="attempt.recovery"
                  class="mt-3 rounded-pg border border-pg-border bg-pg-surface-raised p-3 text-xs text-pg-text-secondary"
                >
                  <div class="text-[11px] font-semibold uppercase tracking-wide text-pg-text-muted">
                    Recovery
                  </div>
                  <div class="mt-1">
                    {{ recoveryLabel(attempt.recovery.previousStatus) }} at {{ formatDate(attempt.recovery.recoveredAt) }}.
                  </div>
                  <div v-if="attempt.recovery.previousStartedAt" class="mt-1 text-pg-text-muted">
                    Previous start: {{ formatDate(attempt.recovery.previousStartedAt) }}
                  </div>
                </div>

                <div
                  v-if="attempt.error"
                  class="mt-3 rounded-pg border border-pg-error bg-pg-error/10 p-3"
                >
                  <div class="text-[11px] font-semibold uppercase tracking-wide text-pg-error">
                    Error
                  </div>
                  <pre class="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-pg-error">{{ JSON.stringify(attempt.error, null, 2) }}</pre>
                </div>
              </article>
            </div>
          </div>

          <div v-if="run.error" class="rounded-pg border border-pg-error bg-pg-error/10 p-4">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-error">
              Error
            </div>
            <pre class="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-pg-error">{{ JSON.stringify(run.error, null, 2) }}</pre>
          </div>
        </section>

        <aside class="space-y-4">
          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Eval health
            </div>
            <div class="mt-3 space-y-2 text-sm text-pg-text-secondary">
              <div class="flex items-center justify-between gap-3">
                <span>Mode</span>
                <span>{{ evalStore.mode }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span>Writable</span>
                <span>{{ evalStore.writable ? 'Yes' : 'No' }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span>Endpoints</span>
                <span>{{ evalStore.endpoints.length }}</span>
              </div>
            </div>
          </div>

          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Lifecycle
            </div>
            <ul class="mt-3 space-y-2 text-sm text-pg-text-secondary">
              <li>Queued at {{ formatDate(run.queuedAt) }}</li>
              <li>Started at {{ formatDate(run.startedAt) }}</li>
              <li>Completed at {{ formatDate(run.completedAt) }}</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>

    <div
      v-else
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Eval run not found.
    </div>
  </div>
</template>
