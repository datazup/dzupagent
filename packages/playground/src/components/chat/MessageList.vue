<script setup lang="ts">
/**
 * MessageList -- Renders a scrollable list of chat messages.
 *
 * Auto-scrolls to the latest message. Shows an empty state
 * when no messages are present.
 */
import { ref, watch, nextTick } from 'vue'
import type { ChatMessage } from '../../types.js'
import MessageBubble from './MessageBubble.vue'

interface Props {
  /** Array of chat messages to display */
  messages: ChatMessage[]
}

const props = defineProps<Props>()

const scrollContainer = ref<HTMLElement | null>(null)

/** Scroll to the bottom when new messages arrive */
watch(
  () => props.messages.length,
  async () => {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  },
)
</script>

<template>
  <div
    ref="scrollContainer"
    class="pg-scrollbar flex-1 overflow-y-auto px-4 py-4"
    role="log"
    aria-label="Chat messages"
    aria-live="polite"
  >
    <!-- Empty state -->
    <div
      v-if="messages.length === 0"
      class="flex h-full items-center justify-center"
    >
      <div class="max-w-sm rounded-pg-lg border border-dashed border-pg-border bg-pg-surface/90 p-6 text-center">
        <p class="mb-1 text-sm font-semibold text-pg-text-secondary">
          No conversation yet
        </p>
        <p class="text-xs leading-relaxed text-pg-text-muted">
          Choose an agent, send a prompt, and your trace and memory insights will appear in the inspector.
        </p>
      </div>
    </div>

    <!-- Messages -->
    <div
      v-else
      class="flex flex-col gap-4"
    >
      <MessageBubble
        v-for="msg in messages"
        :key="msg.id"
        :role="msg.role"
        :content="msg.content"
        :timestamp="msg.timestamp"
      />
    </div>
  </div>
</template>
