<script setup lang="ts">
/**
 * MarketplaceView -- Browse, search, and install agent plugins.
 *
 * Features:
 * - Search input for filtering by name/description/tags
 * - Category filter tabs
 * - Responsive card grid
 * - Loading, empty, and error states
 */
import { onMounted, ref } from 'vue'
import { useMarketplaceStore, MARKETPLACE_CATEGORIES } from '../stores/marketplace-store.js'
import AgentCard from '../components/marketplace/AgentCard.vue'
import type { MarketplaceCategory } from '../types.js'

const store = useMarketplaceStore()

/** Track which agent is currently being installed/uninstalled */
const actionAgentId = ref<string | null>(null)

async function handleInstall(agentId: string): Promise<void> {
  actionAgentId.value = agentId
  await store.installAgent(agentId)
  actionAgentId.value = null
}

async function handleUninstall(agentId: string): Promise<void> {
  actionAgentId.value = agentId
  await store.uninstallAgent(agentId)
  actionAgentId.value = null
}

function handleCategoryClick(category: MarketplaceCategory | null): void {
  store.setCategory(category)
}

onMounted(() => {
  void store.fetchAgents()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <header class="flex flex-col gap-4 border-b border-pg-border pg-surface-glass px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          Agent Marketplace
        </h1>
        <p class="text-xs text-pg-text-muted">
          {{ store.installedCount }} installed of {{ store.agents.length }} available
        </p>
      </div>

      <!-- Search -->
      <div class="relative w-full sm:w-72">
        <input
          :value="store.searchQuery"
          type="text"
          placeholder="Search plugins..."
          class="pg-input w-full pl-8"
          aria-label="Search marketplace plugins"
          @input="store.setSearchQuery(($event.target as HTMLInputElement).value)"
        >
        <span
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-pg-text-muted"
          aria-hidden="true"
        >
          ?
        </span>
      </div>
    </header>

    <!-- Category filter tabs -->
    <div class="flex gap-1 overflow-x-auto border-b border-pg-border bg-pg-surface px-6 py-2">
      <button
        class="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors"
        :class="store.selectedCategory === null
          ? 'bg-pg-accent/10 text-pg-text'
          : 'text-pg-text-muted hover:text-pg-text-secondary'"
        @click="handleCategoryClick(null)"
      >
        All
      </button>
      <button
        v-for="cat in MARKETPLACE_CATEGORIES"
        :key="cat"
        class="shrink-0 rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors"
        :class="store.selectedCategory === cat
          ? 'bg-pg-accent/10 text-pg-text'
          : 'text-pg-text-muted hover:text-pg-text-secondary'"
        @click="handleCategoryClick(cat)"
      >
        {{ cat }}
      </button>
    </div>

    <!-- Error banner -->
    <div
      v-if="store.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ store.error }}
      <button
        class="ml-2 underline"
        @click="store.clearError()"
      >
        Dismiss
      </button>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="store.isLoading"
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="n in 6"
          :key="n"
          class="animate-pulse rounded-pg-lg border border-pg-border bg-pg-surface p-5"
          data-testid="skeleton-card"
        >
          <div class="mb-3 h-4 w-3/4 rounded bg-pg-surface-raised" />
          <div class="mb-2 h-3 w-1/2 rounded bg-pg-surface-raised" />
          <div class="mb-4 h-8 w-full rounded bg-pg-surface-raised" />
          <div class="mb-3 flex gap-2">
            <div class="h-4 w-16 rounded-full bg-pg-surface-raised" />
            <div class="h-4 w-12 rounded-full bg-pg-surface-raised" />
          </div>
          <div class="h-8 w-full rounded bg-pg-surface-raised" />
        </div>
      </div>
    </div>

    <!-- Content -->
    <div
      v-else
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <!-- Empty state -->
      <div
        v-if="store.filteredAgents.length === 0"
        class="flex h-48 items-center justify-center"
      >
        <div class="text-center">
          <p class="text-sm text-pg-text-secondary">
            No agents found
          </p>
          <p class="mt-1 text-xs text-pg-text-muted">
            Try adjusting your search or category filter.
          </p>
        </div>
      </div>

      <!-- Agent grid -->
      <div
        v-else
        class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <AgentCard
          v-for="agent in store.filteredAgents"
          :key="agent.id"
          :agent="agent"
          :action-loading="actionAgentId === agent.id"
          @install="handleInstall"
          @uninstall="handleUninstall"
        />
      </div>
    </div>
  </div>
</template>
