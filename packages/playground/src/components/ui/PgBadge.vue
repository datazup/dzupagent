<script setup lang="ts">
/**
 * PgBadge -- shared playground status / category badge primitive.
 *
 * Renders a rounded pill with a semantic color variant. Variants map to the
 * `pg-badge-*` utilities defined in `assets/main.css`, so the component
 * inherits the playground's theme tokens (and dark / light overrides) for
 * free.
 *
 * Use this primitive instead of hand-rolling `<span class="rounded-full ...">`
 * pills throughout the playground views. Behavior (the rendered text) is
 * provided via the default slot; visual variant is controlled via the
 * `variant` prop or the `status` / `capability` / `category` shortcuts.
 */
import { computed } from 'vue'
import {
  badgeVariantClass,
  capabilityBadgeVariant,
  categoryBadgeVariant,
  statusBadgeVariant,
  type BadgeVariant,
} from '../../composables/useStatusBadge.js'

interface Props {
  /** Explicit semantic variant; overrides `status` / `capability` / `category`. */
  variant?: BadgeVariant
  /** Convenience: derive the variant from a run / eval status string. */
  status?: string
  /** Convenience: derive the variant from a capability state. */
  capability?: string
  /** Convenience: derive the variant from a marketplace category. */
  category?: string
  /** Visual size. `sm` matches the existing tag-style badges (10px text). */
  size?: 'sm' | 'md'
}

const props = withDefaults(defineProps<Props>(), {
  variant: undefined,
  status: undefined,
  capability: undefined,
  category: undefined,
  size: 'md',
})

const resolvedVariant = computed<BadgeVariant>(() => {
  if (props.variant) return props.variant
  if (props.status !== undefined) return statusBadgeVariant(props.status)
  if (props.capability !== undefined) return capabilityBadgeVariant(props.capability)
  if (props.category !== undefined) return categoryBadgeVariant(props.category)
  return 'muted'
})

const variantClass = computed(() => badgeVariantClass(resolvedVariant.value))

const sizeClass = computed(() =>
  props.size === 'sm'
    ? 'px-2 py-0.5 text-[10px]'
    : 'px-2.5 py-1 text-xs',
)
</script>

<template>
  <span
    class="inline-flex items-center rounded-full font-medium"
    :class="[variantClass, sizeClass]"
    :data-variant="resolvedVariant"
  >
    <slot />
  </span>
</template>
