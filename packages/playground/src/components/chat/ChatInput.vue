<script setup lang="ts">
/**
 * ChatInput -- Text input with send button.
 *
 * Supports Enter to send and Shift+Enter for newline.
 * Disables input when loading or no agent is selected.
 */
import { ref } from 'vue'

interface Props {
  /** Whether the input should be disabled */
  disabled?: boolean
  /** Whether a message is currently being sent */
  loading?: boolean
  /** Placeholder text */
  placeholder?: string
}

withDefaults(defineProps<Props>(), {
  disabled: false,
  loading: false,
  placeholder: 'Type a message... (Enter to send, Shift+Enter for newline)',
})

const emit = defineEmits<{
  send: [content: string]
}>()

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

function handleSend(): void {
  const trimmed = inputText.value.trim()
  if (!trimmed) return
  emit('send', trimmed)
  inputText.value = ''

  // Reset textarea height
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}

function handleInput(): void {
  // Auto-resize textarea
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
    textareaRef.value.style.height = `${Math.min(textareaRef.value.scrollHeight, 160)}px`
  }
}
</script>

<template>
  <div class="border-t border-pg-border pg-surface-glass p-4">
    <div class="flex items-end gap-2">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :placeholder="placeholder"
        :disabled="disabled || loading"
        rows="1"
        class="flex-1 resize-none rounded-pg-lg border border-pg-border bg-pg-surface-raised px-3 py-2.5 text-sm text-pg-text placeholder:text-pg-text-muted shadow-sm focus:border-pg-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Chat message input"
        @keydown="handleKeydown"
        @input="handleInput"
      />
      <button
        :disabled="disabled || loading || !inputText.trim()"
        class="rounded-pg-lg bg-pg-accent px-4 py-2.5 text-sm font-medium text-pg-accent-text shadow-sm transition-colors hover:bg-pg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Send message"
        @click="handleSend"
      >
        {{ loading ? 'Sending...' : 'Send' }}
      </button>
    </div>
    <p class="mt-2 text-[11px] text-pg-text-muted">
      Press <kbd class="rounded border border-pg-border px-1.5 py-0.5 text-[10px]">Enter</kbd> to send, <kbd class="rounded border border-pg-border px-1.5 py-0.5 text-[10px]">Shift + Enter</kbd> for newline.
    </p>
  </div>
</template>
