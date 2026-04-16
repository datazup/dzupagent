/**
 * Maps between OpenAI Chat Completions wire format and DzupAgent internals.
 *
 * Responsibilities:
 * - ChatCompletionRequest.messages -> prompt string + agent options
 * - model field -> agentId resolution
 * - Agent output (string) -> ChatCompletionResponse or ChatCompletionChunk
 * - Token estimation via chars/4 heuristic
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './types.js'

// ---------------------------------------------------------------------------
// Options passed through to agent execution
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  temperature?: number
  maxTokens?: number
  stop?: string | string[]
}

// ---------------------------------------------------------------------------
// Mapped request produced by mapRequest()
// ---------------------------------------------------------------------------

export interface MappedRequest {
  agentId: string
  prompt: string
  options: GenerateOptions
}

// ---------------------------------------------------------------------------
// ID generation helpers
// ---------------------------------------------------------------------------

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const ID_LENGTH = 24

function randomId(length: number = ID_LENGTH): string {
  let result = ''
  for (let i = 0; i < length; i++) {
    result += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  }
  return result
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token count using the chars/4 heuristic.
 * This is intentionally approximate -- real tokenization requires a model-
 * specific tokenizer which we avoid depending on here.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// OpenAICompletionMapper
// ---------------------------------------------------------------------------

export class OpenAICompletionMapper {
  /**
   * Convert an OpenAI ChatCompletionRequest into a DzupAgent-compatible
   * agent ID, prompt string, and generation options.
   *
   * The `model` field is treated as the agent ID.  Messages are serialised
   * into a single prompt string with role prefixes so that any downstream
   * agent (which may or may not support structured messages) can consume it.
   */
  mapRequest(req: ChatCompletionRequest): MappedRequest {
    const agentId = req.model
    const prompt = this.messagesToPrompt(req.messages)

    const options: GenerateOptions = {}
    if (req.temperature !== undefined) {
      options.temperature = req.temperature
    }
    if (req.max_tokens !== undefined) {
      options.maxTokens = req.max_tokens
    }
    if (req.stop !== undefined) {
      options.stop = req.stop
    }

    return { agentId, prompt, options }
  }

  /**
   * Build a non-streaming ChatCompletionResponse from agent output.
   */
  mapResponse(
    agentId: string,
    output: string,
    model: string,
    requestId: string,
  ): ChatCompletionResponse {
    const promptTokens = estimateTokens(agentId) // rough stand-in; caller can refine
    const completionTokens = estimateTokens(output)

    return {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: output },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }
  }

  /**
   * Build a single streaming ChatCompletionChunk.
   *
   * @param delta       The text fragment for this chunk (empty string on final chunk).
   * @param model       Model name echoed back to the caller.
   * @param completionId  Stable ID shared across all chunks of one completion.
   * @param index       Choice index (always 0 for single-choice completions).
   * @param isLast      When true the chunk carries finish_reason='stop'.
   */
  mapChunk(
    delta: string,
    model: string,
    completionId: string,
    index: number,
    isLast: boolean,
  ): ChatCompletionChunk {
    return {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index,
          delta: isLast ? {} : { role: 'assistant', content: delta },
          finish_reason: isLast ? 'stop' : null,
        },
      ],
    }
  }

  /**
   * Generate a unique completion ID in OpenAI's `chatcmpl-*` format.
   */
  generateId(): string {
    return `chatcmpl-${randomId()}`
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Flatten an array of chat messages into a single prompt string.
   *
   * Each message is rendered as `<Role>: <content>` on its own paragraph,
   * with an empty `Assistant:` prompt at the end so the agent knows to
   * continue from the assistant perspective.
   */
  private messagesToPrompt(
    messages: ChatCompletionRequest['messages'],
  ): string {
    const lines: string[] = []

    for (const msg of messages) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
      const content = msg.content ?? ''
      lines.push(`${role}: ${content}`)
    }

    return lines.join('\n\n')
  }
}
