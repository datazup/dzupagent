<script setup lang="ts">
/**
 * MessageBubble -- Renders a single chat message with role-based styling.
 *
 * Displays content as preformatted text (no markdown library required).
 * Uses different background colors for user, assistant, and system roles.
 */
import { computed } from 'vue'
import type { MessageRole } from '../../types.js'

interface Props {
  /** The message role */
  role: MessageRole
  /** The message text content */
  content: string
  /** ISO timestamp */
  timestamp: string
}

const props = defineProps<Props>()

const bubbleClasses = computed(() => {
  const base = 'rounded-[var(--pg-radius)] px-4 py-3 max-w-[85%]'
  switch (props.role) {
    case 'user':
      return `${base} bg-[var(--pg-user-bg)] text-[var(--pg-text)] ml-auto`
    case 'assistant':
      return `${base} bg-[var(--pg-assistant-bg)] text-[var(--pg-text)] mr-auto`
    case 'system':
      return `${base} bg-[var(--pg-system-bg)] text-[var(--pg-text-secondary)] mr-auto italic`
    default:
      return `${base} bg-[var(--pg-surface-raised)] text-[var(--pg-text)]`
  }
})

const roleLabel = computed(() => {
  switch (props.role) {
    case 'user': return 'You'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    default: return props.role
  }
})

const formattedTime = computed(() => {
  try {
    const date = new Date(props.timestamp)
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
})
</script>

<template>
  <div
    class="flex flex-col gap-1"
    :class="role === 'user' ? 'items-end' : 'items-start'"
  >
    <div class="flex items-center gap-2 px-1">
      <span class="text-xs font-medium text-[var(--pg-text-muted)]">
        {{ roleLabel }}
      </span>
      <span class="text-xs text-[var(--pg-text-muted)]">
        {{ formattedTime }}
      </span>
    </div>
    <div
      :class="bubbleClasses"
      role="article"
      :aria-label="`${roleLabel} message`"
    >
      <pre class="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{{ content }}</pre>
    </div>
  </div>
</template>
