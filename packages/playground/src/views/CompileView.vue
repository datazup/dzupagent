<script setup lang="ts">
/**
 * CompileView -- Developer utility for observing flow-compiler lifecycle
 * events in real time.
 *
 * The user pastes a `compileId` (UUID emitted by
 * `@dzupagent/flow-compiler` when `forwardInnerEvents` is enabled); the page
 * subscribes the shared playground WebSocket to that compile and renders
 * stage-by-stage progress via {@link CompileProgress}.
 *
 * The optional "Subprocess mode" toggle controls whether the playground
 * appends `?subprocess=true` to the `POST /compile` request URL. When
 * enabled, the server routes the request through the SpawnCompilerBridge
 * (dzupagent-compile child process). The computed URL is reflected in
 * `compileUrl` and surfaced in the UI so users can copy it for manual
 * requests.
 */
import { computed, ref } from 'vue'
import CompileProgress from '../components/CompileProgress.vue'

const input = ref('')
const activeCompileId = ref<string | null>(null)
const subprocessMode = ref(false)

/** POST /compile URL with the subprocess flag appended when enabled. */
const compileUrl = computed<string>(() =>
  subprocessMode.value ? '/compile?subprocess=true' : '/compile',
)

function onSubmit(): void {
  const trimmed = input.value.trim()
  activeCompileId.value = trimmed.length > 0 ? trimmed : null
}

function onClear(): void {
  input.value = ''
  activeCompileId.value = null
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
    <header class="flex flex-col gap-1">
      <h1 class="text-lg font-semibold text-pg-text">
        Flow Compile Progress
      </h1>
      <p class="text-xs text-pg-text-muted">
        Paste a compileId to stream flow-compiler lifecycle events over the
        shared WebSocket connection.
      </p>
    </header>

    <form
      class="flex flex-col gap-2"
      @submit.prevent="onSubmit"
    >
      <div class="flex items-center gap-2">
        <label class="sr-only" for="compile-id-input">Compile ID</label>
        <input
          id="compile-id-input"
          v-model="input"
          type="text"
          placeholder="compileId (UUID)"
          class="flex-1 rounded-[10px] border border-pg-border bg-pg-surface px-3 py-2 text-sm text-pg-text placeholder:text-pg-text-muted focus:border-pg-accent focus:outline-none"
        >
        <button
          type="submit"
          class="rounded-[10px] bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text hover:opacity-90 disabled:opacity-50"
          :disabled="input.trim().length === 0"
        >
          Subscribe
        </button>
        <button
          v-if="activeCompileId"
          type="button"
          class="rounded-[10px] border border-pg-border px-4 py-2 text-sm font-medium text-pg-text-secondary hover:bg-pg-surface-raised"
          @click="onClear"
        >
          Clear
        </button>
      </div>
      <div class="flex items-center gap-2 text-xs text-pg-text-muted">
        <label
          for="compile-subprocess-toggle"
          class="inline-flex cursor-pointer items-center gap-2 select-none"
        >
          <input
            id="compile-subprocess-toggle"
            v-model="subprocessMode"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border border-pg-border bg-pg-surface text-pg-accent focus:ring-pg-accent"
          >
          <span>Subprocess mode</span>
        </label>
        <span
          class="font-mono text-[11px] text-pg-text-muted"
          data-testid="compile-url"
        >{{ compileUrl }}</span>
      </div>
    </form>

    <CompileProgress :compile-id="activeCompileId" />
  </div>
</template>
