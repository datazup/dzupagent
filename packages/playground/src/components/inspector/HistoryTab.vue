<script setup lang="ts">
/**
 * HistoryTab -- Enhanced run list with status filters, richer cards,
 * and click-through to RunDetailView.
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useRunStore } from '../../stores/run-store.js'
import type { RunStatus } from '../../types.js'

const router = useRouter()
const runStore = useRunStore()

const statusOptions: Array<{ value: RunStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'running', label: 'Running' },
  { value: 'pending', label: 'Pending' },
  { value: 'awaiting_approval', label: 'Approval' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-pg-success/15 text-pg-success'
    case 'failed': return 'bg-pg-error/15 text-pg-error'
    case 'running': return 'bg-pg-accent/15 text-pg-accent'
    case 'pending': return 'bg-pg-warning/15 text-pg-warning'
    case 'awaiting_approval': return 'bg-pg-info/15 text-pg-info'
    case 'cancelled': return 'bg-pg-text-muted/15 text-pg-text-muted'
    case 'rejected': return 'bg-pg-error/10 text-pg-error'
    default: return 'bg-pg-surface-raised text-pg-text-muted'
  }
}

function formatTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '--'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function handleFilterChange(status: RunStatus | 'all'): void {
  runStore.setStatusFilter(status)
}

function openRun(id: string): void {
  void router.push(`/runs/${id}`)
}

onMounted(() => {
  void runStore.fetchRuns()
})
</script>

<template>
  <div class="pg-scrollbar flex flex-col overflow-y-auto">
    <!-- Header with filters -->
    <div class="flex flex-col gap-2 border-b border-pg-border px-4 py-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-pg-text-muted">
          Runs ({{ runStore.totalCount }})
        </span>
        <button
          class="text-xs text-pg-accent hover:underline"
          :disabled="runStore.isLoading"
          @click="runStore.fetchRuns()"
        >
          Refresh
        </button>
      </div>
      <!-- Status filter pills -->
      <div class="flex flex-wrap gap-1">
        <button
          v-for="opt in statusOptions"
          :key="opt.value"
          class="rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors"
          :class="runStore.statusFilter === opt.value
            ? 'bg-pg-accent/15 text-pg-accent'
            : 'text-pg-text-muted hover:text-pg-text-secondary'"
          @click="handleFilterChange(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div
      v-if="runStore.isLoading"
      class="flex items-center justify-center py-8"
    >
      <span class="text-xs text-pg-text-muted">Loading...</span>
    </div>

    <!-- Error -->
    <div
      v-if="runStore.error"
      class="px-4 py-2 text-xs text-pg-error"
      role="alert"
    >
      {{ runStore.error }}
    </div>

    <!-- Empty state -->
    <div
      v-if="!runStore.isLoading && runStore.filteredRuns.length === 0 && !runStore.error"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-pg-text-muted">
        No runs found.
      </p>
    </div>

    <!-- Run list -->
    <button
      v-for="run in runStore.filteredRuns"
      :key="run.id"
      class="flex items-center gap-3 border-b border-pg-border-subtle px-4 py-3 text-left transition-colors hover:bg-pg-surface-raised"
      @click="openRun(run.id)"
    >
      <!-- Status badge -->
      <span
        class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
        :class="statusBadgeClass(run.status)"
      >
        {{ run.status }}
      </span>

      <!-- Run info -->
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-xs text-pg-text">
          {{ run.id }}
        </div>
        <div class="flex gap-3 text-[10px] text-pg-text-muted">
          <span>{{ formatTimestamp(run.startedAt) }}</span>
          <span class="font-mono">{{ run.agentId }}</span>
        </div>
      </div>

      <!-- Duration -->
      <span class="shrink-0 font-mono text-xs text-pg-text-muted">
        {{ formatDuration(run.durationMs) }}
      </span>

      <!-- Arrow -->
      <span class="shrink-0 text-pg-text-muted">&rsaquo;</span>
    </button>
  </div>
</template>
