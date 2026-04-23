/**
 * Maps OpenAI Chat Completions request shapes to DzupAgent execution inputs.
 *
 * Gap fixes applied here (over the base OpenAICompletionMapper in openai/):
 *
 * GAP-1: System message extraction
 *   The base mapper serialises every message (including `system`) into a flat
 *   prompt string.  OpenAI callers expect `system` messages to configure the
 *   agent's behaviour, not appear as conversation turns.  This module extracts
 *   `system` messages and surfaces them as `systemOverride` so the route can
 *   compose them with the stored agent instructions.
 *
 * GAP-2: Streaming finish_reason for iteration limits
 *   The `done` event from agent.stream() carries `hitIterationLimit: true` when
 *   the agent ran out of iterations.  The base mapper always emits
 *   `finish_reason: 'stop'`; this module provides `mapFinalChunk()` which
 *   inspects the done-event data and emits `'length'` when appropriate.
 *
 * GAP-3: Non-streaming tool_calls in response choice
 *   When the generate() result includes tool invocations recorded in the
 *   message history, the non-streaming response choice should carry a
 *   `tool_calls` array so callers can surface which tools were invoked.
 *   This module provides `extractToolCallsFromMessages()` and an enhanced
 *   `mapResponseWithTools()` builder.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  OpenAIErrorResponse,
} from './types.js'

// ---------------------------------------------------------------------------
// Re-export useful types so consumers need only one import
// ---------------------------------------------------------------------------

export type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, OpenAIErrorResponse }

// ---------------------------------------------------------------------------
// Mapped request — extends the base MappedRequest with system metadata
// ---------------------------------------------------------------------------

export interface EnhancedMappedRequest {
  agentId: string
  /** Conversation messages WITHOUT system entries (safe to pass as prompt) */
  prompt: string
  /**
   * Concatenated system message content, if any `system` role messages were
   * present in the request.  The route should compose this with the stored
   * agent instructions.
   */
  systemOverride: string | null
  options: {
    temperature?: number
    maxTokens?: number
    stop?: string | string[]
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(length = 24): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export function generateCompletionId(): string {
  return `chatcmpl-${randomId()}`
}

// ---------------------------------------------------------------------------
// GAP-1: System message extraction
// ---------------------------------------------------------------------------

/**
 * Map an OpenAI ChatCompletionRequest to an EnhancedMappedRequest.
 *
 * System messages are split out into `systemOverride`.  The remaining
 * messages are serialised into a prompt string using role-prefixed lines.
 */
export function mapRequest(req: ChatCompletionRequest): EnhancedMappedRequest {
  const systemLines: string[] = []
  const conversationLines: string[] = []

  for (const msg of req.messages) {
    const content = msg.content ?? ''

    if (msg.role === 'system') {
      systemLines.push(content)
    } else {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
      conversationLines.push(`${role}: ${content}`)
    }
  }

  return {
    agentId: req.model,
    prompt: conversationLines.join('\n\n'),
    systemOverride: systemLines.length > 0 ? systemLines.join('\n') : null,
    options: {
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.max_tokens !== undefined && { maxTokens: req.max_tokens }),
      ...(req.stop !== undefined && { stop: req.stop }),
    },
  }
}

// ---------------------------------------------------------------------------
// GAP-2: Streaming finish_reason for iteration limits
// ---------------------------------------------------------------------------

/**
 * Produce the final SSE chunk, respecting the done-event's `hitIterationLimit`
 * flag.
 *
 * When `hitIterationLimit` is `true` (or `stopReason` is `'iteration_limit'`
 * or `'budget_exceeded'`), the chunk carries `finish_reason: 'length'` instead
 * of `'stop'` — matching OpenAI's convention for truncated outputs.
 */
export function mapFinalStreamChunk(
  model: string,
  completionId: string,
  doneEventData: Record<string, unknown>,
): ChatCompletionChunk {
  const hitLimit =
    doneEventData['hitIterationLimit'] === true ||
    doneEventData['stopReason'] === 'iteration_limit' ||
    doneEventData['stopReason'] === 'budget_exceeded'

  const finishReason: 'stop' | 'length' = hitLimit ? 'length' : 'stop'

  return {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// GAP-3: Non-streaming tool_calls in response choice
// ---------------------------------------------------------------------------

/**
 * A condensed tool-call record for the non-streaming response.
 * Matches OpenAI's `ToolCall` shape inside `ChatCompletionMessage.tool_calls`.
 */
export interface ResponseToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Extract tool invocations from the agent's message history.
 *
 * LangChain stores tool calls on `AIMessage` instances via the
 * `tool_calls` property (array of `{ id, name, args }`).
 * This function walks the messages and collects them.
 */
export function extractToolCallsFromMessages(messages: BaseMessage[]): ResponseToolCall[] {
  const results: ResponseToolCall[] = []

  for (const msg of messages) {
    // LangChain AIMessage carries tool_calls as a first-class property
    const raw = msg as unknown as Record<string, unknown>
    const toolCalls = raw['tool_calls']
    if (!Array.isArray(toolCalls)) continue

    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue
      const call = tc as Record<string, unknown>
      const id = typeof call['id'] === 'string' ? call['id'] : generateCompletionId()
      const name = typeof call['name'] === 'string' ? call['name'] : 'unknown'
      const args =
        typeof call['args'] === 'object' && call['args'] !== null
          ? JSON.stringify(call['args'])
          : typeof call['args'] === 'string'
            ? call['args']
            : '{}'

      results.push({ id, type: 'function', function: { name, arguments: args } })
    }
  }

  return results
}

/**
 * Build a non-streaming ChatCompletionResponse that includes tool_calls when
 * the agent's generate() result contains tool invocations.
 */
export function mapResponseWithTools(
  content: string,
  model: string,
  completionId: string,
  usage: { totalInputTokens: number; totalOutputTokens: number },
  messages: BaseMessage[],
  hitIterationLimit: boolean,
): ChatCompletionResponse & {
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: ResponseToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls'
  }>
} {
  const toolCalls = extractToolCallsFromMessages(messages)

  const finishReason: 'stop' | 'length' | 'tool_calls' = toolCalls.length > 0
    ? 'tool_calls'
    : hitIterationLimit
      ? 'length'
      : 'stop'

  const choiceMessage: {
    role: 'assistant'
    content: string | null
    tool_calls?: ResponseToolCall[]
  } = {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: choiceMessage,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage.totalInputTokens,
      completion_tokens: usage.totalOutputTokens,
      total_tokens: (usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0),
    },
  }
}

// ---------------------------------------------------------------------------
// Request validation (shared)
// ---------------------------------------------------------------------------

function openAIError(
  message: string,
  type: string,
  param: string | null,
  code: string | null,
): OpenAIErrorResponse {
  return { error: { message, type, param, code } }
}

export function badRequest(message: string, param: string | null = null): OpenAIErrorResponse {
  return openAIError(message, 'invalid_request_error', param, 'invalid_request_error')
}

export function notFoundError(model: string): OpenAIErrorResponse {
  return openAIError(
    `The model '${model}' does not exist or you do not have access to it.`,
    'invalid_request_error',
    null,
    'model_not_found',
  )
}

export function serverError(message: string): OpenAIErrorResponse {
  return openAIError(message, 'server_error', null, 'internal_error')
}

export function validateCompletionRequest(
  body: unknown,
): { ok: true; request: ChatCompletionRequest } | { ok: false; error: OpenAIErrorResponse } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: badRequest('Request body must be a JSON object.') }
  }

  const req = body as Record<string, unknown>

  if (typeof req['model'] !== 'string' || !req['model']) {
    return { ok: false, error: badRequest('You must provide a model parameter.', 'model') }
  }

  if (!Array.isArray(req['messages']) || req['messages'].length === 0) {
    return {
      ok: false,
      error: badRequest(
        "'messages' is a required property. It must be a non-empty array.",
        'messages',
      ),
    }
  }

  for (let i = 0; i < req['messages'].length; i++) {
    const msg = req['messages'][i] as Record<string, unknown> | null
    if (!msg || typeof msg !== 'object') {
      return { ok: false, error: badRequest(`Invalid message at index ${i}.`, `messages[${i}]`) }
    }
    const role = msg['role']
    if (
      typeof role !== 'string' ||
      !['system', 'user', 'assistant', 'tool'].includes(role)
    ) {
      return {
        ok: false,
        error: badRequest(
          `Invalid value for 'role' at messages[${i}]. Expected one of 'system', 'user', 'assistant', 'tool'.`,
          `messages[${i}].role`,
        ),
      }
    }
  }

  return { ok: true, request: req as unknown as ChatCompletionRequest }
}
