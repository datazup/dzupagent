<script setup lang="ts">
/**
 * RunDetailView -- Full run detail with logs, trace timeline,
 * token usage, and approval/cancel actions.
 */
import { onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRunStore } from '../stores/run-store.js'
import type { TraceEvent } from '../types.js'

const route = useRoute()
const router = useRouter()
const runStore = useRunStore()

const runId = computed(() => route.params.id as string)

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'bg-pg-success text-white'
    case 'failed': return 'bg-pg-error text-white'
    case 'running': return 'bg-pg-accent text-pg-accent-text'
    case 'pending': return 'bg-pg-warning text-pg-bg'
    case 'awaiting_approval': return 'bg-pg-info text-white'
    case 'cancelled': return 'bg-pg-text-muted text-pg-bg'
    case 'rejected': return 'bg-pg-error/70 text-white'
    default: return 'bg-pg-surface-raised text-pg-text-muted'
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '--'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatTimestamp(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function traceTypeFromPhase(phase?: string): TraceEvent['type'] {
  if (!phase) return 'system'
  const n = phase.toLowerCase()
  if (n.includes('tool')) return 'tool'
  if (n.includes('memory')) return 'memory'
  if (n.includes('guard')) return 'guardrail'
  if (n.includes('llm') || n.includes('model')) return 'llm'
  return 'system'
}

function eventColor(type: TraceEvent['type']): string {
  switch (type) {
    case 'llm': return 'bg-pg-accent'
    case 'tool': return 'bg-pg-success'
    case 'memory': return 'bg-pg-info'
    case 'guardrail': return 'bg-pg-warning'
    default: return 'bg-pg-text-muted'
  }
}

function logLevelClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'error': return 'text-pg-error'
    case 'warn': case 'warning': return 'text-pg-warning'
    case 'info': return 'text-pg-info'
    default: return 'text-pg-text-secondary'
  }
}

async function handleApprove(): Promise<void> {
  await runStore.approveRun(runId.value)
}

async function handleReject(): Promise<void> {
  await runStore.rejectRun(runId.value, 'Rejected from playground')
}

async function handleCancel(): Promise<void> {
  await runStore.cancelRun(runId.value)
}

onMounted(() => {
  void runStore.loadRunDetail(runId.value)
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-pg-border pg-surface-glass px-6 py-4">
      <div class="flex items-center gap-3">
        <button
          class="rounded-pg-sm border border-pg-border px-2.5 py-1.5 text-xs text-pg-text-secondary hover:bg-pg-surface-raised"
          @click="router.back()"
        >
          Back
        </button>
        <div>
          <h1 class="text-sm font-semibold text-pg-text">
            Run Detail
          </h1>
          <p class="font-mono text-xs text-pg-text-muted">
            {{ runId }}
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center gap-2">
        <button
          v-if="runStore.isAwaitingApproval"
          class="rounded-pg bg-pg-success px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-90"
          @click="handleApprove"
        >
          Approve
        </button>
        <button
          v-if="runStore.isAwaitingApproval"
          class="rounded-pg border border-pg-error px-4 py-2 text-sm font-medium text-pg-error hover:bg-pg-error/10"
          @click="handleReject"
        >
          Reject
        </button>
        <button
          v-if="runStore.isCancellable"
          class="rounded-pg border border-pg-border px-4 py-2 text-sm text-pg-text-secondary hover:border-pg-error hover:text-pg-error"
          @click="handleCancel"
        >
          Cancel Run
        </button>
      </div>
    </header>

    <!-- Loading -->
    <div
      v-if="runStore.isLoadingDetail"
      class="flex flex-1 items-center justify-center"
    >
      <span class="text-sm text-pg-text-muted">Loading run details...</span>
    </div>

    <!-- Error -->
    <div
      v-if="runStore.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ runStore.error }}
    </div>

    <!-- Content -->
    <div
      v-if="runStore.selectedRun && !runStore.isLoadingDetail"
      class="pg-scrollbar flex-1 overflow-y-auto"
    >
      <!-- Summary cards -->
      <div class="grid grid-cols-2 gap-4 border-b border-pg-border p-6 md:grid-cols-4">
        <!-- Status -->
        <div>
          <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-pg-text-muted">
            Status
          </p>
          <span
            class="inline-block rounded-full px-3 py-1 text-xs font-semibold"
            :class="statusColor(runStore.selectedRun.status)"
          >
            {{ runStore.selectedRun.status }}
          </span>
        </div>
        <!-- Duration -->
        <div>
          <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-pg-text-muted">
            Duration
          </p>
          <p class="text-sm font-medium text-pg-text">
            {{ formatDuration(runStore.selectedRun.durationMs) }}
          </p>
        </div>
        <!-- Tokens -->
        <div>
          <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-pg-text-muted">
            Tokens
          </p>
          <p class="text-sm font-medium text-pg-text">
            {{ runStore.traceUsage?.totalTokens?.toLocaleString() ?? '--' }}
          </p>
          <p
            v-if="runStore.traceUsage"
            class="text-[10px] text-pg-text-muted"
          >
            {{ runStore.traceUsage.promptTokens?.toLocaleString() }} prompt / {{ runStore.traceUsage.completionTokens?.toLocaleString() }} completion
          </p>
        </div>
        <!-- Cost -->
        <div>
          <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-pg-text-muted">
            Est. Cost
          </p>
          <p class="text-sm font-medium text-pg-text">
            {{ runStore.traceUsage?.estimatedCost != null ? `$${runStore.traceUsage.estimatedCost.toFixed(4)}` : '--' }}
          </p>
        </div>
      </div>

      <!-- Timestamps -->
      <div class="border-b border-pg-border px-6 py-3">
        <div class="flex flex-wrap gap-6 text-xs text-pg-text-secondary">
          <span>Started: {{ formatTimestamp(runStore.selectedRun.startedAt) }}</span>
          <span v-if="runStore.selectedRun.completedAt">
            Completed: {{ formatTimestamp(runStore.selectedRun.completedAt) }}
          </span>
          <span>Agent: <code class="font-mono text-pg-accent">{{ runStore.selectedRun.agentId }}</code></span>
        </div>
      </div>

      <!-- Error output -->
      <div
        v-if="runStore.selectedRun.error"
        class="border-b border-pg-error/30 bg-pg-error/5 px-6 py-3"
      >
        <p class="mb-1 text-[10px] font-medium uppercase text-pg-error">
          Error
        </p>
        <pre class="whitespace-pre-wrap break-words font-mono text-xs text-pg-error">{{ runStore.selectedRun.error }}</pre>
      </div>

      <!-- Two-column: Trace + Logs -->
      <div class="grid grid-cols-1 xl:grid-cols-2">
        <!-- Trace timeline -->
        <div class="border-b border-pg-border p-6 xl:border-r xl:border-b-0">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-pg-text-muted">
            Trace Timeline
            <span
              v-if="runStore.runTrace?.events.length"
              class="ml-1 font-normal"
            >({{ runStore.runTrace.events.length }})</span>
          </h2>

          <div
            v-if="!runStore.runTrace?.events.length"
            class="py-8 text-center text-xs text-pg-text-muted"
          >
            No trace events
          </div>

          <div class="flex flex-col gap-1">
            <div
              v-for="(event, i) in runStore.runTrace?.events ?? []"
              :key="i"
              class="flex items-center gap-3 rounded-pg-sm px-2 py-1.5 text-xs hover:bg-pg-surface-raised"
            >
              <span
                class="inline-block w-16 shrink-0 rounded-sm px-1.5 py-0.5 text-center font-mono text-[10px] font-medium text-pg-bg"
                :class="eventColor(traceTypeFromPhase(event.phase))"
              >
                {{ traceTypeFromPhase(event.phase) }}
              </span>
              <span class="min-w-0 flex-1 truncate text-pg-text">{{ event.message || event.phase }}</span>
              <span class="w-16 shrink-0 text-right font-mono text-pg-text-muted">
                {{ formatDuration(event.durationMs) }}
              </span>
            </div>
          </div>

          <!-- Tool calls -->
          <div v-if="runStore.runTrace?.toolCalls?.length">
            <h3 class="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-pg-text-muted">
              Tool Calls ({{ runStore.runTrace.toolCalls.length }})
            </h3>
            <div
              v-for="(tc, i) in runStore.runTrace.toolCalls"
              :key="i"
              class="mb-2 rounded-pg-sm border border-pg-border-subtle bg-pg-surface-raised p-3"
            >
              <div class="mb-1 flex items-center justify-between">
                <span class="text-xs font-medium text-pg-success">{{ tc.name }}</span>
                <span class="font-mono text-[10px] text-pg-text-muted">{{ formatDuration(tc.durationMs) }}</span>
              </div>
              <pre
                v-if="tc.input"
                class="mb-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-pg-text-secondary"
              >{{ typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2) }}</pre>
            </div>
          </div>
        </div>

        <!-- Logs -->
        <div class="p-6">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-pg-text-muted">
            Logs
            <span
              v-if="runStore.runLogs.length"
              class="ml-1 font-normal"
            >({{ runStore.runLogs.length }})</span>
          </h2>

          <div
            v-if="runStore.runLogs.length === 0"
            class="py-8 text-center text-xs text-pg-text-muted"
          >
            No logs available
          </div>

          <div class="flex flex-col gap-0.5">
            <div
              v-for="(log, i) in runStore.runLogs"
              :key="i"
              class="flex gap-2 font-mono text-[11px]"
            >
              <span class="w-18 shrink-0 text-pg-text-muted">
                {{ log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '' }}
              </span>
              <span
                class="w-12 shrink-0 text-right font-semibold uppercase"
                :class="logLevelClass(log.level)"
              >
                {{ log.level }}
              </span>
              <span class="min-w-0 flex-1 break-words text-pg-text-secondary">{{ log.message }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Output -->
      <div
        v-if="runStore.selectedRun.output"
        class="border-t border-pg-border p-6"
      >
        <h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-pg-text-muted">
          Output
        </h2>
        <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-4 font-mono text-xs text-pg-text-secondary">{{ typeof runStore.selectedRun.output === 'string' ? runStore.selectedRun.output : JSON.stringify(runStore.selectedRun.output, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>
