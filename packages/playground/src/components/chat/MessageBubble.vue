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
  const base = 'max-w-[92%] rounded-pg-lg border px-4 py-3 shadow-sm md:max-w-[85%]'
  switch (props.role) {
    case 'user':
      return `${base} ml-auto border-pg-accent/45 bg-pg-user-bg text-pg-text`
    case 'assistant':
      return `${base} mr-auto border-pg-border bg-pg-assistant-bg text-pg-text`
    case 'system':
      return `${base} mr-auto border-pg-warning/35 bg-pg-system-bg text-pg-text-secondary italic`
    default:
      return `${base} border-pg-border bg-pg-surface-raised text-pg-text`
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
      <span class="rounded-full border border-pg-border-subtle bg-pg-surface px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-pg-text-muted">
        {{ roleLabel }}
      </span>
      <span class="text-[11px] text-pg-text-muted">
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
