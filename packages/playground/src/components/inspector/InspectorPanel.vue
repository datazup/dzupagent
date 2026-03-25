<script setup lang="ts">
/**
 * InspectorPanel -- Tabbed container for Trace, Memory, Config, and History tabs.
 *
 * Uses a reactive tab state to switch between inspector views.
 */
import { ref } from 'vue'
import TraceTab from './TraceTab.vue'
import MemoryTab from './MemoryTab.vue'
import ConfigTab from './ConfigTab.vue'
import HistoryTab from './HistoryTab.vue'

type TabId = 'trace' | 'memory' | 'config' | 'history'

interface Tab {
  id: TabId
  label: string
}

const tabs: Tab[] = [
  { id: 'trace', label: 'Trace' },
  { id: 'memory', label: 'Memory' },
  { id: 'config', label: 'Config' },
  { id: 'history', label: 'History' },
]

const activeTab = ref<TabId>('trace')

function selectTab(tabId: TabId): void {
  activeTab.value = tabId
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Tab bar -->
    <div
      class="flex border-b border-[var(--pg-border)] bg-[var(--pg-surface)]"
      role="tablist"
      aria-label="Inspector tabs"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`panel-${tab.id}`"
        class="border-b-2 px-4 py-2 text-xs font-medium transition-colors"
        :class="activeTab === tab.id
          ? 'border-[var(--pg-accent)] text-[var(--pg-text)]'
          : 'border-transparent text-[var(--pg-text-muted)] hover:text-[var(--pg-text-secondary)]'"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Tab panels -->
    <div class="flex-1 overflow-hidden">
      <div
        v-show="activeTab === 'trace'"
        :id="`panel-trace`"
        role="tabpanel"
        aria-label="Trace panel"
        class="h-full"
      >
        <TraceTab />
      </div>
      <div
        v-show="activeTab === 'memory'"
        :id="`panel-memory`"
        role="tabpanel"
        aria-label="Memory panel"
        class="h-full"
      >
        <MemoryTab />
      </div>
      <div
        v-show="activeTab === 'config'"
        :id="`panel-config`"
        role="tabpanel"
        aria-label="Config panel"
        class="h-full"
      >
        <ConfigTab />
      </div>
      <div
        v-show="activeTab === 'history'"
        :id="`panel-history`"
        role="tabpanel"
        aria-label="History panel"
        class="h-full"
      >
        <HistoryTab />
      </div>
    </div>
  </div>
</template>
