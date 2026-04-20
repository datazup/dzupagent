<script setup lang="ts">
/**
 * CompileProgress -- Live progress for a single flow-compiler compile stream.
 *
 * Renders the six compile stages (started, parsed, shape_validated,
 * semantic_resolved, lowered, completed) as an ordered checklist driven by
 * {@link useCompileStream}. Each row shows status, elapsed ms, and a
 * compact summary of stage-specific facts.
 */
import { computed } from 'vue'
import { useCompileStream } from '../composables/useCompileStream.js'
import type { CompileStage, CompileStageStatus } from '../types.js'

interface Props {
  /** Active compileId. When it changes, the component re-subscribes. */
  compileId: string | null
}

const props = defineProps<Props>()

const { run, isRunning, subscribe, unsubscribe, reset } = useCompileStream()

const stageLabels: Record<CompileStage, string> = {
  started: 'Started',
  parsed: 'Parsed',
  shape_validated: 'Shape validated',
  semantic_resolved: 'Semantic resolved',
  lowered: 'Lowered',
  completed: 'Completed',
}

function statusDotClass(status: CompileStageStatus): string {
  switch (status) {
    case 'active':
      return 'bg-pg-warning animate-pulse'
    case 'done':
      return 'bg-pg-success'
    case 'failed':
      return 'bg-pg-error'
    default:
      return 'bg-pg-text-muted/40'
  }
}

function statusLabel(status: CompileStageStatus): string {
  switch (status) {
    case 'active':
      return 'Running'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return 'Pending'
  }
}

function formatMs(ms: number | undefined): string {
  if (typeof ms !== 'number') return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

const headerStatus = computed(() => {
  switch (run.value.status) {
    case 'idle':
      return { label: 'Idle', cls: 'bg-pg-text-muted/40' }
    case 'subscribing':
      return { label: 'Subscribing', cls: 'bg-pg-warning animate-pulse' }
    case 'running':
      return { label: 'Running', cls: 'bg-pg-warning animate-pulse' }
    case 'completed':
      return { label: 'Completed', cls: 'bg-pg-success' }
    case 'failed':
      return { label: 'Failed', cls: 'bg-pg-error' }
  }
})

function detailsText(details: Record<string, unknown> | undefined): string {
  if (!details) return ''
  return Object.entries(details)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' · ')
}

// Auto (re)subscribe whenever the prop compileId changes.
import { watch } from 'vue'
watch(
  () => props.compileId,
  (id, prev) => {
    if (prev && prev !== id) unsubscribe()
    if (id && id.trim().length > 0) subscribe(id)
    else reset()
  },
  { immediate: true },
)
</script>

<template>
  <section
    class="rounded-[12px] border border-pg-border bg-pg-surface/95 p-4 text-pg-text"
    role="region"
    aria-label="Flow compile progress"
  >
    <header class="mb-3 flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span
          :class="headerStatus.cls"
          class="inline-block h-2.5 w-2.5 rounded-full"
          aria-hidden="true"
        />
        <h3 class="text-sm font-semibold">
          Compile
          <span
            v-if="run.compileId"
            class="ml-1 text-xs font-normal text-pg-text-muted"
          >
            {{ run.compileId }}
          </span>
        </h3>
        <span class="text-xs text-pg-text-muted">{{ headerStatus.label }}</span>
      </div>
      <div
        v-if="run.target || typeof run.durationMs === 'number'"
        class="text-xs text-pg-text-muted"
      >
        <span v-if="run.target">target: {{ run.target }}</span>
        <span
          v-if="typeof run.durationMs === 'number'"
          class="ml-2"
        >
          {{ formatMs(run.durationMs) }}
        </span>
      </div>
    </header>

    <ol
      class="space-y-1.5"
      role="list"
      :aria-busy="isRunning"
    >
      <li
        v-for="stage in run.stages"
        :key="stage.stage"
        class="flex items-start gap-3 rounded-[8px] border border-transparent px-2 py-1.5"
        :class="{
          'border-pg-border bg-pg-surface-raised': stage.status === 'active',
        }"
      >
        <span
          :class="statusDotClass(stage.status)"
          class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-medium">
              {{ stageLabels[stage.stage] }}
            </span>
            <span class="text-[11px] text-pg-text-muted">
              {{ statusLabel(stage.status) }}
              <template v-if="stage.durationMs !== undefined">
                · {{ formatMs(stage.durationMs) }}
              </template>
            </span>
          </div>
          <p
            v-if="detailsText(stage.details)"
            class="mt-0.5 truncate text-[11px] text-pg-text-muted"
          >
            {{ detailsText(stage.details) }}
          </p>
          <p
            v-if="typeof stage.errorCount === 'number' && stage.errorCount > 0"
            class="mt-0.5 text-[11px] text-pg-error"
          >
            {{ stage.errorCount }} error(s)
          </p>
        </div>
      </li>
    </ol>

    <footer
      v-if="run.status === 'failed' && run.failure"
      class="mt-3 rounded-[8px] border border-pg-error/40 bg-pg-error/10 px-3 py-2 text-xs text-pg-error"
      role="alert"
    >
      Compile failed at stage {{ run.failure.stage }}
      ({{ run.failure.errorCount }} error(s), {{ formatMs(run.failure.durationMs) }}).
    </footer>
    <footer
      v-else-if="run.status === 'completed'"
      class="mt-3 text-xs text-pg-text-muted"
    >
      <template v-if="run.warningCount > 0">
        {{ run.warningCount }} warning(s) ·
      </template>
      Completed in {{ formatMs(run.durationMs) }}.
    </footer>
  </section>
</template>
