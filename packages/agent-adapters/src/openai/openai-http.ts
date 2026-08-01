import {
  ForgeError,
  type LlmAuditSink,
  type LlmInvocationRecord,
} from "@dzupagent/core/events";
import { fetchWithOutboundUrlPolicy } from "@dzupagent/core/security";
import { defaultLogger } from "@dzupagent/core/utils";
import { httpErrorToForgeError } from "../utils/http-error.js";
import type { AdapterProviderId } from "../types.js";
import { parseSSEStream } from "../utils/sse-parser.js";
import {
  DEFAULT_BASE_URL,
  defaultOpenAIOutboundPolicy,
  type OpenAIConfig,
  type OpenAIResponsesInputRequest,
  type OpenAIRunResult,
  type OpenAIToolWire,
  type SSEChunk,
} from "./openai-types.js";

export function resolveOpenAIApiKey(config: OpenAIConfig): string {
  const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new ForgeError({
      code: "ADAPTER_EXECUTION_FAILED",
      message:
        "OpenAI API key required. Set OPENAI_API_KEY or pass apiKey in config.",
      recoverable: false,
      context: { providerId: "openai", reason: "missing_api_key" },
    });
  }
  return apiKey;
}

export function buildOpenAIMessages(
  prompt: string,
  systemPrompt?: string
): Array<{ role: "system" | "user"; content: string }> {
  const messages: Array<{
    role: "system" | "user";
    content: string;
  }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });
  return messages;
}

export interface PostChatCompletionsArgs {
  config: OpenAIConfig;
  messages: Array<{ role: string; content: string }>;
  model: string;
  stream: boolean;
  signal?: AbortSignal;
  tools?: OpenAIToolWire[];
  toolChoice?: unknown;
}

export async function postChatCompletions(
  args: PostChatCompletionsArgs
): Promise<Response> {
  const apiKey = resolveOpenAIApiKey(args.config);
  const baseURL = args.config.baseURL ?? DEFAULT_BASE_URL;
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: args.stream,
  };
  if (args.stream) body["stream_options"] = { include_usage: true };
  if (args.tools && args.tools.length > 0) body["tools"] = args.tools;
  if (args.toolChoice !== undefined) body["tool_choice"] = args.toolChoice;

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(args.signal ? { signal: args.signal } : {}),
  };

  const response = await fetchWithOutboundUrlPolicy(
    `${baseURL}/chat/completions`,
    fetchOptions,
    {
      policy:
        args.config.outboundUrlPolicy ?? defaultOpenAIOutboundPolicy(baseURL),
      ...(args.config.fetchImpl !== undefined
        ? { fetchImpl: args.config.fetchImpl }
        : {}),
    }
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw httpErrorToForgeError(response.status, errorText, "openai");
  }
  return response;
}

export function parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<SSEChunk> {
  return parseSSEStream<SSEChunk>(
    body,
    (data) => {
      try {
        return JSON.parse(data) as SSEChunk;
      } catch {
        return null;
      }
    },
    signal
  );
}

export interface RunAuditArgs {
  config: OpenAIConfig;
  providerId: AdapterProviderId;
  prompt: string;
  systemPrompt?: string;
  model: string;
  status: LlmInvocationRecord["status"];
  durationMs: number;
  startedAt: string;
  usage?: OpenAIRunResult["usage"];
  errorCode?: string;
}

export function emitOpenAIRunAudit(args: RunAuditArgs): void {
  const sink: LlmAuditSink | undefined = args.config.auditSink;
  if (!sink) return;
  try {
    const record: LlmInvocationRecord = {
      providerId: args.providerId,
      model: args.model,
      promptCharCount: args.prompt.length,
      ...(args.systemPrompt !== undefined
        ? { systemPromptCharCount: args.systemPrompt.length }
        : {}),
      status: args.status,
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      durationMs: args.durationMs,
      ...(args.usage !== undefined ? { usage: toAuditUsage(args.usage) } : {}),
      startedAt: args.startedAt,
      ...(args.config.auditRunId !== undefined
        ? { runId: args.config.auditRunId }
        : {}),
      ...(args.config.auditTenantId !== undefined
        ? { tenantId: args.config.auditTenantId }
        : {}),
    };
    sink(record);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    defaultLogger.warn("[OpenAIAdapter] audit sink failed:", msg);
  }
}

function toAuditUsage(
  usage: NonNullable<OpenAIRunResult["usage"]>
): NonNullable<LlmInvocationRecord["usage"]> {
  const promptTokens = usage.inputTokens;
  const completionTokens = usage.outputTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export function resolveOpenAIAuditErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "ADAPTER_EXECUTION_FAILED";
}

export interface NonStreamingRunArgs {
  config: OpenAIConfig;
  providerId: AdapterProviderId;
  prompt: string;
  systemPrompt?: string;
  model: string;
  signal?: AbortSignal;
}

export async function runOpenAINonStreaming(
  args: NonStreamingRunArgs
): Promise<OpenAIRunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  // Avoid passing `signal: undefined` so we don't fight strict optional checks.
  const post: Parameters<typeof postChatCompletions>[0] = {
    config: args.config,
    messages: buildOpenAIMessages(args.prompt, args.systemPrompt),
    model: args.model,
    stream: false,
  };
  if (args.signal) post.signal = args.signal;
  try {
    const response = await postChatCompletions(post);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined;
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined
        ? { systemPrompt: args.systemPrompt }
        : {}),
      model: args.model,
      status: "completed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      ...(usage !== undefined ? { usage } : {}),
    });
    return usage ? { content, usage } : { content };
  } catch (error: unknown) {
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined
        ? { systemPrompt: args.systemPrompt }
        : {}),
      model: args.model,
      status: "failed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      errorCode: resolveOpenAIAuditErrorCode(error),
    });
    throw error;
  }
}

export interface OpenAIResponsesUsage { inputTokens: number; outputTokens: number }

interface OpenAIResponsesStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: {
    id?: string;
    call_id?: string;
    type?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

export type OpenAIResponsesNormalizedEvent =
  | { kind: "chunk"; chunk: SSEChunk }
  | { kind: "completed"; usage?: OpenAIResponsesUsage };

function responseUsage(
  usage?: { input_tokens?: number; output_tokens?: number },
): OpenAIResponsesUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

export async function postOpenAIResponses(args: {
  config: OpenAIConfig;
  inputRequest: OpenAIResponsesInputRequest;
  stream: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const apiKey = resolveOpenAIApiKey(args.config);
  const baseURL = args.config.baseURL ?? DEFAULT_BASE_URL;
  const response = await fetchWithOutboundUrlPolicy(
    `${baseURL}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...args.inputRequest, stream: args.stream }),
      ...(args.signal ? { signal: args.signal } : {}),
    },
    {
      policy:
        args.config.outboundUrlPolicy ?? defaultOpenAIOutboundPolicy(baseURL),
      ...(args.config.fetchImpl ? { fetchImpl: args.config.fetchImpl } : {}),
    },
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw httpErrorToForgeError(response.status, errorText, "openai");
  }
  return response;
}

function normalizeResponsesEvent(
  event: OpenAIResponsesStreamEvent,
): OpenAIResponsesNormalizedEvent | undefined {
  if (event.type === "response.output_text.delta" && event.delta) {
    return {
      kind: "chunk",
      chunk: { choices: [{ delta: { content: event.delta } }] },
    };
  }
  if (
    event.type === "response.output_item.added"
    && event.item?.type === "function_call"
  ) {
    return {
      kind: "chunk",
      chunk: { choices: [{ delta: { tool_calls: [{
        index: event.output_index ?? 0,
        id: event.item.call_id ?? event.item.id,
        type: "function",
        function: {
          name: event.item.name,
          arguments: event.item.arguments,
        },
      }] } }] },
    };
  }
  if (event.type === "response.function_call_arguments.delta") {
    return {
      kind: "chunk",
      chunk: { choices: [{ delta: { tool_calls: [{
        index: event.output_index ?? 0,
        function: { arguments: event.delta },
      }] } }] },
    };
  }
  if (
    event.type === "response.output_item.done"
    && event.item?.type === "function_call"
  ) {
    return {
      kind: "chunk",
      chunk: { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    };
  }
  if (event.type === "response.completed") {
    const usage = responseUsage(event.response?.usage);
    return { kind: "completed", ...(usage ? { usage } : {}) };
  }
  return undefined;
}

export async function* parseOpenAIResponsesSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<OpenAIResponsesNormalizedEvent> {
  for await (const event of parseSSEStream<OpenAIResponsesStreamEvent>(
    body,
    (data) => {
      try {
        return JSON.parse(data) as OpenAIResponsesStreamEvent;
      } catch {
        return null;
      }
    },
    signal,
  )) {
    if (
      event.type === "error"
      || event.type === "response.failed"
      || event.type === "response.incomplete"
    ) {
      throw new ForgeError({
        code: "ADAPTER_EXECUTION_FAILED",
        message: "OpenAI Responses stream did not complete successfully",
        recoverable: false,
        context: { providerId: "openai", reason: event.type },
      });
    }
    const normalized = normalizeResponsesEvent(event);
    if (normalized) yield normalized;
  }
}

function responsesOutputText(data: {
  output?: readonly {
    type?: string;
    content?: readonly { type?: string; text?: string }[];
  }[];
}): string {
  return (data.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("");
}

export async function runOpenAIResponsesNonStreaming(args: {
  config: OpenAIConfig;
  providerId: AdapterProviderId;
  inputRequest: OpenAIResponsesInputRequest;
  prompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}): Promise<OpenAIRunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const response = await postOpenAIResponses({
      config: args.config,
      inputRequest: args.inputRequest,
      stream: false,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const data = await response.json() as {
      status?: string;
      output?: readonly {
        type?: string;
        content?: readonly { type?: string; text?: string }[];
      }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (data.status !== undefined && data.status !== "completed") {
      throw new ForgeError({
        code: "ADAPTER_EXECUTION_FAILED",
        message: "OpenAI Responses request did not complete successfully",
        recoverable: false,
        context: { providerId: "openai", reason: data.status },
      });
    }
    const usage = responseUsage(data.usage);
    const content = responsesOutputText(data);
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined
        ? { systemPrompt: args.systemPrompt } : {}),
      model: args.inputRequest.model,
      status: "completed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      ...(usage ? { usage } : {}),
    });
    return usage ? { content, usage } : { content };
  } catch (error) {
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined
        ? { systemPrompt: args.systemPrompt } : {}),
      model: args.inputRequest.model,
      status: "failed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      errorCode: resolveOpenAIAuditErrorCode(error),
    });
    throw error;
  }
}
