export type ExecutionRunStatus =
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'

export interface ExecutionRun {
  id: string
  taskId: string
  workflowRunId: string
  providerId: string
  model?: string
  status: ExecutionRunStatus
  input: string
  result?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costCents?: number
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export type PromptType = 'system' | 'user' | 'expanded' | 'tool_context' | 'retry'

export interface PromptRecord {
  id: string
  executionRunId: string
  promptType: PromptType
  rawPrompt: string
  resolvedPrompt?: string
  templateId?: string
  templateVersion?: number
  tokenEstimate?: number
  hashSha256: string
  createdAt: number
}
