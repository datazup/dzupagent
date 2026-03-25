<script setup lang="ts">
/**
 * Root layout component.
 *
 * Provides the sidebar + main content area shell.
 * The sidebar contains branding and navigation links.
 */
import { computed } from 'vue'
import { useWsStore } from './stores/ws-store.js'

const wsStore = useWsStore()

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
