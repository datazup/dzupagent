<script setup lang="ts">
/**
 * PgButton -- shared playground button primitive.
 *
 * Wraps the small set of button styles that the playground uses today:
 *   - `outline` (default): bordered, neutral surface; matches the row-action
 *     and pagination buttons used in `RunHistoryBrowser` and similar tables.
 *   - `accent`: filled accent button, equivalent to the existing
 *     `pg-btn-accent` utility.
 *   - `ghost`: minimal hover-only button used in toolbars (e.g. replay
 *     controls in `TraceTimeline`).
 *
 * Behavior (label + click handlers) is provided by the slot / native
 * `button` element so consumers don't lose anything by migrating.
 */
import { computed } from 'vue'

type Variant = 'outline' | 'accent' | 'ghost'
type Size = 'sm' | 'md'

interface Props {
  variant?: Variant
  size?: Size
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'outline',
  size: 'md',
  type: 'button',
  disabled: false,
})

const variantClass = computed(() => {
  switch (props.variant) {
    case 'accent':
      return 'pg-btn-accent'
    case 'ghost':
      return 'rounded-pg-sm text-pg-text-secondary hover:bg-pg-surface-raised hover:text-pg-text'
    case 'outline':
    default:
      return 'rounded-pg-sm border border-pg-border text-pg-text-secondary hover:bg-pg-surface-raised hover:text-pg-text'
  }
})

const sizeClass = computed(() => {
  // `pg-btn-accent` already provides padding + font-size; only outline / ghost
  // need explicit sizing.
  if (props.variant === 'accent') return ''
  return props.size === 'sm'
    ? 'px-2.5 py-1 text-xs'
    : 'px-3 py-1.5 text-xs'
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    :class="[variantClass, sizeClass]"
    :data-variant="variant"
  >
    <slot />
  </button>
</template>
