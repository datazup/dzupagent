<script setup lang="ts">
/**
 * MemoryTab -- Namespace list, record search, and record display.
 *
 * Allows browsing memory namespaces and searching records.
 */
import { onMounted, ref } from 'vue'
import { useMemoryStore } from '../../stores/memory-store.js'

const memoryStore = useMemoryStore()
const searchInput = ref('')
const namespaceInput = ref('lessons')

onMounted(() => {
  if (!memoryStore.scopeJson) {
    memoryStore.scopeJson = '{"tenant":"default","project":"default"}'
  }
})

function handleSearch(): void {
  void memoryStore.searchRecords(searchInput.value)
}

function handleNamespaceLoad(namespace: string): void {
  namespaceInput.value = namespace
  searchInput.value = ''
  void memoryStore.fetchNamespace(namespace)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Controls -->
    <div class="border-b border-pg-border p-3">
      <div class="mb-2 flex gap-2">
        <input
          v-model="namespaceInput"
          type="text"
          placeholder="Namespace (e.g. lessons)"
          class="pg-input w-1/2"
          aria-label="Memory namespace"
          @keydown.enter="handleNamespaceLoad(namespaceInput)"
        >
        <button
          class="pg-btn-accent"
          @click="handleNamespaceLoad(namespaceInput)"
        >
          Load
        </button>
      </div>
      <div class="mb-2">
        <input
          v-model="memoryStore.scopeJson"
          type="text"
          placeholder='Scope JSON (e.g. {"tenant":"default","project":"default"})'
          class="pg-input w-full font-mono text-xs"
          aria-label="Memory scope JSON"
        >
      </div>
      <div class="flex gap-2">
        <input
          v-model="searchInput"
          type="text"
          placeholder="Search in selected namespace..."
          class="pg-input flex-1"
          aria-label="Search memory records"
          @keydown.enter="handleSearch"
        >
        <button
          class="pg-btn-accent"
          @click="handleSearch"
        >
          Search
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="pg-scrollbar flex flex-1 overflow-y-auto">
      <div class="flex w-full flex-col">
        <div
          v-if="memoryStore.namespaces.length > 0"
          class="flex flex-wrap gap-2 border-b border-pg-border px-4 py-2"
        >
          <span class="text-[10px] text-pg-text-muted">Recent:</span>
          <button
            v-for="ns in memoryStore.namespaces"
            :key="ns.name"
            class="rounded-sm bg-pg-surface-raised px-2 py-0.5 text-[10px] text-pg-text-secondary hover:text-pg-text"
            @click="handleNamespaceLoad(ns.name)"
          >
            {{ ns.name }} ({{ ns.recordCount }})
          </button>
        </div>

        <div
          v-if="memoryStore.filteredRecords.length === 0 && !memoryStore.isLoading"
          class="flex h-32 items-center justify-center"
        >
          <p class="text-sm text-pg-text-muted">
            Load a namespace to browse records.
          </p>
        </div>

        <div
          v-for="record in memoryStore.filteredRecords"
          :key="record.key"
          class="border-b border-pg-border-subtle px-4 py-3"
        >
          <div class="mb-1 flex items-center gap-2">
            <span class="text-xs font-medium text-pg-accent">{{ record.key }}</span>
            <span
              v-if="record.namespace"
              class="text-[10px] text-pg-text-muted"
            >
              {{ record.namespace }}
            </span>
          </div>
          <pre class="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-2 font-mono text-xs text-pg-text-secondary">{{ formatValue(record.value) }}</pre>
        </div>
      </div>
    </div>

    <!-- Loading overlay -->
    <div
      v-if="memoryStore.isLoading"
      class="flex items-center justify-center py-4"
    >
      <span class="text-xs text-pg-text-muted">Loading...</span>
    </div>

    <!-- Error -->
    <div
      v-if="memoryStore.error"
      class="border-t border-pg-error px-4 py-2 text-xs text-pg-error"
      role="alert"
    >
      {{ memoryStore.error }}
    </div>
  </div>
</template>
