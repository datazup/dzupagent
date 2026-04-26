<script setup lang="ts">
/**
 * CapabilityMatrixView -- UCL FR-8: Capability Matrix UI panel.
 *
 * Accepts a skillId, fetches GET /api/v1/capabilities/:skillId, and renders
 * the SkillCapabilityMatrix as an HTML table with color-coded status badges.
 * Rows = providers, columns = capability keys.
 */
import { ref } from 'vue'
import PgBadge from '../components/ui/PgBadge.vue'

type CapabilityStatus = 'active' | 'degraded' | 'dropped' | 'unsupported'

interface ProviderCapabilityRow {
  systemPrompt: CapabilityStatus
  toolBindings: CapabilityStatus
  approvalMode: CapabilityStatus
  networkPolicy: CapabilityStatus
  budgetLimit: CapabilityStatus
  warnings: string[]
}

type AdapterProviderId = 'claude' | 'codex' | 'gemini' | 'gemini-sdk' | 'qwen' | 'crush' | 'goose' | 'openrouter'

interface SkillCapabilityMatrix {
  skillId: string
  skillName: string
  providers: Partial<Record<AdapterProviderId, ProviderCapabilityRow>>
}

const CAPABILITY_COLUMNS: { key: keyof Omit<ProviderCapabilityRow, 'warnings'>; label: string }[] = [
  { key: 'systemPrompt', label: 'System Prompt' },
  { key: 'toolBindings', label: 'Tool Bindings' },
  { key: 'approvalMode', label: 'Approval Mode' },
  { key: 'networkPolicy', label: 'Network Policy' },
  { key: 'budgetLimit', label: 'Budget Limit' },
]

const input = ref('')
const isLoading = ref(false)
const error = ref<string | null>(null)
const matrix = ref<SkillCapabilityMatrix | null>(null)

async function onSubmit(): Promise<void> {
  const skillId = input.value.trim()
  if (!skillId) return

  isLoading.value = true
  error.value = null
  matrix.value = null

  try {
    const response = await fetch(`/api/v1/capabilities/${encodeURIComponent(skillId)}`)
    if (!response.ok) {
      if (response.status === 404) {
        error.value = `Skill "${skillId}" not found.`
      } else {
        error.value = `Request failed: ${response.status} ${response.statusText}`
      }
      return
    }
    const body = await response.json() as { data: SkillCapabilityMatrix }
    matrix.value = body.data
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Network error. Is the server running?'
  } finally {
    isLoading.value = false
  }
}

function onClear(): void {
  input.value = ''
  error.value = null
  matrix.value = null
}

function providerEntries(providers: SkillCapabilityMatrix['providers']): [AdapterProviderId, ProviderCapabilityRow][] {
  return Object.entries(providers) as [AdapterProviderId, ProviderCapabilityRow][]
}

function providersWithWarnings(providers: SkillCapabilityMatrix['providers']): [AdapterProviderId, string[]][] {
  return (Object.entries(providers) as [AdapterProviderId, ProviderCapabilityRow][])
    .filter(([, row]) => row.warnings.length > 0)
    .map(([id, row]) => [id, row.warnings])
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
    <!-- Header -->
    <header class="flex flex-col gap-1">
      <h1 class="text-lg font-semibold text-pg-text">
        Capability Matrix
      </h1>
      <p class="text-xs text-pg-text-muted">
        Enter a skill ID to inspect which capabilities each provider supports for that skill.
      </p>
    </header>

    <!-- Form -->
    <form
      class="flex items-center gap-2"
      @submit.prevent="onSubmit"
    >
      <label
        class="sr-only"
        for="skill-id-input"
      >Skill ID</label>
      <input
        id="skill-id-input"
        v-model="input"
        type="text"
        placeholder="skillId"
        class="flex-1 rounded-pg border border-pg-border bg-pg-surface px-3 py-2 text-sm text-pg-text placeholder:text-pg-text-muted focus:border-pg-accent focus:outline-none"
      >
      <button
        type="submit"
        class="rounded-pg bg-pg-accent px-4 py-2 text-sm font-medium text-pg-accent-text hover:opacity-90 disabled:opacity-50"
        :disabled="input.trim().length === 0 || isLoading"
      >
        {{ isLoading ? 'Loading...' : 'Inspect' }}
      </button>
      <button
        v-if="matrix || error"
        type="button"
        class="rounded-pg border border-pg-border px-4 py-2 text-sm font-medium text-pg-text-secondary hover:bg-pg-surface-raised"
        @click="onClear"
      >
        Clear
      </button>
    </form>

    <!-- Loading -->
    <div
      v-if="isLoading"
      class="flex items-center justify-center py-12"
    >
      <span class="text-sm text-pg-text-muted">Fetching capability matrix...</span>
    </div>

    <!-- Error -->
    <div
      v-else-if="error"
      class="rounded-pg border border-pg-border bg-red-500/10 px-4 py-3 text-sm text-red-400"
      role="alert"
    >
      {{ error }}
    </div>

    <!-- Matrix -->
    <template v-else-if="matrix">
      <!-- Skill info -->
      <div class="flex flex-col gap-0.5">
        <p class="text-sm font-semibold text-pg-text">
          {{ matrix.skillName }}
        </p>
        <p class="font-mono text-xs text-pg-text-muted">
          {{ matrix.skillId }}
        </p>
      </div>

      <!-- Table -->
      <div class="overflow-x-auto rounded-pg border border-pg-border">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-pg-border bg-pg-surface-raised">
              <th class="px-4 py-2.5 text-left text-xs font-medium text-pg-text-muted">
                Provider
              </th>
              <th
                v-for="col in CAPABILITY_COLUMNS"
                :key="col.key"
                class="px-4 py-2.5 text-left text-xs font-medium text-pg-text-muted"
              >
                {{ col.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="[providerId, row] in providerEntries(matrix.providers)"
              :key="providerId"
              class="border-b border-pg-border last:border-0 hover:bg-pg-surface-raised/50"
            >
              <td class="px-4 py-2.5 font-mono text-xs font-medium text-pg-text">
                {{ providerId }}
              </td>
              <td
                v-for="col in CAPABILITY_COLUMNS"
                :key="col.key"
                class="px-4 py-2.5"
              >
                <PgBadge
                  :capability="row[col.key]"
                  size="sm"
                >
                  {{ row[col.key] }}
                </PgBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Warnings -->
      <div
        v-if="providersWithWarnings(matrix.providers).length > 0"
        class="flex flex-col gap-3"
      >
        <h2 class="text-xs font-medium uppercase tracking-wide text-pg-text-muted">
          Warnings
        </h2>
        <div
          v-for="[providerId, warnings] in providersWithWarnings(matrix.providers)"
          :key="providerId"
          class="rounded-pg border border-pg-border bg-yellow-500/5 px-4 py-3"
        >
          <p class="mb-1.5 font-mono text-xs font-semibold text-pg-text">
            {{ providerId }}
          </p>
          <ul class="flex flex-col gap-1">
            <li
              v-for="(warning, i) in warnings"
              :key="i"
              class="text-xs text-yellow-400"
            >
              {{ warning }}
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>
