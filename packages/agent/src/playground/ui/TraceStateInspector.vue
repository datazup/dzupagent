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
import {
  computeDiffRows,
  formatValue,
  getTraceChangeStyles,
  traceToneStyles,
  traceUiStyles,
} from './utils.js'

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

/** Computed diff rows sorted by change type then key name */
const diffRows = computed(() => computeDiffRows(props.stateBefore, props.stateAfter))

/** Count of changed keys */
const changeCount = computed(() =>
  diffRows.value.filter(r => r.changeType !== 'unchanged').length,
)

/** Badge classes per change type */
function changeClasses(changeType: ChangeType): string {
  return getTraceChangeStyles(changeType).badge
}

/** Row border classes per change type */
function rowBorderClasses(changeType: ChangeType): string {
  return getTraceChangeStyles(changeType).borderLeft
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
      <h3 class="text-sm font-semibold" :class="traceUiStyles.textPrimary">
        State Changes
      </h3>
      <span class="text-xs" :class="traceUiStyles.textMuted">
        {{ changeCount }} change{{ changeCount === 1 ? '' : 's' }} across {{ diffRows.length }} key{{ diffRows.length === 1 ? '' : 's' }}
      </span>
    </div>

    <!-- Empty state -->
    <div
      v-if="diffRows.length === 0"
      class="flex items-center justify-center py-6"
      :class="traceUiStyles.panelSubtle"
    >
      <p class="text-sm" :class="traceUiStyles.textMuted">
        No state data to compare.
      </p>
    </div>

    <!-- Diff rows -->
    <div
      v-for="row in diffRows"
      :key="row.key"
      class="overflow-hidden rounded-md border border-l-4"
      :class="[traceUiStyles.divider, rowBorderClasses(row.changeType)]"
    >
      <!-- Row header action -->
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        :class="traceUiStyles.interactiveMuted"
        :aria-expanded="isExpanded(row.key)"
        :aria-label="`Key ${row.key}, ${row.changeType}`"
        @click="toggleKey(row.key)"
      >
        <!-- Expand indicator -->
        <span
          class="inline-block text-[10px] transition-transform"
          :class="[traceUiStyles.textDisabled, isExpanded(row.key) ? 'rotate-90' : '']"
          aria-hidden="true"
        >&#9656;</span>

        <!-- Key name -->
        <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium" :class="traceUiStyles.textPrimary">
          {{ row.key }}
        </span>

        <!-- Change type badge -->
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          :class="changeClasses(row.changeType)"
        >
          {{ row.changeType }}
        </span>
      </button>

      <!-- Expanded detail -->
      <div
        v-if="isExpanded(row.key)"
        class="border-t"
        :class="traceUiStyles.divider"
      >
        <!-- Before value -->
        <div
          v-if="row.changeType !== 'added'"
          class="px-3 py-2"
        >
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider" :class="traceToneStyles.danger.text">
            Before
          </p>
          <pre
            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs leading-relaxed"
            :class="[traceToneStyles.danger.panel, traceToneStyles.danger.textStrong]"
          >{{ formatValue(row.before) }}</pre>
        </div>

        <!-- After value -->
        <div
          v-if="row.changeType !== 'removed'"
          class="border-t px-3 py-2"
          :class="traceUiStyles.dividerSubtle"
        >
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider" :class="traceToneStyles.success.text">
            After
          </p>
          <pre
            class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs leading-relaxed"
            :class="[traceToneStyles.success.panel, traceToneStyles.success.textStrong]"
          >{{ formatValue(row.after) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
