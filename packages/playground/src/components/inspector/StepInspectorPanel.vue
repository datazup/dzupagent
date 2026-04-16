<script setup lang="ts">
/**
 * StepInspectorPanel -- reusable panel for inspecting step type metadata,
 * schemas, and execution traces.
 */

interface TraceEntry {
  timestamp: string
  event: string
  data?: unknown
}

interface Props {
  stepType: string
  configSchema?: object
  outputSchema?: object
  executionTrace?: TraceEntry[]
  playgroundComponent?: string
}

const props = defineProps<Props>()

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}
</script>

<template>
  <div class="rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm">
    <h3 class="text-base font-semibold text-pg-text" data-testid="step-type-heading">
      {{ props.stepType }}
    </h3>

    <!-- Config schema -->
    <div v-if="props.configSchema" class="mt-4" data-testid="config-schema-section">
      <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
        Config Schema
      </div>
      <pre class="mt-2 overflow-auto rounded-pg border border-pg-border bg-pg-surface-raised p-3 font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(props.configSchema, null, 2) }}</pre>
    </div>

    <!-- Output schema -->
    <div v-if="props.outputSchema" class="mt-4" data-testid="output-schema-section">
      <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
        Output Schema
      </div>
      <pre class="mt-2 overflow-auto rounded-pg border border-pg-border bg-pg-surface-raised p-3 font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(props.outputSchema, null, 2) }}</pre>
    </div>

    <!-- Execution trace -->
    <div v-if="props.executionTrace && props.executionTrace.length > 0" class="mt-4" data-testid="execution-trace-section">
      <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
        Execution Trace
      </div>
      <div class="mt-2 space-y-2">
        <div
          v-for="(entry, idx) in props.executionTrace"
          :key="idx"
          class="flex items-start gap-3 rounded-pg border border-pg-border bg-pg-surface-raised p-3"
        >
          <div class="shrink-0 text-xs text-pg-text-muted">
            {{ formatDate(entry.timestamp) }}
          </div>
          <div class="text-sm text-pg-text">
            {{ entry.event }}
          </div>
        </div>
      </div>
    </div>

    <!-- Playground component note -->
    <div v-if="props.playgroundComponent" class="mt-4" data-testid="playground-component-section">
      <div class="text-xs font-semibold uppercase tracking-wide text-pg-text-muted">
        Custom Component
      </div>
      <p class="mt-1 text-sm text-pg-text-secondary">
        {{ props.playgroundComponent }}
      </p>
    </div>
  </div>
</template>
