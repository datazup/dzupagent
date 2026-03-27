export type StandardEventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'phase_change'
  | 'progress'
  | 'done'
  | 'error'
  | 'parallel_candidate'
  | 'parallel_complete'
  | 'file_stream_start'
  | 'file_stream_chunk'
  | 'file_stream_end'

export interface StandardSSEEvent {
  type: StandardEventType | string
  data: Record<string, unknown>
}

// ── File Streaming Event Payloads ─────────────────────────────

export interface FileStreamStartPayload {
  filePath: string
  language: string
  phase: string
}

export interface FileStreamChunkPayload {
  filePath: string
  chunk: string
  chunkIndex: number
}

export interface FileStreamEndPayload {
  filePath: string
  totalChunks: number
  totalLength: number
}
