/**
 * Composable for fetching trace steps from the server and mapping them
 * to playground TraceEvent objects for replay in the TraceTimeline.
 *
 * Fetches from `GET /api/runs/:id/messages` (full trace) or with
 * `?from=N&to=M` for paginated ranges.
 *
 * @module useTraceReplay
 */
import { ref } from 'vue'
import { useApi } from './useApi.js'
import { useTraceStore } from '../stores/trace-store.js'
import type { TraceEvent, ApiResponse } from '../types.js'

// ---------------------------------------------------------------------------
// Server response types (mirrors forgeagent-server TraceStep shape)
// ---------------------------------------------------------------------------

/** Step type as returned by the server trace endpoint */
export type ServerStepType =
  | 'user_input'
  | 'llm_request'
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'output'

/** A single trace step from the server */
export interface ServerTraceStep {
  stepIndex: number
  timestamp: number
  type: ServerStepType
  content: unknown
  metadata?: Record<string, unknown>
  durationMs?: number
}

/** Distribution of step types */
export interface ServerStepDistribution {
  user_input: number
  llm_request: number
  llm_response: number
  tool_call: number
  tool_result: number
  system: number
  output: number
}

/** Response payload from GET /api/runs/:id/messages */
export interface ServerTraceResponse {
  runId: string
  agentId: string
  steps: ServerTraceStep[]
  totalSteps: number
  distribution: ServerStepDistribution
  startedAt: number
  completedAt?: number
  range?: { from: number; to: number }
}

// ---------------------------------------------------------------------------
// Mapping: server step type -> playground event type
// ---------------------------------------------------------------------------

const STEP_TYPE_MAP: Record<ServerStepType, TraceEvent['type']> = {
  user_input: 'system',
  llm_request: 'llm',
  llm_response: 'llm',
  tool_call: 'tool',
  tool_result: 'tool',
  system: 'system',
  output: 'system',
}

/**
 * Derive a human-readable name from a server trace step.
 */
function stepName(step: ServerTraceStep): string {
  // Try metadata.toolName for tool steps
  if (step.metadata) {
    const toolName = step.metadata['toolName'] ?? step.metadata['tool']
    if (typeof toolName === 'string' && toolName.trim()) return toolName
    const model = step.metadata['model']
    if (typeof model === 'string' && model.trim()) return model
  }

  // Try content for string payloads
  if (typeof step.content === 'string' && step.content.trim()) {
    const trimmed = step.content.trim()
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed
  }

  // Fall back to step type label
  return step.type.replace(/_/g, ' ')
}

/**
 * Map a single server TraceStep to a playground TraceEvent.
 */
export function mapServerStepToTraceEvent(
  step: ServerTraceStep,
  runId: string,
): TraceEvent {
  return {
    id: `${runId}-step-${step.stepIndex}`,
    type: STEP_TYPE_MAP[step.type],
    name: stepName(step),
    startedAt: new Date(step.timestamp).toISOString(),
    durationMs: step.durationMs ?? 0,
    metadata: step.metadata,
  }
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Composable for loading and mapping server trace data for replay.
 *
 * @example
 * ```ts
 * const { loadTrace, isLoading, error } = useTraceReplay()
 * await loadTrace('run-123')
 * ```
 */
export function useTraceReplay() {
  const { get } = useApi()
  const traceStore = useTraceStore()

  const totalSteps = ref(0)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Fetch the full trace for a run and load events into the trace store.
   *
   * @param runId - The run ID to fetch the trace for
   */
  async function loadTrace(runId: string): Promise<void> {
    isLoading.value = true
    error.value = null

    try {
      const result = await get<ApiResponse<ServerTraceResponse>>(
        `/api/runs/${runId}/messages`,
      )
      const { steps, totalSteps: total } = result.data
      totalSteps.value = total

      const events = steps.map((step) => mapServerStepToTraceEvent(step, runId))
      traceStore.setEvents(events)
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : 'Failed to load trace'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Fetch a paginated range of trace steps from the server.
   *
   * @param runId - The run ID
   * @param from - Start index (inclusive)
   * @param to - End index (exclusive)
   * @returns Mapped TraceEvent array for the requested range
   */
  async function loadPage(
    runId: string,
    from: number,
    to: number,
  ): Promise<TraceEvent[]> {
    const result = await get<ApiResponse<ServerTraceResponse>>(
      `/api/runs/${runId}/messages?from=${from}&to=${to}`,
    )
    return result.data.steps.map((step) =>
      mapServerStepToTraceEvent(step, runId),
    )
  }

  return {
    totalSteps,
    isLoading,
    error,
    loadTrace,
    loadPage,
  }
}
