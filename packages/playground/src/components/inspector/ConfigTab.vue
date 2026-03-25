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
      <p class="text-sm text-pg-text-muted">
        Select an agent to view its configuration.
      </p>
    </div>

    <template v-if="agent">
      <!-- Name & Model -->
      <div>
        <h3 class="mb-1 text-sm font-semibold text-pg-text">
          {{ agent.name }}
        </h3>
        <p
          v-if="agent.description"
          class="mb-2 text-xs text-pg-text-secondary"
        >
          {{ agent.description }}
        </p>
        <div class="flex gap-2">
          <span class="pg-badge">
            {{ agent.modelTier }}
          </span>
          <span
            class="pg-badge"
            :class="agent.active
              ? 'bg-pg-success/20 text-pg-success'
              : ''"
          >
            {{ agent.active ? 'Active' : 'Inactive' }}
          </span>
        </div>
      </div>

      <!-- Agent ID -->
      <div>
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Agent ID</label>
        <code class="block rounded-pg-sm bg-pg-surface-raised px-3 py-2 font-mono text-xs text-pg-text-secondary">
          {{ agent.id }}
        </code>
      </div>
    </template>
  </div>
</template>
