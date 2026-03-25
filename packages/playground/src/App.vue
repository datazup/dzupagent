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
import type { TraceEvent, WsEvent } from './types.js'

const wsStore = useWsStore()
const traceStore = useTraceStore()

function traceTypeFromWsEvent(type: string): TraceEvent['type'] {
  if (type.startsWith('tool:')) return 'tool'
  if (type.startsWith('memory:')) return 'memory'
  if (type.startsWith('approval:') || type.startsWith('policy:') || type.startsWith('safety:')) return 'guardrail'
  if (type.startsWith('agent:') || type.startsWith('pipeline:') || type.startsWith('provider:')) return 'llm'
  return 'system'
}

function traceNameFromWsEvent(event: WsEvent): string {
  if (typeof event['message'] === 'string') return event['message']
  if (typeof event['toolName'] === 'string') return `${event.type} (${event['toolName']})`
  if (typeof event['phase'] === 'string') return `${event.type} (${event['phase']})`
  if (typeof event['namespace'] === 'string') return `${event.type} (${event['namespace']})`
  return event.type
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

onMounted(() => {
  wsStore.connect(toWsUrl())
})

onUnmounted(() => {
  wsStore.disconnect()
})

watch(
  () => wsStore.lastEvent,
  (event) => {
    if (!event) return
    traceStore.addEvent({
      id: `ws-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      type: traceTypeFromWsEvent(event.type),
      name: traceNameFromWsEvent(event),
      startedAt: event.timestamp ?? new Date().toISOString(),
      durationMs: typeof event['durationMs'] === 'number' ? event['durationMs'] : 1,
      metadata: event,
    })
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
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden">
    <!-- Sidebar -->
    <aside
      class="flex w-[var(--pg-sidebar-width)] flex-col border-r border-[var(--pg-border)] bg-[var(--pg-surface)]"
    >
      <!-- Logo -->
      <div class="flex items-center gap-2 border-b border-[var(--pg-border)] px-4 py-3">
        <div
          class="flex h-8 w-8 items-center justify-center rounded-[var(--pg-radius-sm)] bg-[var(--pg-accent)] text-sm font-bold text-[var(--pg-accent-text)]"
        >
          FA
        </div>
        <div>
          <div class="text-sm font-semibold text-[var(--pg-text)]">
            ForgeAgent
          </div>
          <div class="text-xs text-[var(--pg-text-muted)]">
            Playground
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 px-2 py-3">
        <router-link
          to="/"
          class="flex items-center gap-2 rounded-[var(--pg-radius-sm)] px-3 py-2 text-sm text-[var(--pg-text-secondary)] transition-colors hover:bg-[var(--pg-surface-raised)] hover:text-[var(--pg-text)]"
          active-class="!bg-[var(--pg-surface-raised)] !text-[var(--pg-text)]"
        >
          Chat &amp; Inspect
        </router-link>
      </nav>

      <!-- Connection status -->
      <div class="border-t border-[var(--pg-border)] px-4 py-3">
        <div class="flex items-center gap-2 text-xs text-[var(--pg-text-muted)]">
          <span
            :class="connectionClass"
            class="inline-block h-2 w-2 rounded-full"
          />
          {{ wsStore.state }}
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex flex-1 flex-col overflow-hidden">
      <router-view />
    </main>
  </div>
</template>
