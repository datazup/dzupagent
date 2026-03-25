<script setup lang="ts">
/**
 * MemoryTab -- Namespace list, record search, schema viewer,
 * and export/import functionality.
 */
import { onMounted, ref } from 'vue'
import { useMemoryStore } from '../../stores/memory-store.js'
import { useApi } from '../../composables/useApi.js'
import type { MemorySchemaColumn } from '../../types.js'

const memoryStore = useMemoryStore()
const { get, post } = useApi()

const searchInput = ref('')
const namespaceInput = ref('lessons')
const showSchema = ref(false)
const schemaColumns = ref<MemorySchemaColumn[]>([])
const schemaLoading = ref(false)
const exportFormat = ref<'json' | 'arrow'>('json')
const showExport = ref(false)
const exportLoading = ref(false)
const importFile = ref<File | null>(null)
const importMerge = ref<'overwrite' | 'skip' | 'merge'>('skip')
const importLoading = ref(false)
const importMessage = ref<string | null>(null)

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

async function loadSchema(): Promise<void> {
  schemaLoading.value = true
  try {
    const result = await get<{ columns: MemorySchemaColumn[] }>('/api/memory/schema')
    schemaColumns.value = result.columns ?? []
    showSchema.value = true
  } catch {
    schemaColumns.value = []
  } finally {
    schemaLoading.value = false
  }
}

async function handleExport(): Promise<void> {
  exportLoading.value = true
  try {
    let scope: Record<string, string> | undefined
    try { scope = JSON.parse(memoryStore.scopeJson ?? '{}') as Record<string, string> } catch { /* skip */ }

    const result = await post<{ data: unknown }>('/api/memory/export', {
      format: exportFormat.value,
      namespace: namespaceInput.value || undefined,
      scope,
    })

    const blob = new Blob(
      [JSON.stringify(result.data, null, 2)],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `memory-export-${namespaceInput.value || 'all'}.${exportFormat.value === 'json' ? 'json' : 'arrow'}`
    a.click()
    URL.revokeObjectURL(url)
    showExport.value = false
  } catch {
    // export error handled silently
  } finally {
    exportLoading.value = false
  }
}

function handleFileSelect(event: Event): void {
  const target = event.target as HTMLInputElement
  importFile.value = target.files?.[0] ?? null
}

async function handleImport(): Promise<void> {
  if (!importFile.value) return
  importLoading.value = true
  importMessage.value = null
  try {
    const text = await importFile.value.text()
    const data = JSON.parse(text) as unknown
    await post('/api/memory/import', {
      format: 'json',
      mergeStrategy: importMerge.value,
      data,
    })
    importMessage.value = 'Import successful'
    importFile.value = null
    if (memoryStore.selectedNamespace) {
      void memoryStore.fetchNamespace(memoryStore.selectedNamespace)
    }
  } catch (err: unknown) {
    importMessage.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    importLoading.value = false
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString() } catch { return iso }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Controls -->
    <div class="border-b border-pg-border p-3">
      <!-- Namespace + buttons row -->
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
        <button
          class="rounded-pg-sm border border-pg-border px-2 py-1 text-[10px] text-pg-text-muted hover:text-pg-text-secondary"
          :disabled="schemaLoading"
          @click="loadSchema"
        >
          Schema
        </button>
        <button
          class="rounded-pg-sm border border-pg-border px-2 py-1 text-[10px] text-pg-text-muted hover:text-pg-text-secondary"
          @click="showExport = !showExport"
        >
          Export
        </button>
      </div>

      <!-- Scope JSON -->
      <div class="mb-2">
        <input
          v-model="memoryStore.scopeJson"
          type="text"
          placeholder="Scope JSON (e.g. {&quot;tenant&quot;:&quot;default&quot;,&quot;project&quot;:&quot;default&quot;})"
          class="pg-input w-full font-mono text-xs"
          aria-label="Memory scope JSON"
        >
      </div>

      <!-- Search -->
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

      <!-- Export panel -->
      <div
        v-if="showExport"
        class="mt-2 rounded-pg-sm border border-pg-border bg-pg-surface-raised p-3"
      >
        <p class="mb-2 text-xs font-medium text-pg-text-secondary">
          Export Memory
        </p>
        <div class="mb-2 flex items-center gap-3">
          <label class="flex items-center gap-1 text-xs text-pg-text-secondary">
            <input
              v-model="exportFormat"
              type="radio"
              value="json"
            >
            JSON
          </label>
          <label class="flex items-center gap-1 text-xs text-pg-text-secondary">
            <input
              v-model="exportFormat"
              type="radio"
              value="arrow"
            >
            Arrow IPC
          </label>
        </div>
        <button
          class="pg-btn-accent"
          :disabled="exportLoading"
          @click="handleExport"
        >
          {{ exportLoading ? 'Exporting...' : 'Download' }}
        </button>
      </div>

      <!-- Import panel -->
      <div class="mt-2 rounded-pg-sm border border-pg-border bg-pg-surface-raised p-3">
        <p class="mb-2 text-xs font-medium text-pg-text-secondary">
          Import Memory
        </p>
        <div class="mb-2 flex items-center gap-2">
          <input
            type="file"
            accept=".json"
            class="text-xs text-pg-text-secondary"
            @change="handleFileSelect"
          >
          <select
            v-model="importMerge"
            class="pg-input text-xs"
          >
            <option value="skip">
              Skip existing
            </option>
            <option value="overwrite">
              Overwrite
            </option>
            <option value="merge">
              Merge
            </option>
          </select>
        </div>
        <button
          class="pg-btn-accent"
          :disabled="!importFile || importLoading"
          @click="handleImport"
        >
          {{ importLoading ? 'Importing...' : 'Import' }}
        </button>
        <p
          v-if="importMessage"
          class="mt-1 text-xs"
          :class="importMessage.includes('success') ? 'text-pg-success' : 'text-pg-error'"
        >
          {{ importMessage }}
        </p>
      </div>
    </div>

    <!-- Schema viewer -->
    <div
      v-if="showSchema && schemaColumns.length > 0"
      class="border-b border-pg-border px-4 py-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-xs font-semibold text-pg-text-secondary">
          Memory Schema ({{ schemaColumns.length }} columns)
        </h3>
        <button
          class="text-[10px] text-pg-text-muted hover:text-pg-text"
          @click="showSchema = false"
        >
          Close
        </button>
      </div>
      <div class="max-h-48 overflow-auto">
        <table class="w-full text-[10px]">
          <thead>
            <tr class="border-b border-pg-border-subtle">
              <th class="pb-1 text-left font-medium text-pg-text-muted">
                Name
              </th>
              <th class="pb-1 text-left font-medium text-pg-text-muted">
                Type
              </th>
              <th class="pb-1 text-left font-medium text-pg-text-muted">
                Nullable
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="col in schemaColumns"
              :key="col.name"
              class="border-b border-pg-border-subtle/50"
            >
              <td class="py-0.5 font-mono text-pg-accent">
                {{ col.name }}
              </td>
              <td class="py-0.5 text-pg-text-secondary">
                {{ col.type }}
              </td>
              <td class="py-0.5 text-pg-text-muted">
                {{ col.nullable ? 'yes' : 'no' }}
              </td>
            </tr>
          </tbody>
        </table>
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
          <div class="mb-1 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-pg-accent">{{ record.key }}</span>
              <span
                v-if="record.namespace"
                class="text-[10px] text-pg-text-muted"
              >
                {{ record.namespace }}
              </span>
            </div>
            <span
              v-if="record.updatedAt || record.createdAt"
              class="text-[10px] text-pg-text-muted"
            >
              {{ formatDate(record.updatedAt ?? record.createdAt) }}
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
