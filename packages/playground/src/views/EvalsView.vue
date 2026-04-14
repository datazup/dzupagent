<script setup lang="ts">
/**
 * EvalsView -- list and launch eval runs.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useEvalStore } from '../stores/eval-store.js'
import type { EvalRunStatus } from '../types.js'

const router = useRouter()
const evalStore = useEvalStore()
const newSuiteId = ref('')
const newMetadata = ref('')

const statusOptions: Array<{ label: string; value: EvalRunStatus | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Queued', value: 'queued' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
]

const summaryItems = computed(() => [
  { label: 'Queued', value: evalStore.filteredCounts.queued },
  { label: 'Running', value: evalStore.filteredCounts.running },
  { label: 'Completed', value: evalStore.filteredCounts.completed },
  { label: 'Failed', value: evalStore.filteredCounts.failed },
  { label: 'Cancelled', value: evalStore.filteredCounts.cancelled },
])

function statusClass(status: EvalRunStatus): string {
  switch (status) {
    case 'queued': return 'bg-pg-warning/15 text-pg-warning'
    case 'running': return 'bg-pg-accent/15 text-pg-accent'
    case 'completed': return 'bg-pg-success/15 text-pg-success'
    case 'failed': return 'bg-pg-error/15 text-pg-error'
    case 'cancelled': return 'bg-pg-text-muted/15 text-pg-text-muted'
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

async function refresh(): Promise<void> {
  await Promise.all([
    evalStore.fetchHealth(),
    evalStore.fetchRuns(),
  ])
}

async function handleCreateRun(): Promise<void> {
  const suiteId = newSuiteId.value.trim()
  if (!suiteId) return

  let metadata: Record<string, unknown> | undefined
  const rawMetadata = newMetadata.value.trim()
  if (rawMetadata) {
    try {
      metadata = JSON.parse(rawMetadata) as Record<string, unknown>
    } catch {
      evalStore.error = 'Metadata must be valid JSON'
      return
    }
  }

  const created = await evalStore.createRun(suiteId, metadata)
  if (created) {
    newSuiteId.value = ''
    newMetadata.value = ''
    await evalStore.fetchRuns()
    await router.push({ name: 'eval-detail', params: { id: created.id } })
  }
}

async function handleStatusFilter(status: EvalRunStatus | 'all'): Promise<void> {
  evalStore.setStatusFilter(status)
  await evalStore.fetchRuns({ status })
}

async function handleSuiteFilterInput(event: Event): Promise<void> {
  const value = (event.target as HTMLInputElement).value
  evalStore.setSuiteIdFilter(value)
  await evalStore.fetchRuns({ suiteId: value })
}

async function openRun(id: string): Promise<void> {
  await router.push({ name: 'eval-detail', params: { id } })
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
          Evals
        </h1>
        <p class="text-xs text-pg-text-muted">
          Launch suites, review lifecycle status, and retry failed runs.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-xs text-pg-text-secondary">
        <span class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
          {{ evalStore.health?.service ?? 'evals' }}
        </span>
        <span class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
          {{ evalStore.mode }}
        </span>
        <span class="rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
          {{ evalStore.writable ? 'Writable' : 'Read only' }}
        </span>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          :disabled="evalStore.isLoading"
          @click="refresh"
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

    <section class="grid gap-4 border-b border-pg-border bg-pg-surface px-6 py-4 xl:grid-cols-[1fr_360px]">
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
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

        <div
          v-if="evalStore.queueStats"
          class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4 text-sm text-pg-text-secondary"
        >
          <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
            Queue stats
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Pending</div>
              <div class="mt-1 text-lg font-semibold text-pg-text">{{ evalStore.queueStats.pending }}</div>
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Active</div>
              <div class="mt-1 text-lg font-semibold text-pg-text">{{ evalStore.queueStats.active }}</div>
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Completed</div>
              <div class="mt-1 text-lg font-semibold text-pg-text">{{ evalStore.queueStats.completed }}</div>
            </div>
            <div>
              <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Failed</div>
              <div class="mt-1 text-lg font-semibold text-pg-text">{{ evalStore.queueStats.failed }}</div>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            v-for="option in statusOptions"
            :key="option.value"
            class="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
            :class="evalStore.statusFilter === option.value
              ? 'bg-pg-accent/10 text-pg-text'
              : 'border border-pg-border text-pg-text-muted hover:text-pg-text'"
            @click="handleStatusFilter(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <form class="rounded-pg-lg border border-pg-border bg-pg-surface-raised p-4" @submit.prevent="handleCreateRun">
        <div class="text-sm font-semibold text-pg-text">
          Start a run
        </div>
        <p class="mt-1 text-xs text-pg-text-muted">
          Provide a registered suite id. The server queues the run asynchronously.
        </p>
        <label class="mt-4 block text-xs font-medium text-pg-text-secondary">
          Suite ID
          <input
            v-model="newSuiteId"
            type="text"
            placeholder="toy-suite"
            class="pg-input mt-1 w-full"
          >
        </label>
        <label class="mt-3 block text-xs font-medium text-pg-text-secondary">
          Metadata JSON
          <textarea
            v-model="newMetadata"
            rows="4"
            placeholder='{"target":"agent-1"}'
            class="pg-input mt-1 w-full"
          />
        </label>
        <button
          type="submit"
          class="mt-4 rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="evalStore.isSubmitting || !newSuiteId.trim()"
        >
          {{ evalStore.isSubmitting ? 'Queueing...' : 'Queue eval' }}
        </button>
      </form>
    </section>

    <div class="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div class="border-b border-pg-border bg-pg-surface px-6 py-3">
        <label class="flex flex-col gap-1 text-xs font-medium text-pg-text-secondary md:max-w-md">
          Filter by suite id
          <input
            :value="evalStore.suiteIdFilter"
            type="text"
            placeholder="toy-suite"
            class="pg-input"
            @input="handleSuiteFilterInput"
          >
        </label>
      </div>

      <div
        v-if="evalStore.isLoading"
        class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
      >
        Loading eval runs...
      </div>

      <div
        v-else-if="evalStore.runs.length === 0"
        class="flex flex-1 items-center justify-center"
      >
        <div class="text-center">
          <p class="text-sm text-pg-text-secondary">
            No eval runs yet
          </p>
          <p class="mt-1 text-xs text-pg-text-muted">
            Queue a suite to populate the lifecycle dashboard.
          </p>
        </div>
      </div>

      <div
        v-else
        class="pg-scrollbar flex-1 overflow-y-auto p-6"
      >
        <div class="overflow-hidden rounded-pg-lg border border-pg-border bg-pg-surface shadow-sm">
          <table class="min-w-full divide-y divide-pg-border text-left text-sm">
            <thead class="bg-pg-surface-raised text-xs uppercase tracking-wide text-pg-text-muted">
              <tr>
                <th class="px-4 py-3">Run</th>
                <th class="px-4 py-3">Suite</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3">Attempts</th>
                <th class="px-4 py-3">Queued</th>
                <th class="px-4 py-3">Completed</th>
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
                  <div class="font-medium text-pg-text">{{ run.suiteId }}</div>
                  <div class="text-xs text-pg-text-muted">{{ run.suite.description ?? run.suite.name }}</div>
                </td>
                <td class="px-4 py-3">
                  <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(run.status)">
                    {{ run.status }}
                  </span>
                </td>
                <td class="px-4 py-3 text-pg-text-secondary">
                  {{ run.attempts }}
                </td>
                <td class="px-4 py-3 text-pg-text-secondary">
                  {{ formatDate(run.queuedAt) }}
                </td>
                <td class="px-4 py-3 text-pg-text-secondary">
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
