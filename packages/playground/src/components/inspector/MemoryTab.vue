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

onMounted(() => {
  void memoryStore.fetchNamespaces()
})

function handleSearch(): void {
  void memoryStore.searchRecords(searchInput.value)
}

function handleNamespaceClick(namespace: string): void {
  void memoryStore.fetchNamespace(namespace)
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Search bar -->
    <div class="border-b border-[var(--pg-border)] p-3">
      <div class="flex gap-2">
        <input
          v-model="searchInput"
          type="text"
          placeholder="Search records..."
          class="flex-1 rounded-[var(--pg-radius-sm)] border border-[var(--pg-border)] bg-[var(--pg-surface-raised)] px-3 py-1.5 text-sm text-[var(--pg-text)] placeholder:text-[var(--pg-text-muted)] focus:border-[var(--pg-accent)] focus:outline-none"
          aria-label="Search memory records"
          @keydown.enter="handleSearch"
        >
        <button
          class="rounded-[var(--pg-radius-sm)] bg-[var(--pg-accent)] px-3 py-1.5 text-xs font-medium text-[var(--pg-accent-text)] hover:bg-[var(--pg-accent-hover)]"
          @click="handleSearch"
        >
          Search
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="pg-scrollbar flex flex-1 overflow-y-auto">
      <!-- Namespace list (shown when no namespace is selected and no search) -->
      <div
        v-if="!memoryStore.selectedNamespace && !memoryStore.searchQuery"
        class="flex w-full flex-col"
      >
        <div
          v-if="memoryStore.namespaces.length === 0 && !memoryStore.isLoading"
          class="flex h-32 items-center justify-center"
        >
          <p class="text-sm text-[var(--pg-text-muted)]">
            No memory namespaces found.
          </p>
        </div>

        <button
          v-for="ns in memoryStore.namespaces"
          :key="ns.name"
          class="flex items-center justify-between border-b border-[var(--pg-border-subtle)] px-4 py-3 text-left transition-colors hover:bg-[var(--pg-surface-raised)]"
          @click="handleNamespaceClick(ns.name)"
        >
          <span class="text-sm text-[var(--pg-text)]">{{ ns.name }}</span>
          <span class="text-xs text-[var(--pg-text-muted)]">{{ ns.recordCount }} records</span>
        </button>
      </div>

      <!-- Records display -->
      <div
        v-else
        class="flex w-full flex-col"
      >
        <!-- Back button -->
        <button
          v-if="memoryStore.selectedNamespace"
          class="flex items-center gap-1 border-b border-[var(--pg-border)] px-4 py-2 text-xs text-[var(--pg-accent)] hover:underline"
          @click="memoryStore.clearSelection()"
        >
          &larr; Back to namespaces
        </button>

        <div
          v-if="memoryStore.filteredRecords.length === 0 && !memoryStore.isLoading"
          class="flex h-32 items-center justify-center"
        >
          <p class="text-sm text-[var(--pg-text-muted)]">
            No records found.
          </p>
        </div>

        <div
          v-for="record in memoryStore.filteredRecords"
          :key="record.key"
          class="border-b border-[var(--pg-border-subtle)] px-4 py-3"
        >
          <div class="mb-1 flex items-center gap-2">
            <span class="text-xs font-medium text-[var(--pg-accent)]">{{ record.key }}</span>
            <span
              v-if="record.namespace"
              class="text-[10px] text-[var(--pg-text-muted)]"
            >
              {{ record.namespace }}
            </span>
          </div>
          <pre class="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[var(--pg-radius-sm)] bg-[var(--pg-surface-raised)] p-2 font-mono text-xs text-[var(--pg-text-secondary)]">{{ formatValue(record.value) }}</pre>
        </div>
      </div>
    </div>

    <!-- Loading overlay -->
    <div
      v-if="memoryStore.isLoading"
      class="flex items-center justify-center py-4"
    >
      <span class="text-xs text-[var(--pg-text-muted)]">Loading...</span>
    </div>

    <!-- Error -->
    <div
      v-if="memoryStore.error"
      class="border-t border-[var(--pg-error)] px-4 py-2 text-xs text-[var(--pg-error)]"
      role="alert"
    >
      {{ memoryStore.error }}
    </div>
  </div>
</template>
