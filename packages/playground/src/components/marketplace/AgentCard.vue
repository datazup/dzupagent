<script setup lang="ts">
/**
 * AgentCard -- displays a single marketplace agent plugin as a card.
 *
 * Shows name, description, version, author, category, tags, install state,
 * and optional download count / rating.
 */
import { computed } from 'vue'
import type { MarketplaceAgent } from '../../types.js'

interface Props {
  /** The marketplace agent to display */
  agent: MarketplaceAgent
  /** Whether an install/uninstall action is in progress */
  actionLoading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  actionLoading: false,
})

const emit = defineEmits<{
  install: [agentId: string]
  uninstall: [agentId: string]
}>()

/** Category badge color mapping */
const categoryClass = computed(() => {
  const map: Record<string, string> = {
    observability: 'bg-blue-500/10 text-blue-400',
    memory: 'bg-purple-500/10 text-purple-400',
    security: 'bg-amber-500/10 text-amber-400',
    codegen: 'bg-green-500/10 text-green-400',
    integration: 'bg-cyan-500/10 text-cyan-400',
    testing: 'bg-rose-500/10 text-rose-400',
  }
  return map[props.agent.category] ?? 'bg-pg-text-muted/10 text-pg-text-muted'
})

/** Formatted download count (e.g., 12.4k) */
const formattedDownloads = computed(() => {
  const count = props.agent.downloadCount
  if (count === undefined || count === null) return null
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
})

/** Star rating display (1-5) */
const ratingStars = computed(() => {
  const rating = props.agent.rating
  if (rating === undefined || rating === null) return null
  return Math.round(rating * 10) / 10
})

function handleAction(): void {
  if (props.agent.installed) {
    emit('uninstall', props.agent.id)
  } else {
    emit('install', props.agent.id)
  }
}
</script>

<template>
  <div
    class="group relative flex flex-col rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm transition-shadow hover:shadow-md"
    :data-testid="`agent-card-${agent.id}`"
  >
    <!-- Header: Name + Version -->
    <div class="mb-2 flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="truncate text-sm font-semibold text-pg-text">
            {{ agent.name }}
          </h3>
          <span
            v-if="agent.verified"
            class="shrink-0 text-xs text-pg-accent"
            title="Verified plugin"
            aria-label="Verified plugin"
          >
            [v]
          </span>
        </div>
        <p class="mt-0.5 text-xs text-pg-text-muted">
          by {{ agent.author }}
        </p>
      </div>
      <span class="pg-badge shrink-0">
        v{{ agent.version }}
      </span>
    </div>

    <!-- Description -->
    <p class="mb-3 line-clamp-2 flex-1 text-xs leading-relaxed text-pg-text-secondary">
      {{ agent.description }}
    </p>

    <!-- Category + Tags -->
    <div class="mb-3 flex flex-wrap items-center gap-1.5">
      <span
        :class="categoryClass"
        class="rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
      >
        {{ agent.category }}
      </span>
      <span
        v-for="tag in agent.tags.slice(0, 3)"
        :key="tag"
        class="rounded-full bg-pg-surface-raised px-2 py-0.5 text-[10px] text-pg-text-muted"
      >
        {{ tag }}
      </span>
      <span
        v-if="agent.tags.length > 3"
        class="text-[10px] text-pg-text-muted"
      >
        +{{ agent.tags.length - 3 }}
      </span>
    </div>

    <!-- Stats row -->
    <div class="mb-3 flex items-center gap-4 text-[11px] text-pg-text-muted">
      <span
        v-if="formattedDownloads"
        :title="`${agent.downloadCount} downloads`"
      >
        {{ formattedDownloads }} downloads
      </span>
      <span
        v-if="ratingStars !== null"
        :title="`Rating: ${ratingStars}/5`"
      >
        {{ ratingStars }}/5
      </span>
    </div>

    <!-- Install / Uninstall -->
    <button
      :disabled="actionLoading"
      :class="agent.installed
        ? 'border-pg-error text-pg-error hover:bg-pg-error/10'
        : 'border-pg-accent text-pg-accent hover:bg-pg-accent/10'"
      class="mt-auto w-full rounded-pg border py-2 text-xs font-medium transition-colors disabled:opacity-50"
      :aria-label="agent.installed ? `Uninstall ${agent.name}` : `Install ${agent.name}`"
      @click="handleAction"
    >
      {{ actionLoading ? 'Working...' : (agent.installed ? 'Uninstall' : 'Install') }}
    </button>
  </div>
</template>
