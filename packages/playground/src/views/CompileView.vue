<script setup lang="ts">
/**
 * CompileView -- Developer utility for observing flow-compiler lifecycle
 * events in real time.
 *
 * The user pastes a `compileId` (UUID emitted by
 * `@dzupagent/flow-compiler` when `forwardInnerEvents` is enabled); the page
 * subscribes the shared playground WebSocket to that compile and renders
 * stage-by-stage progress via {@link CompileProgress}.
 */
import { ref } from 'vue'
import CompileProgress from '../components/CompileProgress.vue'

const input = ref('')
const activeCompileId = ref<string | null>(null)

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
      class="flex items-center gap-2"
      @submit.prevent="onSubmit"
    >
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
    </form>

    <CompileProgress :compile-id="activeCompileId" />
  </div>
</template>
