/**
 * OpenAI-compatible request/response types.
 *
 * Field names, nesting, and optionality match the OpenAI Chat Completions API
 * so that DzupAgent can serve as a drop-in replacement behind any OpenAI-
 * compatible client.
 */

// ---------------------------------------------------------------------------
// Chat Completion Request
// ---------------------------------------------------------------------------

export interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    name?: string
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
    tool_call_id?: string
  }>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  stop?: string | string[]
}

// ---------------------------------------------------------------------------
// Chat Completion Response (non-streaming)
// ---------------------------------------------------------------------------

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string | null }
    finish_reason: 'stop' | 'length' | 'tool_calls'
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ---------------------------------------------------------------------------
// Chat Completion Chunk (streaming)
// ---------------------------------------------------------------------------

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: { role?: 'assistant'; content?: string }
    finish_reason: 'stop' | 'length' | null
  }>
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelObject {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface ModelListResponse {
  object: 'list'
  data: ModelObject[]
}

// ---------------------------------------------------------------------------
// Streaming Tool Call Deltas (OpenAI wire format for tool_calls in chunks)
// ---------------------------------------------------------------------------

export interface StreamingToolCallFunction {
  name?: string
  arguments?: string
}

export interface StreamingToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: StreamingToolCallFunction
}

export interface ChatCompletionChunkWithTools {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      content?: string
      tool_calls?: StreamingToolCallDelta[]
    }
    finish_reason: string | null
  }>
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface OpenAIErrorResponse {
  error: {
    message: string
    type: string
    param: string | null
    code: string | null
  }
}
