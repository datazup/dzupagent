/**
 * Chat store -- manages playground chat messages and agent selection.
 *
 * Handles sending messages to the ForgeAgent server,
 * maintaining message history, and tracking the selected agent.
 *
 * @module chat-store
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatMessage, AgentSummary, ApiResponse, TraceEvent, RunHistoryEntry } from '../types.js'
import { useApi } from '../composables/useApi.js'
import { useTraceStore } from './trace-store.js'
import { useWsStore } from './ws-store.js'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected'])

export const useChatStore = defineStore('chat', () => {
  // ── State ─────────────────────────────────────────
  const messages = ref<ChatMessage[]>([])
  const currentAgentId = ref<string | null>(null)
  const agents = ref<AgentSummary[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // ── Getters ───────────────────────────────────────
  const currentAgent = computed(() =>
    agents.value.find((a) => a.id === currentAgentId.value) ?? null,
  )

  const messageCount = computed(() => messages.value.length)

  // ── Actions ───────────────────────────────────────
  const { get, post } = useApi()
  const traceStore = useTraceStore()
  const wsStore = useWsStore()

  function pushSystemMessage(content: string): void {
    messages.value = [
      ...messages.value,
      {
        id: `system-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role: 'system',
        content,
        timestamp: new Date().toISOString(),
      },
    ]
  }

  function runOutputToAssistantMessage(output: unknown): string | null {
    if (typeof output === 'string' && output.trim()) return output
    if (output && typeof output === 'object') {
      const asRecord = output as Record<string, unknown>
      if (typeof asRecord['content'] === 'string' && asRecord['content'].trim()) {
        return asRecord['content']
      }
      if (typeof asRecord['message'] === 'string' && asRecord['message'].trim()) {
        return asRecord['message']
      }
      return JSON.stringify(output, null, 2)
    }
    return null
  }

  function traceTypeFromPhase(phase?: string): TraceEvent['type'] {
    if (!phase) return 'system'
    const normalized = phase.toLowerCase()
    if (normalized.includes('tool')) return 'tool'
    if (normalized.includes('memory')) return 'memory'
    if (normalized.includes('guard')) return 'guardrail'
    if (normalized.includes('llm') || normalized.includes('model')) return 'llm'
    return 'system'
  }

  async function waitForRunCompletion(runId: string): Promise<RunHistoryEntry> {
    const MAX_ATTEMPTS = 60
    const INTERVAL_MS = 1000

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const run = await get<ApiResponse<RunHistoryEntry>>(`/api/runs/${runId}`)
      const status = run.data.status
      if (TERMINAL_STATUSES.has(status)) {
        return run.data
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
    }

    throw new Error('Run timed out before reaching a terminal state')
  }

  async function refreshTrace(runId: string): Promise<void> {
    const traceResult = await get<ApiResponse<{ events: Array<{ message: string; phase?: string; timestamp?: string }> }>>(
      `/api/runs/${runId}/trace`,
    )

    traceStore.clearEvents()
    traceResult.data.events.forEach((event, index) => {
      const traceEvent: TraceEvent = {
        id: `${runId}-${index}`,
        type: traceTypeFromPhase(event.phase),
        name: event.message || event.phase || 'event',
        startedAt: event.timestamp ?? new Date().toISOString(),
        durationMs: 1,
      }
      traceStore.addEvent(traceEvent)
    })
  }

  /** Fetch available agents from the server */
  async function fetchAgents(): Promise<void> {
    try {
      const result = await get<ApiResponse<AgentSummary[]>>('/api/agents?active=true')
      agents.value = result.data
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch agents'
    }
  }

  /** Select an agent by ID */
  function selectAgent(agentId: string): void {
    currentAgentId.value = agentId
    // Clear messages when switching agents
    messages.value = []
    error.value = null
  }

  /**
   * Send a user message and receive an assistant response.
   * Appends both messages to the history.
   */
  async function sendMessage(content: string): Promise<void> {
    if (!currentAgentId.value || isLoading.value) return

    error.value = null

    // Optimistically append user message
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    messages.value = [...messages.value, userMessage]
    isLoading.value = true

    try {
      const runCreate = await post<ApiResponse<RunHistoryEntry>>(
        '/api/runs',
        { agentId: currentAgentId.value, input: { message: content } },
      )
      const runId = runCreate.data.id
      wsStore.setSubscription({ runId, eventTypes: ['agent:started', 'agent:completed', 'agent:failed', 'tool:called', 'tool:result', 'tool:error', 'memory:written', 'memory:searched', 'memory:error', 'pipeline:phase_changed'] })
      pushSystemMessage(`Run started: ${runId}`)

      const finalRun = await waitForRunCompletion(runId)
      await refreshTrace(runId)

      const assistantContent = runOutputToAssistantMessage(finalRun.output)
      if (assistantContent) {
        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString(),
        }
        messages.value = [...messages.value, assistantMessage]
      } else if (finalRun.status === 'completed') {
        pushSystemMessage('Run completed with no assistant output payload.')
      } else {
        pushSystemMessage(`Run ended with status "${finalRun.status}"${finalRun.error ? `: ${finalRun.error}` : ''}`)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to send message'
    } finally {
      isLoading.value = false
    }
  }

  /** Clear all messages */
  function clearMessages(): void {
    messages.value = []
    error.value = null
  }

  return {
    // State
    messages,
    currentAgentId,
    agents,
    isLoading,
    error,

    // Getters
    currentAgent,
    messageCount,

    // Actions
    fetchAgents,
    selectAgent,
    sendMessage,
    clearMessages,
  }
})
