<script setup lang="ts">
/**
 * A2ATaskDetailView -- inspect a single A2A task, view messages, and send new ones.
 *
 * Uses SSE (via useA2AEventStream) to receive real-time task updates
 * instead of polling with setInterval.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '../composables/useApi.js'
import { useA2AEventStream } from '../composables/useA2AEventStream.js'
import type { A2ATask, A2ATaskResponse, A2ATaskState } from '../types.js'

const route = useRoute()
const router = useRouter()
const { get, post } = useApi()

const task = ref<A2ATask | null>(null)
const isLoading = ref(false)
const error = ref<string | null>(null)
const messageText = ref('')
const isSending = ref(false)

const taskId = computed(() => String(route.params.id ?? ''))

/** SSE connection for real-time task detail updates, filtered by taskId. */
const { isConnected: sseConnected, sseError, open: openSse, close: closeSse } = useA2AEventStream({
  onTaskEvent: () => {
    void fetchTask()
  },
  taskId,
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

function formatDate(value?: string): string {
  if (!value) return '--'
  return new Date(value).toLocaleString()
}

function messagePartText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')
}

async function fetchTask(): Promise<void> {
  if (!taskId.value) return
  isLoading.value = true
  error.value = null
  try {
    const response = await get<A2ATaskResponse>(`/api/a2a/tasks/${taskId.value}`)
    task.value = response.data
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to fetch task'
  } finally {
    isLoading.value = false
  }
}

async function sendMessage(): Promise<void> {
  const text = messageText.value.trim()
  if (!text || !taskId.value) return

  isSending.value = true
  error.value = null
  try {
    await post(`/api/a2a/tasks/${taskId.value}/messages`, {
      role: 'user',
      parts: [{ type: 'text', text }],
    })
    messageText.value = ''
    await fetchTask()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to send message'
  } finally {
    isSending.value = false
  }
}

async function handleBack(): Promise<void> {
  await router.push({ name: 'A2ATasks' })
}

onMounted(() => {
  void fetchTask()
  openSse()
})

watch(taskId, () => {
  // Re-open SSE when navigating to a different task.
  closeSse()
  void fetchTask()
  openSse()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex flex-col gap-4 border-b border-pg-border pg-surface-glass px-6 py-4 xl:flex-row xl:items-center xl:justify-between">
      <div>
        <p class="text-xs uppercase tracking-wide text-pg-text-muted">
          A2A Task
        </p>
        <h1 class="text-base font-semibold text-pg-text">
          {{ task?.agentName ?? taskId }}
        </h1>
        <p class="text-xs text-pg-text-muted">
          Inspect task state, messages, and artifacts.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span
          v-if="sseConnected"
          class="flex items-center gap-1 text-xs text-pg-success"
          data-testid="sse-status-connected"
        >
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-pg-success" />
          Live
        </span>
        <span
          v-else-if="sseError"
          class="flex items-center gap-1 text-xs text-pg-warning"
          data-testid="sse-status-error"
        >
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-pg-warning" />
          Offline
        </span>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="handleBack"
        >
          Back to tasks
        </button>
        <button
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          @click="fetchTask"
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
      v-if="isLoading && !task"
      class="flex flex-1 items-center justify-center text-sm text-pg-text-muted"
    >
      Loading task...
    </div>

    <div
      v-else-if="task"
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div class="grid gap-6 xl:grid-cols-[1fr_360px]">
        <!-- Main content -->
        <section class="space-y-4">
          <!-- Task header card -->
          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div class="flex items-center gap-3">
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="stateClass(task.state)">
                  {{ task.state }}
                </span>
                <span class="font-mono text-xs text-pg-text-muted">{{ task.id }}</span>
              </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Agent</div>
                <div class="mt-1 text-sm text-pg-text">{{ task.agentName }}</div>
              </div>
              <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Created</div>
                <div class="mt-1 text-sm text-pg-text">{{ formatDate(task.createdAt) }}</div>
              </div>
              <div class="rounded-pg border border-pg-border bg-pg-surface-raised p-3">
                <div class="text-[11px] uppercase tracking-wide text-pg-text-muted">Updated</div>
                <div class="mt-1 text-sm text-pg-text">{{ formatDate(task.updatedAt) }}</div>
              </div>
            </div>
          </div>

          <!-- Conversation history -->
          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Conversation
            </div>

            <div
              v-if="task.messages.length === 0"
              class="mt-4 text-sm text-pg-text-muted"
            >
              No messages yet.
            </div>

            <div v-else class="mt-4 space-y-3">
              <div
                v-for="(msg, idx) in task.messages"
                :key="idx"
                class="flex"
                :class="msg.role === 'user' ? 'justify-start' : 'justify-end'"
              >
                <div
                  class="max-w-[80%] rounded-pg border border-pg-border p-3"
                  :class="msg.role === 'user'
                    ? 'bg-pg-surface-raised'
                    : 'bg-pg-accent/10'"
                >
                  <div class="text-[11px] font-medium uppercase tracking-wide text-pg-text-muted">
                    {{ msg.role }}
                  </div>
                  <div class="mt-1 whitespace-pre-wrap text-sm text-pg-text">
                    {{ messagePartText(msg.parts) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Send message form -->
          <form
            class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm"
            @submit.prevent="sendMessage"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Send Message
            </div>
            <textarea
              v-model="messageText"
              rows="3"
              placeholder="Type a message..."
              class="pg-input mt-3 w-full"
              data-testid="message-textarea"
            />
            <button
              type="submit"
              class="mt-3 rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isSending || !messageText.trim()"
              data-testid="send-button"
            >
              {{ isSending ? 'Sending...' : 'Send' }}
            </button>
          </form>
        </section>

        <!-- Sidebar -->
        <aside class="space-y-4">
          <!-- Artifacts -->
          <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Artifacts
            </div>
            <div
              v-if="task.artifacts.length === 0"
              class="mt-3 text-sm text-pg-text-muted"
            >
              No artifacts.
            </div>
            <div v-else class="mt-3 space-y-2">
              <div
                v-for="(artifact, idx) in task.artifacts"
                :key="idx"
                class="rounded-pg border border-pg-border bg-pg-surface-raised p-3"
              >
                <div class="text-sm font-medium text-pg-text">{{ artifact.name }}</div>
                <div class="mt-1 text-xs text-pg-text-muted">
                  {{ artifact.parts.length }} part{{ artifact.parts.length === 1 ? '' : 's' }}
                </div>
              </div>
            </div>
          </div>

          <!-- Push notification config -->
          <div
            v-if="task.pushNotification"
            class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm"
          >
            <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
              Push Notifications
            </div>
            <div class="mt-3 space-y-2 text-sm text-pg-text-secondary">
              <div class="flex items-center justify-between gap-3">
                <span>URL</span>
                <span class="truncate font-mono text-xs">{{ task.pushNotification.url }}</span>
              </div>
              <div
                v-if="task.pushNotification.events"
                class="flex items-center justify-between gap-3"
              >
                <span>Events</span>
                <span class="text-xs">{{ task.pushNotification.events.join(', ') }}</span>
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
      Task not found.
    </div>
  </div>
</template>
