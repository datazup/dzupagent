<script setup lang="ts">
/**
 * AgentsView -- Agent management dashboard with list + create/edit modal.
 *
 * Full CRUD for agent definitions: create, view, edit instructions/config,
 * and soft-delete agents.
 */
import { onMounted, ref, computed } from 'vue'
import { useAgentStore } from '../stores/agent-store.js'
import type { AgentCreateInput, AgentUpdateInput, AgentDetail } from '../types.js'

const agentStore = useAgentStore()

// ── Modal state ─────────────────────────────────────
const showModal = ref(false)
const editingAgent = ref<AgentDetail | null>(null)
const confirmDeleteId = ref<string | null>(null)

const formName = ref('')
const formDescription = ref('')
const formInstructions = ref('')
const formModelTier = ref('sonnet')
const formApproval = ref<'auto' | 'required' | 'conditional'>('auto')
const formTools = ref('')

const isEditing = computed(() => editingAgent.value !== null)
const modalTitle = computed(() => isEditing.value ? 'Edit Agent' : 'Create Agent')

function resetForm(): void {
  formName.value = ''
  formDescription.value = ''
  formInstructions.value = ''
  formModelTier.value = 'sonnet'
  formApproval.value = 'auto'
  formTools.value = ''
  editingAgent.value = null
}

function openCreate(): void {
  resetForm()
  showModal.value = true
}

async function openEdit(id: string): Promise<void> {
  const agent = await agentStore.fetchAgent(id)
  if (!agent) return
  editingAgent.value = agent
  formName.value = agent.name
  formDescription.value = agent.description ?? ''
  formInstructions.value = agent.instructions
  formModelTier.value = agent.modelTier
  formApproval.value = agent.approval ?? 'auto'
  formTools.value = agent.tools?.join(', ') ?? ''
  showModal.value = true
}

async function handleSave(): Promise<void> {
  const tools = formTools.value.split(',').map((t) => t.trim()).filter(Boolean)

  if (isEditing.value && editingAgent.value) {
    const input: AgentUpdateInput = {
      name: formName.value,
      description: formDescription.value || undefined,
      instructions: formInstructions.value,
      modelTier: formModelTier.value,
      approval: formApproval.value,
      tools: tools.length > 0 ? tools : undefined,
    }
    const result = await agentStore.updateAgent(editingAgent.value.id, input)
    if (result) {
      showModal.value = false
      resetForm()
    }
  } else {
    const input: AgentCreateInput = {
      name: formName.value,
      instructions: formInstructions.value,
      modelTier: formModelTier.value,
      description: formDescription.value || undefined,
      approval: formApproval.value,
      tools: tools.length > 0 ? tools : undefined,
    }
    const result = await agentStore.createAgent(input)
    if (result) {
      showModal.value = false
      resetForm()
    }
  }
}

async function handleDelete(id: string): Promise<void> {
  const success = await agentStore.deleteAgent(id)
  if (success) {
    confirmDeleteId.value = null
  }
}

onMounted(() => {
  void agentStore.fetchAgents()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <header class="flex items-center justify-between border-b border-pg-border pg-surface-glass px-6 py-4">
      <div>
        <h1 class="text-base font-semibold text-pg-text">
          Agents
        </h1>
        <p class="text-xs text-pg-text-muted">
          {{ agentStore.activeCount }} active of {{ agentStore.agentCount }} total
        </p>
      </div>
      <div class="flex items-center gap-3">
        <!-- Filter tabs -->
        <div class="flex rounded-pg border border-pg-border bg-pg-surface">
          <button
            v-for="f in (['all', 'active', 'inactive'] as const)"
            :key="f"
            class="px-3 py-1.5 text-xs font-medium capitalize transition-colors"
            :class="agentStore.filter === f
              ? 'bg-pg-accent/10 text-pg-text'
              : 'text-pg-text-muted hover:text-pg-text-secondary'"
            @click="agentStore.setFilter(f); agentStore.fetchAgents()"
          >
            {{ f }}
          </button>
        </div>
        <button
          class="rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text shadow-sm hover:bg-pg-accent-hover"
          @click="openCreate"
        >
          + New Agent
        </button>
      </div>
    </header>

    <!-- Error -->
    <div
      v-if="agentStore.error"
      class="border-b border-pg-error bg-pg-error/10 px-6 py-2 text-sm text-pg-error"
      role="alert"
    >
      {{ agentStore.error }}
      <button
        class="ml-2 underline"
        @click="agentStore.clearError()"
      >
        Dismiss
      </button>
    </div>

    <!-- Loading -->
    <div
      v-if="agentStore.isLoading"
      class="flex items-center justify-center py-12"
    >
      <span class="text-sm text-pg-text-muted">Loading agents...</span>
    </div>

    <!-- Agent grid -->
    <div
      v-else
      class="pg-scrollbar flex-1 overflow-y-auto p-6"
    >
      <div
        v-if="agentStore.filteredAgents.length === 0"
        class="flex h-48 items-center justify-center"
      >
        <div class="text-center">
          <p class="text-sm text-pg-text-secondary">
            No agents found
          </p>
          <p class="mt-1 text-xs text-pg-text-muted">
            Create your first agent to get started.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="agent in agentStore.filteredAgents"
          :key="agent.id"
          class="group relative rounded-pg-lg border border-pg-border bg-pg-surface p-5 shadow-sm transition-shadow hover:shadow-md"
        >
          <!-- Status dot + Name -->
          <div class="mb-3 flex items-start justify-between">
            <div class="flex items-center gap-2">
              <span
                class="inline-block h-2.5 w-2.5 rounded-full"
                :class="agent.active ? 'bg-pg-success' : 'bg-pg-text-muted'"
              />
              <h3 class="text-sm font-semibold text-pg-text">
                {{ agent.name }}
              </h3>
            </div>
            <span class="pg-badge">{{ agent.modelTier }}</span>
          </div>

          <!-- Description -->
          <p
            v-if="agent.description"
            class="mb-3 line-clamp-2 text-xs leading-relaxed text-pg-text-secondary"
          >
            {{ agent.description }}
          </p>

          <!-- ID -->
          <p class="mb-4 truncate font-mono text-[10px] text-pg-text-muted">
            {{ agent.id }}
          </p>

          <!-- Actions -->
          <div class="flex gap-2">
            <button
              class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-secondary transition-colors hover:bg-pg-surface-raised hover:text-pg-text"
              @click="openEdit(agent.id)"
            >
              Edit
            </button>
            <button
              v-if="confirmDeleteId !== agent.id"
              class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-muted transition-colors hover:border-pg-error hover:text-pg-error"
              @click="confirmDeleteId = agent.id"
            >
              Deactivate
            </button>
            <template v-else>
              <button
                class="rounded-pg-sm bg-pg-error px-3 py-1.5 text-xs font-medium text-white"
                @click="handleDelete(agent.id)"
              >
                Confirm
              </button>
              <button
                class="rounded-pg-sm border border-pg-border px-3 py-1.5 text-xs text-pg-text-muted"
                @click="confirmDeleteId = null"
              >
                Cancel
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
      <div
        v-if="showModal"
        class="fixed inset-0 z-50 flex items-center justify-center"
      >
        <!-- Backdrop -->
        <div
          class="absolute inset-0 bg-black/40 backdrop-blur-sm"
          @click="showModal = false"
        />

        <!-- Modal -->
        <div class="relative z-10 w-full max-w-lg rounded-pg-lg border border-pg-border bg-pg-surface p-6 shadow-xl">
          <h2 class="mb-4 text-base font-semibold text-pg-text">
            {{ modalTitle }}
          </h2>

          <div class="flex flex-col gap-4">
            <!-- Name -->
            <div>
              <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Name</label>
              <input
                v-model="formName"
                type="text"
                placeholder="My Agent"
                class="pg-input w-full"
              >
            </div>

            <!-- Description -->
            <div>
              <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Description</label>
              <input
                v-model="formDescription"
                type="text"
                placeholder="Optional description..."
                class="pg-input w-full"
              >
            </div>

            <!-- Model tier + Approval -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Model Tier</label>
                <select
                  v-model="formModelTier"
                  class="pg-input w-full"
                >
                  <option value="haiku">
                    Haiku
                  </option>
                  <option value="sonnet">
                    Sonnet
                  </option>
                  <option value="opus">
                    Opus
                  </option>
                </select>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Approval</label>
                <select
                  v-model="formApproval"
                  class="pg-input w-full"
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
            </div>

            <!-- Instructions -->
            <div>
              <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Instructions</label>
              <textarea
                v-model="formInstructions"
                rows="4"
                placeholder="System prompt and instructions..."
                class="pg-input w-full resize-none"
              />
            </div>

            <!-- Tools -->
            <div>
              <label class="mb-1 block text-xs font-medium text-pg-text-secondary">Tools (comma-separated)</label>
              <input
                v-model="formTools"
                type="text"
                placeholder="search, code_edit, file_read"
                class="pg-input w-full"
              >
            </div>
          </div>

          <!-- Error -->
          <div
            v-if="agentStore.error"
            class="mt-3 text-xs text-pg-error"
          >
            {{ agentStore.error }}
          </div>

          <!-- Buttons -->
          <div class="mt-6 flex justify-end gap-3">
            <button
              class="rounded-pg border border-pg-border px-4 py-2 text-sm text-pg-text-secondary hover:bg-pg-surface-raised"
              @click="showModal = false; resetForm()"
            >
              Cancel
            </button>
            <button
              :disabled="!formName.trim() || !formInstructions.trim() || agentStore.isSaving"
              class="rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text hover:bg-pg-accent-hover disabled:opacity-50"
              @click="handleSave"
            >
              {{ agentStore.isSaving ? 'Saving...' : (isEditing ? 'Update' : 'Create') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
