<script setup lang="ts">
/**
 * A2ATasksView -- list A2A tasks with state badges and navigation.
 *
 * Uses SSE (via useA2AEventStream) to receive real-time task state updates
 * instead of polling with setInterval.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useA2AEventStream } from '../composables/useA2AEventStream.js'
import type { A2ATask, A2ATaskListResponse, A2ATaskState } from '../types.js'

const router = useRouter()
const { get } = useApi()

const tasks = ref<A2ATask[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

/** SSE connection for real-time task list updates. */
const { isConnected: sseConnected, sseError, open: openSse } = useA2AEventStream({
  onTaskEvent: () => {
    void fetchTasks()
  },
})

function stateClass(state: A2ATaskState): string {
  switch (state) {
    case 'submitted': return 'bg-blue-500/15 text-blue-400'
    case 'working': return 'bg-pg-warning/15 text-pg-warning'
    case 'completed': return 'bg-pg-success/15 text-pg-success'
    case 'failed': return 'bg-pg-error/15 text-pg-error'
    case 'cancelled': return 'bg-pg-text-muted/15 text-pg-text-muted'
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

async function fetchTasks(): Promise<void> {
  isLoading.value = true
  error.value = null
  try {
    const response = await get<A2ATaskListResponse>('/api/a2a/tasks')
    tasks.value = response.data
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to fetch tasks'
  } finally {
    isLoading.value = false
  }
}

async function openTask(id: string): Promise<void> {
  await router.push({ name: 'A2ATaskDetail', params: { id } })
}

onMounted(() => {
  void fetchTasks()
  openSse()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex flex-col gap-4 border-b border-pg-border pg-surface-glass px-6 py-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          A2A Tasks
        </h1>
        <p class="text-xs text-pg-text-muted">
          View and manage Agent-to-Agent protocol tasks.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-xs text-pg-text-secondary">
        <span
          v-if="sseConnected"
          class="flex items-center gap-1 text-pg-success"
          data-testid="sse-status-connected"
        >
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-pg-success" />
          Live
        </span>
        <span
          v-else-if="sseError"
          class="flex items-center gap-1 text-pg-warning"
          data-testid="sse-status-error"
        >
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-pg-warning" />
          Offline
        </span>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          :disabled="isLoading"
          @click="fetchTasks"
        >
          Refresh
        </button>
      </div>
    </header>

    <div
      v-if="error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ error }}
      <button
        class="ml-2 underline"
        @click="error = null"
      >
        Dismiss
      </button>
    </div>

    <div
      v-if="isLoading"
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Loading tasks...
    </div>

    <div
      v-else-if="tasks.length === 0"
      class="flex flex-1 items-center justify-center"
    >
      <div class="text-center">
        <p class="text-sm text-pg-text-secondary">
          No tasks
        </p>
        <p class="mt-1 text-xs text-pg-text-muted">
          A2A tasks will appear here when agents communicate.
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
              <th class="px-4 py-3">ID</th>
              <th class="px-4 py-3">Agent</th>
              <th class="px-4 py-3">State</th>
              <th class="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-pg-border">
            <tr
              v-for="task in tasks"
              :key="task.id"
              class="cursor-pointer transition-colors hover:bg-pg-surface-raised"
              @click="openTask(task.id)"
            >
              <td class="px-4 py-3 font-mono text-xs text-pg-text-secondary">
                {{ task.id.slice(0, 8) }}
              </td>
              <td class="px-4 py-3 font-medium text-pg-text">
                {{ task.agentName }}
              </td>
              <td class="px-4 py-3">
                <span
                  class="rounded-full px-2.5 py-1 text-xs font-medium"
                  :class="stateClass(task.state)"
                  :data-state="task.state"
                >
                  {{ task.state }}
                </span>
              </td>
              <td class="px-4 py-3 text-pg-text-secondary">
                {{ formatDate(task.createdAt) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
