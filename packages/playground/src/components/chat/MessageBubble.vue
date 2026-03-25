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
  const base = 'max-w-[92%] rounded-[12px] border px-4 py-3 shadow-sm md:max-w-[85%]'
  switch (props.role) {
    case 'user':
      return `${base} ml-auto border-[color-mix(in_oklch,var(--pg-accent)_45%,var(--pg-border))] bg-[var(--pg-user-bg)] text-[var(--pg-text)]`
    case 'assistant':
      return `${base} mr-auto border-[var(--pg-border)] bg-[var(--pg-assistant-bg)] text-[var(--pg-text)]`
    case 'system':
      return `${base} mr-auto border-[color-mix(in_oklch,var(--pg-warning)_35%,var(--pg-border))] bg-[var(--pg-system-bg)] text-[var(--pg-text-secondary)] italic`
    default:
      return `${base} border-[var(--pg-border)] bg-[var(--pg-surface-raised)] text-[var(--pg-text)]`
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
      <span class="rounded-full border border-[var(--pg-border-subtle)] bg-[var(--pg-surface)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--pg-text-muted)]">
        {{ roleLabel }}
      </span>
      <span class="text-[11px] text-[var(--pg-text-muted)]">
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
