<script setup lang="ts">
/**
 * InspectorPanel -- Tabbed container for Trace, Memory, Config, History, and Tools tabs.
 *
 * Uses a reactive tab state to switch between inspector views.
 */
import { ref } from 'vue'
import TraceTab from './TraceTab.vue'
import MemoryTab from './MemoryTab.vue'
import ConfigTab from './ConfigTab.vue'
import HistoryTab from './HistoryTab.vue'
import ToolStatsTab from './ToolStatsTab.vue'

type TabId = 'trace' | 'memory' | 'config' | 'history' | 'tools'

interface Tab {
  id: TabId
  label: string
}

const tabs: Tab[] = [
  { id: 'trace', label: 'Trace' },
  { id: 'memory', label: 'Memory' },
  { id: 'config', label: 'Config' },
  { id: 'history', label: 'History' },
  { id: 'tools', label: 'Tools' },
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
      class="flex gap-1 overflow-x-auto border-b border-pg-border pg-surface-glass px-2 py-2"
      role="tablist"
      aria-label="Inspector tabs"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`panel-${tab.id}`"
        class="rounded-[10px] border px-3 py-1.5 text-xs font-medium transition-colors"
        :class="activeTab === tab.id
          ? 'border-pg-accent bg-pg-accent/10 text-pg-text'
          : 'border-transparent text-pg-text-muted hover:border-pg-border hover:bg-pg-surface-raised hover:text-pg-text-secondary'"
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
      <div
        v-show="activeTab === 'tools'"
        :id="`panel-tools`"
        role="tabpanel"
        aria-label="Tool stats panel"
        class="h-full"
      >
        <ToolStatsTab />
      </div>
    </div>
  </div>
</template>
