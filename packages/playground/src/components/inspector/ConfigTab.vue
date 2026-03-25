<script setup lang="ts">
/**
 * ConfigTab -- Displays the selected agent's configuration.
 *
 * Shows instructions, guardrails, tools, and approval settings.
 */
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat-store.js'

const chatStore = useChatStore()

const agent = computed(() => chatStore.currentAgent)
</script>

<template>
  <div class="pg-scrollbar flex flex-col gap-4 overflow-y-auto p-4">
    <!-- No agent selected -->
    <div
      v-if="!agent"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-[var(--pg-text-muted)]">
        Select an agent to view its configuration.
      </p>
    </div>

    <template v-if="agent">
      <!-- Name & Model -->
      <div>
        <h3 class="mb-1 text-sm font-semibold text-[var(--pg-text)]">
          {{ agent.name }}
        </h3>
        <p
          v-if="agent.description"
          class="mb-2 text-xs text-[var(--pg-text-secondary)]"
        >
          {{ agent.description }}
        </p>
        <div class="flex gap-2">
          <span class="rounded-sm bg-[var(--pg-surface-raised)] px-2 py-0.5 text-xs text-[var(--pg-text-muted)]">
            {{ agent.modelTier }}
          </span>
          <span
            class="rounded-sm px-2 py-0.5 text-xs"
            :class="agent.active
              ? 'bg-[color-mix(in_oklch,var(--pg-success)_20%,transparent)] text-[var(--pg-success)]'
              : 'bg-[var(--pg-surface-raised)] text-[var(--pg-text-muted)]'"
          >
            {{ agent.active ? 'Active' : 'Inactive' }}
          </span>
        </div>
      </div>

      <!-- Agent ID -->
      <div>
        <label class="mb-1 block text-xs font-medium text-[var(--pg-text-muted)]">Agent ID</label>
        <code class="block rounded-[var(--pg-radius-sm)] bg-[var(--pg-surface-raised)] px-3 py-2 font-mono text-xs text-[var(--pg-text-secondary)]">
          {{ agent.id }}
        </code>
      </div>
    </template>
  </div>
</template>
