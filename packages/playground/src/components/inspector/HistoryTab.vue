<script setup lang="ts">
/**
 * HistoryTab -- Run list with timestamps and status.
 *
 * Displays recent agent runs fetched from the server API.
 */
import { ref, onMounted } from 'vue'
import type { RunHistoryEntry, ApiResponse } from '../../types.js'
import { useApi } from '../../composables/useApi.js'

const { get } = useApi()

const runs = ref<RunHistoryEntry[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

async function fetchRuns(): Promise<void> {
  isLoading.value = true
  error.value = null
  try {
    const result = await get<ApiResponse<RunHistoryEntry[]>>('/api/runs?limit=50')
    runs.value = result.data.map((run) => ({
      ...run,
      durationMs: run.completedAt
        ? Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime())
        : undefined,
    }))
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Failed to fetch runs'
  } finally {
    isLoading.value = false
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '--'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'var(--pg-success)'
    case 'failed': return 'var(--pg-error)'
    case 'running': return 'var(--pg-accent)'
    case 'pending': return 'var(--pg-warning)'
    default: return 'var(--pg-text-muted)'
  }
}

onMounted(() => {
  void fetchRuns()
})
</script>

<template>
  <div class="pg-scrollbar flex flex-col overflow-y-auto">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-[var(--pg-border)] px-4 py-2">
      <span class="text-xs font-medium text-[var(--pg-text-muted)]">Recent Runs</span>
      <button
        class="text-xs text-[var(--pg-accent)] hover:underline"
        :disabled="isLoading"
        @click="fetchRuns"
      >
        Refresh
      </button>
    </div>

    <!-- Loading -->
    <div
      v-if="isLoading"
      class="flex items-center justify-center py-8"
    >
      <span class="text-xs text-[var(--pg-text-muted)]">Loading...</span>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="px-4 py-2 text-xs text-[var(--pg-error)]"
      role="alert"
    >
      {{ error }}
    </div>

    <!-- Empty state -->
    <div
      v-if="!isLoading && runs.length === 0 && !error"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-[var(--pg-text-muted)]">
        No runs found.
      </p>
    </div>

    <!-- Run list -->
    <div
      v-for="run in runs"
      :key="run.id"
      class="flex items-center gap-3 border-b border-[var(--pg-border-subtle)] px-4 py-3 transition-colors hover:bg-[var(--pg-surface-raised)]"
    >
      <!-- Status dot -->
      <span
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        :style="{ backgroundColor: statusColor(run.status) }"
      />

      <!-- Run info -->
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-xs text-[var(--pg-text)]">
          {{ run.id }}
        </div>
        <div class="text-[10px] text-[var(--pg-text-muted)]">
          {{ formatTimestamp(run.startedAt) }}
        </div>
      </div>

      <!-- Duration -->
      <span class="shrink-0 font-mono text-xs text-[var(--pg-text-muted)]">
        {{ formatDuration(run.durationMs) }}
      </span>
    </div>
  </div>
</template>
