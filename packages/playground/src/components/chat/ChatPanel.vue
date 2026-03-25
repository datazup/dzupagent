<script setup lang="ts">
/**
 * ChatPanel -- Container with message list and chat input.
 *
 * Connects the chat store to the MessageList and ChatInput components.
 * Shows error messages when they occur.
 */
import { computed } from 'vue'
import { useChatStore } from '../../stores/chat-store.js'
import MessageList from './MessageList.vue'
import ChatInput from './ChatInput.vue'

const chatStore = useChatStore()

const isDisabled = computed(() => !chatStore.currentAgentId)

function handleSend(content: string): void {
  void chatStore.sendMessage(content)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-b border-[var(--pg-border-subtle)] bg-[color-mix(in_oklch,var(--pg-surface)_90%,transparent)] px-4 py-3">
      <p class="text-xs text-[var(--pg-text-muted)]">
        <span class="font-medium text-[var(--pg-text-secondary)]">Active agent:</span>
        {{ chatStore.currentAgent?.name ?? 'Not selected' }}
      </p>
    </div>

    <!-- Error banner -->
    <div
      v-if="chatStore.error"
      class="flex items-center gap-2 border-b border-[var(--pg-error)] bg-[color-mix(in_oklch,var(--pg-error)_14%,transparent)] px-4 py-2 text-sm text-[var(--pg-error)]"
      role="alert"
    >
      <span>{{ chatStore.error }}</span>
      <button
        class="ml-auto text-xs underline"
        @click="chatStore.clearError()"
      >
        Dismiss
      </button>
    </div>

    <!-- Messages -->
    <MessageList :messages="chatStore.messages" />

    <!-- Input -->
    <ChatInput
      :disabled="isDisabled"
      :loading="chatStore.isLoading"
      :placeholder="isDisabled ? 'Select an agent to start chatting...' : undefined"
      @send="handleSend"
    />
  </div>
</template>
