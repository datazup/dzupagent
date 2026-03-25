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
      class="flex items-center gap-3 border-b border-[var(--pg-border)] bg-[var(--pg-surface)] px-4 py-2"
    >
      <label
        for="agent-select"
        class="text-xs font-medium text-[var(--pg-text-muted)]"
      >
        Agent
      </label>
      <select
        id="agent-select"
        :value="chatStore.currentAgentId ?? ''"
        class="rounded-[var(--pg-radius-sm)] border border-[var(--pg-border)] bg-[var(--pg-surface-raised)] px-3 py-1.5 text-sm text-[var(--pg-text)] focus:border-[var(--pg-accent)] focus:outline-none"
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
        class="text-xs text-[var(--pg-text-muted)]"
      >
        {{ chatStore.currentAgent.modelTier }}
      </span>
    </header>

    <!-- Two-panel content -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Chat panel (left) -->
      <div class="flex w-1/2 flex-col border-r border-[var(--pg-border)]">
        <ChatPanel />
      </div>

      <!-- Inspector panel (right) -->
      <div class="flex w-1/2 flex-col">
        <InspectorPanel />
      </div>
    </div>
  </div>
</template>
