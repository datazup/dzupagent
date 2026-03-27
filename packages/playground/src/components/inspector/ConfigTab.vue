<script setup lang="ts">
/**
 * ConfigTab -- View and edit the selected agent's configuration.
 *
 * Shows full agent detail from GET /api/agents/:id and supports
 * inline editing of instructions, tools, guardrails, and approval mode.
 */
import { computed, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat-store.js'
import { useAgentStore } from '../../stores/agent-store.js'
import type { AgentDetail } from '../../types.js'

const chatStore = useChatStore()
const agentStore = useAgentStore()

const agent = ref<AgentDetail | null>(null)
const isEditing = ref(false)

// Edit form state
const editInstructions = ref('')
const editApproval = ref<'auto' | 'required' | 'conditional'>('auto')
const editTools = ref('')

const agentId = computed(() => chatStore.currentAgentId)

watch(agentId, async (id) => {
  if (!id) {
    agent.value = null
    return
  }
  const detail = await agentStore.fetchAgent(id)
  agent.value = detail
}, { immediate: true })

function startEditing(): void {
  if (!agent.value) return
  editInstructions.value = agent.value.instructions
  editApproval.value = agent.value.approval ?? 'auto'
  editTools.value = agent.value.tools?.join(', ') ?? ''
  isEditing.value = true
}

async function saveEdits(): Promise<void> {
  if (!agent.value) return
  const tools = editTools.value.split(',').map((t) => t.trim()).filter(Boolean)
  const result = await agentStore.updateAgent(agent.value.id, {
    instructions: editInstructions.value,
    approval: editApproval.value,
    tools: tools.length > 0 ? tools : undefined,
  })
  if (result) {
    agent.value = result
    isEditing.value = false
  }
}

function cancelEditing(): void {
  isEditing.value = false
}
</script>

<template>
  <div class="pg-scrollbar flex flex-col gap-4 overflow-y-auto p-4">
    <!-- No agent selected -->
    <div
      v-if="!agent"
      class="flex h-32 items-center justify-center"
    >
      <p class="text-sm text-pg-text-muted">
        Select an agent to view its configuration.
      </p>
    </div>

    <template v-if="agent">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div>
          <h3 class="mb-1 text-sm font-semibold text-pg-text">
            {{ agent.name }}
          </h3>
          <p
            v-if="agent.description"
            class="mb-2 text-xs text-pg-text-secondary"
          >
            {{ agent.description }}
          </p>
          <div class="flex gap-2">
            <span class="pg-badge">{{ agent.modelTier }}</span>
            <span
              class="pg-badge"
              :class="agent.active
                ? 'bg-pg-success/20 text-pg-success'
                : ''"
            >
              {{ agent.active ? 'Active' : 'Inactive' }}
            </span>
            <span
              v-if="agent.approval"
              class="pg-badge"
            >
              approval: {{ agent.approval }}
            </span>
          </div>
        </div>
        <button
          v-if="!isEditing"
          class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary hover:bg-pg-surface-raised hover:text-pg-text"
          @click="startEditing"
        >
          Edit
        </button>
      </div>

      <!-- Agent ID -->
      <div>
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Agent ID</label>
        <code class="block rounded-pg-sm bg-pg-surface-raised px-3 py-2 font-mono text-xs text-pg-text-secondary">
          {{ agent.id }}
        </code>
      </div>

      <!-- Instructions (view/edit) -->
      <div>
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Instructions</label>
        <textarea
          v-if="isEditing"
          v-model="editInstructions"
          rows="6"
          class="pg-input w-full resize-y font-mono text-xs"
        />
        <pre
          v-else
          class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-3 font-mono text-xs text-pg-text-secondary"
        >{{ agent.instructions }}</pre>
      </div>

      <!-- Tools (view/edit) -->
      <div v-if="agent.tools?.length || isEditing">
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Tools</label>
        <input
          v-if="isEditing"
          v-model="editTools"
          type="text"
          class="pg-input w-full text-xs"
          placeholder="search, code_edit, file_read"
        >
        <div
          v-else
          class="flex flex-wrap gap-1.5"
        >
          <span
            v-for="tool in agent.tools"
            :key="tool"
            class="rounded-full bg-pg-success/10 px-2 py-0.5 text-[10px] font-medium text-pg-success"
          >
            {{ tool }}
          </span>
        </div>
      </div>

      <!-- Approval (view/edit) -->
      <div v-if="isEditing">
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Approval Mode</label>
        <select
          v-model="editApproval"
          class="pg-input w-full text-xs"
        >
          <option value="auto">
            Auto
          </option>
          <option value="required">
            Required
          </option>
          <option value="conditional">
            Conditional
          </option>
        </select>
      </div>

      <!-- Guardrails -->
      <div v-if="agent.guardrails && Object.keys(agent.guardrails).length > 0">
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Guardrails</label>
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-3 font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(agent.guardrails, null, 2) }}</pre>
      </div>

      <!-- Metadata -->
      <div v-if="agent.metadata && Object.keys(agent.metadata).length > 0">
        <label class="mb-1 block text-xs font-medium text-pg-text-muted">Metadata</label>
        <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-pg-sm bg-pg-surface-raised p-3 font-mono text-xs text-pg-text-secondary">{{ JSON.stringify(agent.metadata, null, 2) }}</pre>
      </div>

      <!-- Error -->
      <div
        v-if="agentStore.error"
        class="text-xs text-pg-error"
      >
        {{ agentStore.error }}
      </div>

      <!-- Edit actions -->
      <div
        v-if="isEditing"
        class="flex gap-2"
      >
        <button
          class="rounded-pg bg-pg-accent px-4 py-2 text-xs font-medium text-pg-accent-text hover:bg-pg-accent-hover disabled:opacity-50"
          :disabled="agentStore.isSaving"
          @click="saveEdits"
        >
          {{ agentStore.isSaving ? 'Saving...' : 'Save' }}
        </button>
        <button
          class="rounded-pg border border-pg-border px-4 py-2 text-xs text-pg-text-secondary hover:bg-pg-surface-raised"
          @click="cancelEditing"
        >
          Cancel
        </button>
      </div>
    </template>
  </div>
</template>
