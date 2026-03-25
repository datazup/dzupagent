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
import type { ChatMessage, AgentSummary, ApiResponse } from '../types.js'
import { useApi } from '../composables/useApi.js'

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
      const result = await post<ApiResponse<ChatMessage>>(
        `/api/agents/${currentAgentId.value}/chat`,
        { message: content },
      )
      messages.value = [...messages.value, result.data]
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
