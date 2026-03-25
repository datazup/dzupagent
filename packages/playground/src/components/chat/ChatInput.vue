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
  <div class="border-t border-[var(--pg-border)] bg-[var(--pg-surface)] p-4">
    <div class="flex items-end gap-2">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :placeholder="placeholder"
        :disabled="disabled || loading"
        rows="1"
        class="flex-1 resize-none rounded-[var(--pg-radius)] border border-[var(--pg-border)] bg-[var(--pg-surface-raised)] px-3 py-2 text-sm text-[var(--pg-text)] placeholder:text-[var(--pg-text-muted)] focus:border-[var(--pg-accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Chat message input"
        @keydown="handleKeydown"
        @input="handleInput"
      />
      <button
        :disabled="disabled || loading || !inputText.trim()"
        class="rounded-[var(--pg-radius)] bg-[var(--pg-accent)] px-4 py-2 text-sm font-medium text-[var(--pg-accent-text)] transition-colors hover:bg-[var(--pg-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Send message"
        @click="handleSend"
      >
        {{ loading ? 'Sending...' : 'Send' }}
      </button>
    </div>
  </div>
</template>
