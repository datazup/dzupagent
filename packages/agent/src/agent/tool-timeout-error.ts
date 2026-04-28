export const TOOL_TIMEOUT_ERROR_CODE = 'TOOL_TIMEOUT' as const

export class ToolTimeoutError extends Error {
  readonly code = TOOL_TIMEOUT_ERROR_CODE
  readonly toolName: string
  readonly timeoutMs: number

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`)
    this.name = 'ToolTimeoutError'
    this.toolName = toolName
    this.timeoutMs = timeoutMs
  }
}

export function isToolTimeoutError(err: unknown): err is ToolTimeoutError {
  if (err instanceof ToolTimeoutError) return true
  if (err == null || typeof err !== 'object') return false
  return (err as { code?: unknown }).code === TOOL_TIMEOUT_ERROR_CODE
}
