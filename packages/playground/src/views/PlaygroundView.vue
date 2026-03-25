<script setup lang="ts">
/**
 * PlaygroundView -- Two-panel layout: Chat on left, Inspector on right.
 *
 * Includes an agent selector dropdown at the top and
 * splits the remaining space between ChatPanel and InspectorPanel.
 */
import { onMounted } from 'vue'
import { useChatStore } from '../stores/chat-store.js'
import ChatPanel from '../components/chat/ChatPanel.vue'
import InspectorPanel from '../components/inspector/InspectorPanel.vue'

const chatStore = useChatStore()

onMounted(() => {
  void chatStore.fetchAgents()
})

function onAgentSelect(event: Event): void {
  const target = event.target as HTMLSelectElement
  chatStore.selectAgent(target.value)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Agent selector bar -->
    <header
      class="flex flex-col gap-3 border-b border-[var(--pg-border)] bg-[color-mix(in_oklch,var(--pg-surface)_94%,transparent)] px-4 py-3 backdrop-blur md:flex-row md:items-center md:justify-between"
    >
      <div>
        <h1 class="text-sm font-semibold tracking-wide text-[var(--pg-text)] md:text-base">
          Interactive Agent Console
        </h1>
        <p class="text-xs text-[var(--pg-text-muted)]">
          Pick an agent, send prompts, and inspect runtime signals.
        </p>
      </div>

      <div class="flex items-center gap-3">
        <label
          for="agent-select"
          class="sr-only"
        >
          Agent
        </label>
        <select
          id="agent-select"
          :value="chatStore.currentAgentId ?? ''"
          class="w-full min-w-56 rounded-[10px] border border-[var(--pg-border)] bg-[var(--pg-surface-raised)] px-3 py-2 text-sm text-[var(--pg-text)] shadow-sm focus:border-[var(--pg-accent)] focus:outline-none md:w-auto"
          @change="onAgentSelect"
        >
          <option
            value=""
            disabled
          >
            Select an agent...
          </option>
          <option
            v-for="agent in chatStore.agents"
            :key="agent.id"
            :value="agent.id"
          >
            {{ agent.name }}
          </option>
        </select>

        <span
          v-if="chatStore.currentAgent"
          class="hidden rounded-full border border-[var(--pg-border)] bg-[var(--pg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--pg-text-secondary)] md:inline-flex"
        >
          {{ chatStore.currentAgent.modelTier }}
        </span>
      </div>
    </header>

    <!-- Two-panel content -->
    <div class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[1.15fr_1fr]">
      <!-- Chat panel (left) -->
      <div class="flex min-h-0 flex-col border-b border-[var(--pg-border)] xl:border-r xl:border-b-0">
        <ChatPanel />
      </div>

      <!-- Inspector panel (right) -->
      <div class="flex min-h-0 flex-col">
        <InspectorPanel />
      </div>
    </div>
  </div>
</template>
