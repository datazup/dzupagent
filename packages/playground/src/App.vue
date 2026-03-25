<script setup lang="ts">
/**
 * Root layout component.
 *
 * Provides the sidebar + main content area shell.
 * The sidebar contains branding and navigation links.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useWsStore } from './stores/ws-store.js'
import { useTraceStore } from './stores/trace-store.js'
import { useChatStore } from './stores/chat-store.js'
import type { TraceEvent, WsEvent } from './types.js'

const wsStore = useWsStore()
const traceStore = useTraceStore()
const chatStore = useChatStore()
let sse: EventSource | null = null

function traceTypeFromWsEvent(type: string): TraceEvent['type'] {
  if (type.startsWith('tool:')) return 'tool'
  if (type.startsWith('memory:')) return 'memory'
  if (type.startsWith('approval:') || type.startsWith('policy:') || type.startsWith('safety:')) return 'guardrail'
  if (type.startsWith('agent:') || type.startsWith('pipeline:') || type.startsWith('provider:')) return 'llm'
  return 'system'
}

function traceNameFromWsEvent(event: WsEvent): string {
  const payload = (event['payload'] && typeof event['payload'] === 'object')
    ? (event['payload'] as Record<string, unknown>)
    : null

  if (typeof event['message'] === 'string') return event['message']
  if (payload && typeof payload['message'] === 'string') return payload['message']

  if (typeof event['toolName'] === 'string') return `${event.type} (${event['toolName']})`
  if (payload && typeof payload['toolName'] === 'string') return `${event.type} (${payload['toolName']})`

  if (typeof event['phase'] === 'string') return `${event.type} (${event['phase']})`
  if (payload && typeof payload['phase'] === 'string') return `${event.type} (${payload['phase']})`

  if (typeof event['namespace'] === 'string') return `${event.type} (${event['namespace']})`
  if (payload && typeof payload['namespace'] === 'string') return `${event.type} (${payload['namespace']})`

  return event.type
}

function pushTraceFromEvent(event: WsEvent): void {
  if (event.type === 'subscribed' || event.type === 'unsubscribed' || event.type === 'error') return
  traceStore.addEvent({
    id: `ws-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: traceTypeFromWsEvent(event.type),
    name: traceNameFromWsEvent(event),
    startedAt: event.timestamp ?? new Date().toISOString(),
    durationMs: typeof event['durationMs'] === 'number' ? event['durationMs'] : 1,
    metadata: event,
  })
}

function normalizeIncomingEvent(value: unknown): WsEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  // WS messages already match the expected shape (non-envelope).
  const isEnvelope = record['version'] === 'v1' && record['payload'] && typeof record['payload'] === 'object'
  if (typeof record['type'] === 'string' && !isEnvelope) {
    return record as WsEvent
  }

  // SSE gateway events are EventEnvelope; map envelope + payload into WsEvent.
  const payload = record['payload']
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const payloadRecord = payload as Record<string, unknown>
    if (typeof payloadRecord['type'] === 'string') {
      return {
        ...payloadRecord,
        id: typeof record['id'] === 'string' ? record['id'] : undefined,
        timestamp: typeof record['timestamp'] === 'string' ? record['timestamp'] : undefined,
        runId: typeof record['runId'] === 'string' ? record['runId'] : undefined,
        agentId: typeof record['agentId'] === 'string' ? record['agentId'] : undefined,
      } as WsEvent
    }
  }

  if (typeof record['type'] === 'string') {
    return record as WsEvent
  }

  return null
}

function toWsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit
  }

  const url = new URL(window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = import.meta.env.VITE_WS_PATH || '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function toSseUrl(agentId: string | null): string {
  const base = new URL('/api/events/stream', window.location.origin)
  if (agentId) {
    base.searchParams.set('agentId', agentId)
  }
  return base.toString()
}

function stopSse(): void {
  if (sse) {
    sse.close()
    sse = null
  }
}

function startSse(agentId: string | null): void {
  stopSse()
  sse = new EventSource(toSseUrl(agentId))
  sse.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data) as unknown
      const normalized = normalizeIncomingEvent(parsed)
      if (normalized) {
        chatStore.handleRealtimeEvent(normalized as Record<string, unknown>)
        pushTraceFromEvent(normalized)
      }
    } catch {
      // Ignore malformed event payloads.
    }
  }
  sse.onerror = () => {
    stopSse()
  }
}

onMounted(() => {
  wsStore.connect(toWsUrl())
})

onUnmounted(() => {
  stopSse()
  wsStore.disconnect()
})

watch(
  () => wsStore.lastEvent,
  (event) => {
    if (!event) return
    chatStore.handleRealtimeEvent(event as Record<string, unknown>)
    pushTraceFromEvent(event)
  },
)

watch(
  () => wsStore.state,
  (state) => {
    if (state === 'connected') {
      stopSse()
      return
    }
    if (state === 'error' && !sse) {
      startSse(chatStore.currentAgentId)
    }
  },
)

watch(
  () => chatStore.currentAgentId,
  (agentId) => {
    if (sse) {
      startSse(agentId)
    }
  },
)

const connectionClass = computed(() => {
  switch (wsStore.state) {
    case 'connected': return 'bg-[var(--pg-success)]'
    case 'connecting': return 'bg-[var(--pg-warning)]'
    case 'error': return 'bg-[var(--pg-error)]'
    default: return 'bg-[var(--pg-text-muted)]'
  }
})

const connectionLabel = computed(() => {
  switch (wsStore.state) {
    case 'connected': return 'Live'
    case 'connecting': return 'Connecting'
    case 'error': return 'Fallback'
    default: return 'Offline'
  }
})
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-transparent">
    <!-- Sidebar -->
    <aside
      class="hidden w-[var(--pg-sidebar-width)] flex-col border-r border-[var(--pg-border)] bg-[color-mix(in_oklch,var(--pg-surface)_95%,transparent)] backdrop-blur md:flex"
    >
      <!-- Logo -->
      <div class="flex items-center gap-3 border-b border-[var(--pg-border)] px-5 py-4">
        <div
          class="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--pg-accent)] text-sm font-bold text-[var(--pg-accent-text)] shadow-sm"
        >
          FA
        </div>
        <div>
          <div class="text-sm font-semibold tracking-wide text-[var(--pg-text)]">
            ForgeAgent
          </div>
          <div class="text-xs text-[var(--pg-text-muted)]">
            Control Playground
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 px-3 py-4">
        <router-link
          to="/"
          class="flex items-center gap-2 rounded-[10px] border border-transparent px-3 py-2.5 text-sm font-medium text-[var(--pg-text-secondary)] transition-colors hover:bg-[var(--pg-surface-raised)] hover:text-[var(--pg-text)]"
          active-class="!border-[var(--pg-border)] !bg-[var(--pg-surface-raised)] !text-[var(--pg-text)]"
        >
          Agent Chat
        </router-link>
        <p class="px-3 pt-3 text-xs leading-relaxed text-[var(--pg-text-muted)]">
          Chat, trace events, inspect memory, and tune configuration from one workspace.
        </p>
      </nav>

      <!-- Connection status -->
      <div class="border-t border-[var(--pg-border)] px-5 py-4">
        <div class="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--pg-text-muted)]">
          Realtime
        </div>
        <div class="flex items-center gap-2 text-xs text-[var(--pg-text-secondary)]">
          <span
            :class="connectionClass"
            class="inline-block h-2.5 w-2.5 rounded-full"
          />
          {{ wsStore.state }}
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="flex items-center justify-between border-b border-[var(--pg-border)] bg-[color-mix(in_oklch,var(--pg-surface)_92%,transparent)] px-4 py-3 backdrop-blur md:hidden">
        <div class="flex items-center gap-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--pg-accent)] text-xs font-bold text-[var(--pg-accent-text)]">
            FA
          </div>
          <div>
            <p class="text-sm font-semibold leading-tight text-[var(--pg-text)]">
              ForgeAgent Playground
            </p>
            <p class="text-xs text-[var(--pg-text-muted)]">
              Mobile workspace
            </p>
          </div>
        </div>
        <div class="inline-flex items-center gap-2 rounded-full border border-[var(--pg-border)] bg-[var(--pg-surface)] px-2.5 py-1">
          <span
            :class="connectionClass"
            class="inline-block h-2 w-2 rounded-full"
          />
          <span class="text-[11px] font-medium text-[var(--pg-text-secondary)]">{{ connectionLabel }}</span>
        </div>
      </header>

      <router-view />
    </main>
  </div>
</template>
