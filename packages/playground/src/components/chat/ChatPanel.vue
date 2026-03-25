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
    <div class="border-b border-pg-border-subtle bg-pg-surface/90 px-4 py-3">
      <p class="text-xs text-pg-text-muted">
        <span class="font-medium text-pg-text-secondary">Active agent:</span>
        {{ chatStore.currentAgent?.name ?? 'Not selected' }}
      </p>
    </div>

    <!-- Error banner -->
    <div
      v-if="chatStore.error"
      class="flex items-center gap-2 border-b border-pg-error bg-pg-error/14 px-4 py-2 text-sm text-pg-error"
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
