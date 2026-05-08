import type { DzupEventBus } from '@dzupagent/core/events'

export type StreamFormat = 'sse' | 'jsonl' | 'ndjson'

export interface StreamingConfig {
  /** Output format. Default: 'jsonl' */
  format?: StreamFormat
  /** Whether to include tool call details. Default true */
  includeToolCalls?: boolean
  /** Whether to include raw events. Default false */
  includeRawEvents?: boolean
  /** Whether to track and emit progress updates. Default true */
  trackProgress?: boolean
  /** Event bus for observability */
  eventBus?: DzupEventBus | undefined
}

export type ResolvedStreamingConfig = Required<
  Pick<StreamingConfig, 'format' | 'includeToolCalls' | 'includeRawEvents' | 'trackProgress'>
> & { eventBus?: DzupEventBus | undefined }

/** Structured output event for UIs */
export interface StreamOutputEvent {
  /** Event type for UI routing */
  type: 'status' | 'content' | 'tool_call' | 'tool_result' | 'progress' | 'error' | 'done'
  /** ISO timestamp */
  timestamp: string
  /** The data payload */
  data: StreamEventData
}

export type StreamEventData =
  | StatusData
  | ContentData
  | ToolCallData
  | ToolResultData
  | ProgressData
  | ErrorData
  | DoneData

export interface StatusData {
  type: 'status'
  status: 'started' | 'running' | 'completed' | 'failed'
  providerId?: string | undefined
  sessionId?: string | undefined
}

export interface ContentData {
  type: 'content'
  text: string
  role: 'assistant' | 'user' | 'system'
}

export interface ToolCallData {
  type: 'tool_call'
  name: string
  input: unknown
}

export interface ToolResultData {
  type: 'tool_result'
  name: string
  output: string
  durationMs: number
}

export interface ProgressData {
  type: 'progress'
  percent: number
  currentStep?: string | undefined
  totalSteps?: number | undefined
  tokensUsed?: number | undefined
}

export interface ErrorData {
  type: 'error'
  message: string
  code?: string | undefined
  recoverable: boolean
}

export interface DoneData {
  type: 'done'
  result: string
  durationMs: number
  usage?: { inputTokens: number; outputTokens: number } | undefined
}

/** Progress tracking state */
export interface ProgressState {
  totalEvents: number
  toolCallCount: number
  messageCount: number
  startTime: number
  lastEventTime: number
  estimatedPercent: number
}
