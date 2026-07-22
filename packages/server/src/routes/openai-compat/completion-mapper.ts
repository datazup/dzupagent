/**
 * Maps DzupAgent streaming output into OpenAI Chat Completions wire format.
 *
 * Responsibilities:
 * - Agent output fragments -> ChatCompletionChunk (streaming)
 * - tool_call events -> OpenAI streaming tool-call delta chunks
 * - completion ID generation in OpenAI's `chatcmpl-*` format
 *
 * Non-streaming request/response mapping lives in `request-mapper.ts`
 * (`mapRequest` / `mapResponseWithTools`), which production routes use.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionChunkWithTools,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options passed through to agent execution
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string | string[];
}

// ---------------------------------------------------------------------------
// Mapped request shape (consumed by request-mapper.ts's EnhancedMappedRequest)
// ---------------------------------------------------------------------------

export interface MappedRequest {
  agentId: string;
  prompt: string;
  options: GenerateOptions;
}

// ---------------------------------------------------------------------------
// ID generation helpers
// ---------------------------------------------------------------------------

// SEC-L-02: use crypto.randomUUID for cryptographically random IDs;
// slice to 24 chars to match the original ID length contract.
function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// ---------------------------------------------------------------------------
// OpenAICompletionMapper
// ---------------------------------------------------------------------------

export class OpenAICompletionMapper {
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
    isLast: boolean
  ): ChatCompletionChunk {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index,
          delta: isLast ? {} : { role: "assistant", content: delta },
          finish_reason: isLast ? "stop" : null,
        },
      ],
    };
  }

  /**
   * Generate a unique completion ID in OpenAI's `chatcmpl-*` format.
   */
  generateId(): string {
    return `chatcmpl-${randomId()}`;
  }

  /**
   * Map a tool_call event to an OpenAI streaming delta chunk.
   * Emits the tool call initiation chunk (name + empty arguments).
   */
  mapToolCallInitChunk(
    toolCallId: string,
    toolName: string,
    toolIndex: number,
    model: string,
    completionId: string
  ): ChatCompletionChunkWithTools {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: toolCallId,
                type: "function",
                function: { name: toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  /**
   * Map tool call argument fragment to a streaming delta chunk.
   */
  mapToolCallArgumentsChunk(
    argumentFragment: string,
    toolIndex: number,
    model: string,
    completionId: string
  ): ChatCompletionChunkWithTools {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                function: { arguments: argumentFragment },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  /**
   * Emit the final chunk with finish_reason: 'tool_calls'.
   */
  mapToolCallsFinishChunk(
    model: string,
    completionId: string
  ): ChatCompletionChunkWithTools {
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    };
  }
}
