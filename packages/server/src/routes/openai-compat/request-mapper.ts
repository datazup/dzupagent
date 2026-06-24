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
import { z } from "zod";
import { defaultLogger } from "@dzupagent/core/utils";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  OpenAIErrorResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Re-export useful types so consumers need only one import
// ---------------------------------------------------------------------------

export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  OpenAIErrorResponse,
};

// ---------------------------------------------------------------------------
// Mapped request — extends the base MappedRequest with system metadata
// ---------------------------------------------------------------------------

export interface EnhancedMappedRequest {
  agentId: string;
  /** Conversation messages WITHOUT system entries (safe to pass as prompt) */
  prompt: string;
  /**
   * Concatenated system message content, if any `system` role messages were
   * present in the request.  The route should compose this with the stored
   * agent instructions.
   */
  systemOverride: string | null;
  options: {
    temperature?: number;
    maxTokens?: number;
    stop?: string | string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateCompletionId(): string {
  // SEC-L-02: use crypto.randomUUID for cryptographically random IDs
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
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
  const systemLines: string[] = [];
  const conversationLines: string[] = [];

  for (const msg of req.messages) {
    const content = msg.content ?? "";

    if (msg.role === "system") {
      systemLines.push(content);
    } else {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      conversationLines.push(`${role}: ${content}`);
    }
  }

  return {
    agentId: req.model,
    prompt: conversationLines.join("\n\n"),
    systemOverride: systemLines.length > 0 ? systemLines.join("\n") : null,
    options: {
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.max_tokens !== undefined && { maxTokens: req.max_tokens }),
      ...(req.stop !== undefined && { stop: req.stop }),
    },
  };
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
  doneEventData: Record<string, unknown>
): ChatCompletionChunk {
  const hitLimit =
    doneEventData["hitIterationLimit"] === true ||
    doneEventData["stopReason"] === "iteration_limit" ||
    doneEventData["stopReason"] === "budget_exceeded";

  const finishReason: "stop" | "length" = hitLimit ? "length" : "stop";

  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GAP-3: Non-streaming tool_calls in response choice
// ---------------------------------------------------------------------------

/**
 * A condensed tool-call record for the non-streaming response.
 * Matches OpenAI's `ToolCall` shape inside `ChatCompletionMessage.tool_calls`.
 */
export interface ResponseToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Extract tool invocations from the agent's message history.
 *
 * LangChain stores tool calls on `AIMessage` instances via the
 * `tool_calls` property (array of `{ id, name, args }`).
 * This function walks the messages and collects them.
 */
export function extractToolCallsFromMessages(
  messages: BaseMessage[]
): ResponseToolCall[] {
  const results: ResponseToolCall[] = [];

  for (const msg of messages) {
    // LangChain AIMessage carries tool_calls as a first-class property
    const raw = msg as unknown as Record<string, unknown>;
    const toolCalls = raw["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id =
        typeof call["id"] === "string" ? call["id"] : generateCompletionId();
      const name = typeof call["name"] === "string" ? call["name"] : "unknown";
      const args =
        typeof call["args"] === "object" && call["args"] !== null
          ? JSON.stringify(call["args"])
          : typeof call["args"] === "string"
          ? call["args"]
          : "{}";

      results.push({
        id,
        type: "function",
        function: { name, arguments: args },
      });
    }
  }

  return results;
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
  hitIterationLimit: boolean
): ChatCompletionResponse & {
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ResponseToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls";
  }>;
} {
  const toolCalls = extractToolCallsFromMessages(messages);

  const finishReason: "stop" | "length" | "tool_calls" =
    toolCalls.length > 0 ? "tool_calls" : hitIterationLimit ? "length" : "stop";

  const choiceMessage: {
    role: "assistant";
    content: string | null;
    tool_calls?: ResponseToolCall[];
  } = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  };

  return {
    id: completionId,
    object: "chat.completion",
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
      total_tokens:
        (usage.totalInputTokens ?? 0) + (usage.totalOutputTokens ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Request validation (shared)
// ---------------------------------------------------------------------------

function openAIError(
  message: string,
  type: string,
  param: string | null,
  code: string | null
): OpenAIErrorResponse {
  return { error: { message, type, param, code } };
}

export function badRequest(
  message: string,
  param: string | null = null
): OpenAIErrorResponse {
  return openAIError(
    message,
    "invalid_request_error",
    param,
    "invalid_request_error"
  );
}

export function notFoundError(model: string): OpenAIErrorResponse {
  return openAIError(
    `The model '${model}' does not exist or you do not have access to it.`,
    "invalid_request_error",
    null,
    "model_not_found"
  );
}

export function serverError(message: string): OpenAIErrorResponse {
  return openAIError(message, "server_error", null, "internal_error");
}

// ---------------------------------------------------------------------------
// RF-4 (CODE-H-01/H-02, SEC-L-01): Zod schema for the OpenAI Chat Completions
// request. Replaces the hand-rolled validator with a single declarative parse
// that covers content (string|null), tool_calls structure, and the sampling
// option bounds (temperature 0-2, max_tokens > 0, stop bounds).
//
// Sampling-options decision (SEC-L-01): `temperature`, `max_tokens`, and `stop`
// are accepted and bounds-validated, but they are NOT yet threaded into the
// agent's GenerateOptions (that is RF-2a scope). To avoid silently breaking
// OpenAI clients that always send these fields, we take the SIMPLER PATH and
// STRIP them with a one-line warning log rather than rejecting with a 400.
// `mapRequest` still surfaces them on `options` for forward-compatibility, but
// the completions route does not act on them today.
// ---------------------------------------------------------------------------

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  // OpenAI allows null content (e.g. an assistant turn that only emits
  // tool_calls). Accept string | null; reject other types (numbers, objects).
  content: z.union([z.string(), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  // OpenAI caps `stop` at 4 sequences; each must be a non-empty-ish string.
  stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).optional(),
});

const SAMPLING_OPTION_KEYS = ["temperature", "max_tokens", "stop"] as const;

/** Sampling fields are validated then stripped with a warning. See decision above. */
function warnIfSamplingOptionsPresent(req: ChatCompletionRequest): void {
  const present = SAMPLING_OPTION_KEYS.filter((k) => req[k] !== undefined);
  if (present.length > 0) {
    defaultLogger.warn(
      `[ForgeServer] OpenAI-compat: sampling option(s) ${present.join(
        ", "
      )} are accepted and validated but not yet applied to generation (stripped); see RF-2a.`
    );
  }
}

/**
 * Map a single Zod issue to the OpenAI `param` path string.
 */
function zodIssueToParam(issue: z.core.$ZodIssue): string | null {
  const path = issue.path;
  if (path.length === 0) {
    return null;
  }
  const [head, ...rest] = path;
  if (head === "messages") {
    if (rest.length === 0) {
      return "messages";
    }
    const [index, field] = rest;
    if (typeof index === "number" && typeof field === "string") {
      return `messages[${index}].${field}`;
    }
    if (typeof index === "number") {
      return `messages[${index}]`;
    }
    return "messages";
  }
  return String(head);
}

function zodIssueToMessage(issue: z.core.$ZodIssue): string {
  const param = zodIssueToParam(issue);
  if (param === "model") {
    return "You must provide a model parameter.";
  }
  if (param === "messages") {
    return "'messages' is a required property. It must be a non-empty array.";
  }
  if (param && param.endsWith(".role")) {
    return `Invalid value for 'role' at ${param.slice(
      0,
      -".role".length
    )}. Expected one of 'system', 'user', 'assistant', 'tool'.`;
  }
  if (param === "temperature") {
    return "'temperature' must be a number between 0 and 2.";
  }
  if (param === "max_tokens") {
    return "'max_tokens' must be a positive integer.";
  }
  if (param === "stop") {
    return "'stop' must be a string or an array of up to 4 strings.";
  }
  return param
    ? `Invalid value for '${param}': ${issue.message}`
    : issue.message;
}

export function validateCompletionRequest(
  body: unknown
):
  | { ok: true; request: ChatCompletionRequest }
  | { ok: false; error: OpenAIErrorResponse } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: badRequest("Request body must be a JSON object."),
    };
  }

  const parsed = chatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false,
      error: badRequest(zodIssueToMessage(issue), zodIssueToParam(issue)),
    };
  }

  const request = parsed.data as ChatCompletionRequest;
  // SEC-L-01: validated above; not applied to generation yet — warn + strip.
  warnIfSamplingOptionsPresent(request);

  return { ok: true, request };
}
