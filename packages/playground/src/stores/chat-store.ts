/**
 * Chat store -- manages playground chat messages and agent selection.
 *
 * Handles sending messages to the DzipAgent server,
 * maintaining message history, and tracking the selected agent.
 *
 * @module chat-store
 */
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
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
  const activeRunId = ref<string | null>(null)
  const streamingMessageIds = new Map<string, string>()

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
    messages.value.push({
      id: `system-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role: 'system',
      content,
      timestamp: new Date().toISOString(),
    })
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

  function extractTextField(
    event: Record<string, unknown>,
    payload: Record<string, unknown> | null,
    key: string,
  ): string {
    if (typeof event[key] === 'string') return event[key] as string
    if (payload && typeof payload[key] === 'string') return payload[key] as string
    return ''
  }

  function upsertStreamingAssistant(runId: string, delta: string): void {
    if (!delta) return
    const existingId = streamingMessageIds.get(runId)
    if (!existingId) {
      const id = `assistant-stream-${runId}`
      streamingMessageIds.set(runId, id)
      messages.value.push({
        id,
        role: 'assistant',
        content: delta,
        timestamp: new Date().toISOString(),
      })
      return
    }
    const idx = messages.value.findIndex((m) => m.id === existingId)
    if (idx >= 0) {
      const existing = messages.value[idx]!
      messages.value[idx] = {
        ...existing,
        content: `${existing.content}${delta}`,
      }
    } else {
      // Message got removed (e.g., agent switch); recreate safely.
      streamingMessageIds.delete(runId)
      upsertStreamingAssistant(runId, delta)
    }
  }

  function finalizeStreamingAssistant(runId: string, finalContent: string): boolean {
    const id = streamingMessageIds.get(runId)
    if (!id) return false
    const idx = messages.value.findIndex((m) => m.id === id)
    if (idx >= 0 && finalContent.trim()) {
      const existing = messages.value[idx]!
      messages.value[idx] = {
        ...existing,
        content: finalContent,
      }
    }
    streamingMessageIds.delete(runId)
    return idx >= 0
  }

  function handleRealtimeEvent(eventLike: Record<string, unknown>): void {
    const payload = (eventLike['payload'] && typeof eventLike['payload'] === 'object' && !Array.isArray(eventLike['payload']))
      ? eventLike['payload'] as Record<string, unknown>
      : null

    const type = extractTextField(eventLike, payload, 'type')
    if (!type) return

    const runId = extractTextField(eventLike, payload, 'runId')
    if (!runId) return

    // Guard: ignore events from stale runs (e.g. after agent switch)
    if (activeRunId.value && runId !== activeRunId.value) return

    if (type === 'agent:stream_delta') {
      const delta = extractTextField(eventLike, payload, 'content')
      upsertStreamingAssistant(runId, delta)
      return
    }

    if (type === 'agent:stream_done') {
      const finalContent = extractTextField(eventLike, payload, 'finalContent')
      finalizeStreamingAssistant(runId, finalContent)
      return
    }
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

  /**
   * Wait for a run to reach a terminal state.
   * Primary signal: WS events (agent:completed / agent:failed).
   * Fallback: polls the REST API if WS doesn't deliver within timeout.
   */
  async function waitForRunCompletion(runId: string): Promise<RunHistoryEntry> {
    const WS_TIMEOUT_MS = 120_000
    const POLL_INTERVAL_MS = 3000

    // Race: WS terminal event vs polling fallback
    return new Promise<RunHistoryEntry>((resolve, reject) => {
      let settled = false
      let pollTimer: ReturnType<typeof setInterval> | null = null

      const cleanup = () => {
        settled = true
        if (pollTimer) clearInterval(pollTimer)
        clearTimeout(timeoutTimer)
      }

      const stopWatch = watch(
        () => wsStore.lastEvent,
        async (event) => {
          if (settled || !event) return
          const eventData = event as Record<string, unknown>
          const payload = (eventData['payload'] && typeof eventData['payload'] === 'object')
            ? eventData['payload'] as Record<string, unknown>
            : eventData
          const type = (payload['type'] as string) ?? ''
          const eventRunId = (payload['runId'] as string) ?? ''

          if (eventRunId !== runId) return
          if (type === 'agent:completed' || type === 'agent:failed') {
            cleanup()
            stopWatch()
            try {
              const run = await get<ApiResponse<RunHistoryEntry>>(`/api/runs/${runId}`)
              resolve(run.data)
            } catch (err) {
              reject(err)
            }
          }
        },
        { deep: true },
      )

      // Polling fallback — much slower cadence since WS is primary
      pollTimer = setInterval(async () => {
        if (settled) return
        try {
          const run = await get<ApiResponse<RunHistoryEntry>>(`/api/runs/${runId}`)
          if (TERMINAL_STATUSES.has(run.data.status)) {
            cleanup()
            stopWatch()
            resolve(run.data)
          }
        } catch {
          // Swallow poll errors; WS or next poll will pick up
        }
      }, POLL_INTERVAL_MS)

      // Hard timeout
      const timeoutTimer = setTimeout(() => {
        if (settled) return
        cleanup()
        stopWatch()
        reject(new Error(`Run ${runId} timed out before reaching a terminal state`))
      }, WS_TIMEOUT_MS)
    })
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

  /** Select an agent by ID, fully isolating state from any prior agent/run */
  function selectAgent(agentId: string): void {
    // Unsubscribe from any in-flight run's WS events before switching
    if (activeRunId.value) {
      wsStore.setSubscription(null)
    }
    currentAgentId.value = agentId
    messages.value = []
    streamingMessageIds.clear()
    activeRunId.value = null
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
    messages.value.push(userMessage)
    isLoading.value = true

    try {
      const runCreate = await post<ApiResponse<RunHistoryEntry>>(
        '/api/runs',
        { agentId: currentAgentId.value, input: { message: content } },
      )
      const runId = runCreate.data.id
      activeRunId.value = runId
      wsStore.setSubscription({ runId, eventTypes: ['agent:started', 'agent:completed', 'agent:failed', 'agent:stream_delta', 'agent:stream_done', 'tool:called', 'tool:result', 'tool:error', 'memory:written', 'memory:searched', 'memory:error', 'pipeline:phase_changed'] })
      pushSystemMessage(`Run started: ${runId}`)

      const finalRun = await waitForRunCompletion(runId)
      await refreshTrace(runId)

      const assistantContent = runOutputToAssistantMessage(finalRun.output)
      if (assistantContent) {
        const updatedStream = finalizeStreamingAssistant(runId, assistantContent)
        if (!updatedStream) {
          const assistantMessage: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: assistantContent,
            timestamp: new Date().toISOString(),
          }
          messages.value.push(assistantMessage)
        }
      } else if (finalRun.status === 'completed') {
        pushSystemMessage('Run completed with no assistant output payload.')
      } else {
        pushSystemMessage(`Run ended with status "${finalRun.status}"${finalRun.error ? `: ${finalRun.error}` : ''}`)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to send message'
    } finally {
      activeRunId.value = null
      isLoading.value = false
    }
  }

  /** Clear all messages */
  function clearMessages(): void {
    messages.value = []
    streamingMessageIds.clear()
    activeRunId.value = null
    error.value = null
  }

  /** Clear current error without altering chat history */
  function clearError(): void {
    error.value = null
  }

  return {
    // State
    messages,
    currentAgentId,
    agents,
    isLoading,
    error,
    activeRunId,

    // Getters
    currentAgent,
    messageCount,

    // Actions
    fetchAgents,
    selectAgent,
    sendMessage,
    handleRealtimeEvent,
    clearMessages,
    clearError,
  }
})
