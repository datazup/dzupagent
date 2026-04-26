<script setup lang="ts">
/**
 * RunHistoryBrowser -- paginated run history table with status filtering.
 *
 * Fetches GET /api/runs with pagination (limit/offset query params).
 * Displays run ID, agent name, status badge, started_at, and duration.
 * Click row to navigate to the run detail view.
 */
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useRunStore } from '../stores/run-store.js'
import PgBadge from '../components/ui/PgBadge.vue'
import PgButton from '../components/ui/PgButton.vue'
import type { RunStatus } from '../types.js'

const router = useRouter()
const runStore = useRunStore()

const page = ref(1)
const limit = ref(25)
const expandedRunId = ref<string | null>(null)

const statusOptions: Array<{ label: string; value: RunStatus | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
]

const offset = computed(() => (page.value - 1) * limit.value)
const totalPages = computed(() => Math.max(1, Math.ceil(runStore.totalCount / limit.value)))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < totalPages.value)

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '--'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id
}

async function loadRuns(): Promise<void> {
  const status = runStore.statusFilter === 'all' ? undefined : runStore.statusFilter
  await runStore.fetchRuns({
    status,
    limit: limit.value,
    offset: offset.value,
  })
}

async function handleStatusFilter(status: RunStatus | 'all'): Promise<void> {
  runStore.setStatusFilter(status)
  page.value = 1
  await loadRuns()
}

async function goToPage(p: number): Promise<void> {
  page.value = p
  await loadRuns()
}

function toggleExpand(runId: string): void {
  expandedRunId.value = expandedRunId.value === runId ? null : runId
}

async function openRunDetail(runId: string): Promise<void> {
  await router.push({ name: 'run-detail', params: { id: runId } })
}

watch([page, limit], () => {
  void loadRuns()
})

onMounted(() => {
  void loadRuns()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-pg-border pg-surface-glass px-6 py-4">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          Run History
        </h1>
        <p class="text-xs text-pg-text-muted">
          {{ runStore.totalCount }} total runs
        </p>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex rounded-pg border border-pg-border bg-pg-surface">
          <button
            v-for="option in statusOptions"
            :key="option.value"
            class="px-3 py-1.5 text-xs font-medium capitalize transition-colors"
            :class="runStore.statusFilter === option.value
              ? 'bg-pg-accent/10 text-pg-text'
              : 'text-pg-text-muted hover:text-pg-text-secondary'"
            @click="handleStatusFilter(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </header>

    <!-- Error -->
    <div
      v-if="runStore.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ runStore.error }}
      <button
        class="ml-2 underline"
        @click="runStore.clearError()"
      >
        Dismiss
      </button>
    </div>

    <!-- Loading -->
    <div
      v-if="runStore.isLoading"
      class="flex flex-1 items-center justify-center"
    >
      <span class="text-sm text-pg-text-muted">Loading runs...</span>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="runStore.filteredRuns.length === 0"
      class="flex flex-1 items-center justify-center"
    >
      <div class="text-center">
        <p class="text-sm text-pg-text-secondary">
          No runs found
        </p>
        <p class="mt-1 text-xs text-pg-text-muted">
          Agent runs will appear here once started.
        </p>
      </div>
    </div>

    <!-- Runs table -->
    <div
      v-else
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div class="overflow-hidden rounded-pg-lg border border-pg-border bg-pg-surface shadow-sm">
        <table class="min-w-full divide-y divide-pg-border text-left text-sm">
          <thead class="bg-pg-surface-raised text-xs uppercase tracking-wide text-pg-text-muted">
            <tr>
              <th class="px-4 py-3">
                Run ID
              </th>
              <th class="px-4 py-3">
                Agent
              </th>
              <th class="px-4 py-3">
                Status
              </th>
              <th class="px-4 py-3">
                Started
              </th>
              <th class="px-4 py-3">
                Duration
              </th>
              <th class="px-4 py-3">
                Actions
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-pg-border">
            <template
              v-for="run in runStore.filteredRuns"
              :key="run.id"
            >
              <tr
                class="cursor-pointer transition-colors hover:bg-pg-surface-raised"
                @click="toggleExpand(run.id)"
              >
                <td class="px-4 py-3 font-mono text-xs text-pg-text-secondary">
                  {{ truncateId(run.id) }}
                </td>
                <td class="px-4 py-3 text-sm text-pg-text">
                  {{ run.agentId }}
                </td>
                <td class="px-4 py-3">
                  <PgBadge :status="run.status">
                    {{ run.status }}
                  </PgBadge>
                </td>
                <td class="px-4 py-3 text-xs text-pg-text-secondary">
                  {{ formatTimestamp(run.startedAt) }}
                </td>
                <td class="px-4 py-3 font-mono text-xs text-pg-text-secondary">
                  {{ formatDuration(run.durationMs) }}
                </td>
                <td class="px-4 py-3">
                  <PgButton
                    size="sm"
                    @click.stop="openRunDetail(run.id)"
                  >
                    View
                  </PgButton>
                </td>
              </tr>

              <!-- Expanded row -->
              <tr v-if="expandedRunId === run.id">
                <td
                  colspan="6"
                  class="border-t border-pg-border-subtle bg-pg-surface-raised px-6 py-4"
                >
                  <div class="space-y-2">
                    <div class="flex gap-6 text-xs text-pg-text-secondary">
                      <span>Full ID: <code class="font-mono text-pg-accent">{{ run.id }}</code></span>
                      <span>Agent: <code class="font-mono text-pg-accent">{{ run.agentId }}</code></span>
                    </div>
                    <div v-if="run.output">
                      <p class="mb-1 text-[10px] font-medium uppercase text-pg-text-muted">
                        Output
                      </p>
                      <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface p-3 font-mono text-[11px] text-pg-text-secondary">{{ typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2) }}</pre>
                    </div>
                    <div v-if="run.error">
                      <p class="mb-1 text-[10px] font-medium uppercase text-pg-error">
                        Error
                      </p>
                      <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-error/5 p-3 font-mono text-[11px] text-pg-error">{{ run.error }}</pre>
                    </div>
                    <button
                      class="mt-2 rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary hover:bg-pg-surface hover:text-pg-text"
                      @click.stop="openRunDetail(run.id)"
                    >
                      Open Full Detail
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="mt-4 flex items-center justify-between text-xs text-pg-text-secondary">
        <span>
          Page {{ page }} of {{ totalPages }}
          ({{ runStore.filteredRuns.length }} shown)
        </span>
        <div class="flex gap-2">
          <PgButton
            :disabled="!hasPrev"
            @click="goToPage(page - 1)"
          >
            Previous
          </PgButton>
          <PgButton
            :disabled="!hasNext"
            @click="goToPage(page + 1)"
          >
            Next
          </PgButton>
        </div>
      </div>
    </div>
  </div>
</template>
