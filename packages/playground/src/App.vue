<script setup lang="ts">
/**
 * Root layout component.
 *
 * Provides the sidebar + main content area shell.
 * The sidebar contains branding, navigation links, and status indicators.
 */
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useWsStore } from './stores/ws-store.js'
import { useTraceStore } from './stores/trace-store.js'
import { useChatStore } from './stores/chat-store.js'
import { useHealthStore } from './stores/health-store.js'
import type { TraceEvent, WsEvent } from './types.js'

const wsStore = useWsStore()
const traceStore = useTraceStore()
const chatStore = useChatStore()
const healthStore = useHealthStore()
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

  const isEnvelope = record['version'] === 'v1' && record['payload'] && typeof record['payload'] === 'object'
  if (typeof record['type'] === 'string' && !isEnvelope) {
    return record as WsEvent
  }

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
  healthStore.startPolling()
})

onUnmounted(() => {
  stopSse()
  wsStore.disconnect()
  healthStore.stopPolling()
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
    case 'connected': return 'bg-pg-success'
    case 'connecting': return 'bg-pg-warning'
    case 'error': return 'bg-pg-error'
    default: return 'bg-pg-text-muted'
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

const healthClass = computed(() => {
  if (!healthStore.health) return 'bg-pg-text-muted'
  switch (healthStore.health.status) {
    case 'ok': return 'bg-pg-success'
    case 'degraded': return 'bg-pg-warning'
    default: return 'bg-pg-error'
  }
})

const healthLabel = computed(() => {
  if (!healthStore.health) return 'Unknown'
  return healthStore.health.status === 'ok' ? 'Healthy' : healthStore.health.status
})

const navLinks = [
  { to: '/', label: 'Agent Chat', icon: '>' },
  { to: '/agent-definitions', label: 'Agent Definitions', icon: '#' },
  { to: '/runs', label: 'Run History', icon: '%' },
  { to: '/eval-dashboard', label: 'Eval Dashboard', icon: '*' },
  { to: '/evals', label: 'Evals', icon: '=' },
  { to: '/benchmarks', label: 'Benchmarks', icon: '~' },
  { to: '/marketplace', label: 'Marketplace', icon: '@' },
  { to: '/a2a', label: 'A2A Tasks', icon: '&' },
]
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-transparent">
    <!-- Sidebar -->
    <aside
      class="hidden w-pg-sidebar flex-col border-r border-pg-border bg-pg-surface/95 backdrop-blur md:flex"
    >
      <!-- Logo -->
      <div class="flex items-center gap-3 border-b border-pg-border px-5 py-4">
        <div
          class="flex h-9 w-9 items-center justify-center rounded-pg bg-pg-accent text-sm font-bold text-pg-accent-text shadow-sm"
        >
          FA
        </div>
        <div>
          <div class="text-sm font-semibold tracking-wide text-pg-text">
            DzipAgent
          </div>
          <div class="text-xs text-pg-text-muted">
            Control Playground
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 space-y-1 px-3 py-4">
        <router-link
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="flex items-center gap-2 rounded-pg border border-transparent px-3 py-2.5 text-sm font-medium text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
          active-class="!border-pg-border !bg-pg-surface-raised !text-pg-text"
        >
          {{ link.label }}
        </router-link>
        <p class="px-3 pt-3 text-xs leading-relaxed text-pg-text-muted">
          Chat, trace events, inspect memory, manage agents, and review runs from one workspace.
        </p>
      </nav>

      <!-- Status panel -->
      <div class="border-t border-pg-border px-5 py-4">
        <!-- Server health -->
        <div class="mb-3">
          <div class="mb-1 text-[11px] font-medium uppercase tracking-pg-label text-pg-text-muted">
            Server
          </div>
          <div class="flex items-center gap-2 text-xs text-pg-text-secondary">
            <span
              :class="healthClass"
              class="inline-block h-2.5 w-2.5 rounded-full"
            />
            <span>{{ healthLabel }}</span>
            <span
              v-if="healthStore.uptimeFormatted !== '--'"
              class="ml-auto text-[10px] text-pg-text-muted"
            >
              up {{ healthStore.uptimeFormatted }}
            </span>
          </div>
          <!-- Readiness checks -->
          <div
            v-if="healthStore.readinessChecks.length > 0"
            class="mt-1.5 flex flex-col gap-0.5"
          >
            <div
              v-for="check in healthStore.readinessChecks"
              :key="check.name"
              class="flex items-center gap-1.5 text-[10px]"
            >
              <span
                class="inline-block h-1.5 w-1.5 rounded-full"
                :class="check.status === 'ok' ? 'bg-pg-success' : 'bg-pg-error'"
              />
              <span class="text-pg-text-muted">{{ check.name }}</span>
            </div>
          </div>
        </div>

        <!-- Realtime connection -->
        <div>
          <div class="mb-1 text-[11px] font-medium uppercase tracking-pg-label text-pg-text-muted">
            Realtime
          </div>
          <div class="flex items-center gap-2 text-xs text-pg-text-secondary">
            <span
              :class="connectionClass"
              class="inline-block h-2.5 w-2.5 rounded-full"
            />
            {{ wsStore.state }}
          </div>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header class="flex items-center justify-between border-b border-pg-border pg-surface-glass px-4 py-3 md:hidden">
        <div class="flex items-center gap-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-pg bg-pg-accent text-xs font-bold text-pg-accent-text">
            FA
          </div>
          <div>
            <p class="text-sm font-semibold leading-tight text-pg-text">
              DzipAgent Playground
            </p>
            <p class="text-xs text-pg-text-muted">
              Mobile workspace
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <!-- Health dot (mobile) -->
          <span
            :class="healthClass"
            class="inline-block h-2 w-2 rounded-full"
          />
          <div class="inline-flex items-center gap-2 rounded-full border border-pg-border bg-pg-surface px-2.5 py-1">
            <span
              :class="connectionClass"
              class="inline-block h-2 w-2 rounded-full"
            />
            <span class="text-[11px] font-medium text-pg-text-secondary">{{ connectionLabel }}</span>
          </div>
        </div>
      </header>

      <!-- Mobile navigation -->
      <nav class="flex gap-1 overflow-x-auto border-b border-pg-border bg-pg-surface px-3 py-2 md:hidden">
        <router-link
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="shrink-0 rounded-full px-3 py-1 text-xs font-medium text-pg-text-muted"
          active-class="!bg-pg-accent/10 !text-pg-text"
        >
          {{ link.label }}
        </router-link>
      </nav>

      <router-view />
    </main>
  </div>
</template>
