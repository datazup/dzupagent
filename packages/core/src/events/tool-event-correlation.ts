export type TerminalToolEventType = 'tool:result' | 'tool:error'

export interface TerminalToolExecutionRunIdOptions {
  eventType: TerminalToolEventType
  toolName: string
  executionRunId?: string
  fallbackExecutionRunId?: string
}

function normalizeRunId(runId: string | undefined): string | undefined {
  if (typeof runId !== 'string') return undefined
  const trimmed = runId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve a non-empty execution run id for terminal tool lifecycle events.
 *
 * Terminal events (`tool:result`, `tool:error`) must carry a stable run id to
 * keep downstream correlation deterministic under concurrent tool activity.
 */
export function requireTerminalToolExecutionRunId(
  options: TerminalToolExecutionRunIdOptions,
): string {
  const direct = normalizeRunId(options.executionRunId)
  if (direct) return direct

  const fallback = normalizeRunId(options.fallbackExecutionRunId)
  if (fallback) return fallback

  throw new Error(
    `Missing executionRunId for ${options.eventType} (${options.toolName}).`,
  )
}
