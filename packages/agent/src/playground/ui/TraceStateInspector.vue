<script setup lang="ts">
/**
 * TraceStateInspector -- State diff inspector that compares before/after
 * state snapshots and highlights changed keys.
 *
 * Renders each key as a collapsible row with color-coded change type
 * indicators: green for added, red for removed, yellow for modified,
 * and gray for unchanged.
 */
import { computed, ref } from 'vue'
import type { ChangeType } from './utils.js'
import { computeDiffRows, formatValue } from './utils.js'

/** Component props */
interface Props {
  /** State snapshot before the step */
  stateBefore: Record<string, unknown>
  /** State snapshot after the step */
  stateAfter: Record<string, unknown>
}

const props = defineProps<Props>()

/** Set of expanded keys */
const expandedKeys = ref<Set<string>>(new Set())

/** Toggle expanded state for a key */
function toggleKey(key: string): void {
  const next = new Set(expandedKeys.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedKeys.value = next
}

/** Check if a key is expanded */
function isExpanded(key: string): boolean {
  return expandedKeys.value.has(key)
}

/** Handle keyboard activation */
function handleKeydown(e: KeyboardEvent, key: string): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggleKey(key)
  }
}

/** Computed diff rows sorted by change type then key name */
const diffRows = computed(() => computeDiffRows(props.stateBefore, props.stateAfter))

/** Count of changed keys */
const changeCount = computed(() =>
  diffRows.value.filter(r => r.changeType !== 'unchanged').length,
)

/** Badge classes per change type */
function changeClasses(changeType: ChangeType): string {
  switch (changeType) {
    case 'added':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
    case 'removed':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
    case 'modified':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    case 'unchanged':
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
  }
}

/** Row border classes per change type */
function rowBorderClasses(changeType: ChangeType): string {
  switch (changeType) {
    case 'added':
      return 'border-l-emerald-500'
    case 'removed':
      return 'border-l-red-500'
    case 'modified':
      return 'border-l-yellow-500'
    case 'unchanged':
      return 'border-l-transparent'
  }
}

</script>

<template>
  <div
    class="flex flex-col gap-2"
    role="region"
    aria-label="State diff inspector"
  >
    <!-- Summary header -->
    <div class="flex items-center justify-between px-1">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100">
        State Changes
      </h3>
      <span class="text-xs text-gray-500 dark:text-gray-400">
        {{ changeCount }} change{{ changeCount === 1 ? '' : 's' }} across {{ diffRows.length }} key{{ diffRows.length === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- Empty state -->
    <div
      v-if="diffRows.length === 0"
      class="flex items-center justify-center rounded-md border border-gray-200 py-6 dark:border-gray-700"
    >
      <p class="text-sm text-gray-500 dark:text-gray-400">
        No state data to compare.
      </p>
    </div>

    <!-- Diff rows -->
    <div
      v-for="row in diffRows"
      :key="row.key"
      class="overflow-hidden rounded-md border border-gray-200 border-l-4 dark:border-gray-700"
      :class="rowBorderClasses(row.changeType)"
    >
      <!-- Row header (clickable) -->
      <div
        class="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
        role="button"
        :tabindex="0"
        :aria-expanded="isExpanded(row.key)"
        :aria-label="`Key ${row.key}, ${row.changeType}`"
        @click="toggleKey(row.key)"
        @keydown="handleKeydown($event, row.key)"
      >
        <!-- Expand indicator -->
        <span
          class="inline-block text-[10px] text-gray-400 transition-transform"
          :class="isExpanded(row.key) ? 'rotate-90' : ''"
          aria-hidden="true"
        >&#9656;</span>

        <!-- Key name -->
        <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
          {{ row.key }}
        </span>

        <!-- Change type badge -->
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          :class="changeClasses(row.changeType)"
        >
          {{ row.changeType }}
        </span>
      </div>

      <!-- Expanded detail -->
      <div
        v-if="isExpanded(row.key)"
        class="border-t border-gray-200 dark:border-gray-700"
      >
        <!-- Before value -->
        <div
          v-if="row.changeType !== 'added'"
          class="px-3 py-2"
        >
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
            Before
          </p>
          <pre
            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-red-50 p-2 font-mono text-xs leading-relaxed text-red-800 dark:bg-red-950 dark:text-red-200"
          >{{ formatValue(row.before) }}</pre>
        </div>

        <!-- After value -->
        <div
          v-if="row.changeType !== 'removed'"
          class="border-t border-gray-100 px-3 py-2 dark:border-gray-800"
        >
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            After
          </p>
          <pre
            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-emerald-50 p-2 font-mono text-xs leading-relaxed text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          >{{ formatValue(row.after) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
