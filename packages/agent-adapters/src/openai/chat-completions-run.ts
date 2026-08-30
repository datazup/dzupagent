import type { AdapterProviderId, AgentInput } from "../types.js";
import { mutableChatToolProjection } from "./execution-control-projection.js";
import type { OpenAIConfig, OpenAIRunResult } from "./openai-types.js";
import type { OpenAIToolProjection } from "./openai-tool-calls.js";
import {
  buildOpenAIMessages,
  emitOpenAIRunAudit,
  postChatCompletions,
  resolveOpenAIAuditErrorCode,
} from "./openai-http.js";

/** One non-streaming chat-completions run with audit emission on both paths. */
export async function runOpenAIChatNonStreaming(args: {
  config: OpenAIConfig;
  providerId: AdapterProviderId;
  input: AgentInput;
  model: string;
  projection: Readonly<OpenAIToolProjection>;
  signal: AbortSignal | undefined;
}): Promise<OpenAIRunResult> {
  const { config, providerId, input, model, projection, signal } = args;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const response = await postChatCompletions({
      config,
      messages: buildOpenAIMessages(input.prompt, input.systemPrompt),
      model,
      stream: false,
      ...mutableChatToolProjection(projection),
      ...(signal ? { signal } : {}),
    });
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
      config,
      providerId,
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      model,
      status: "completed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      ...(usage !== undefined ? { usage } : {}),
    });
    return usage ? { content, usage } : { content };
  } catch (error: unknown) {
    emitOpenAIRunAudit({
      config,
      providerId,
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      model,
      status: "failed",
      durationMs: Date.now() - startedAtMs,
      startedAt,
      errorCode: resolveOpenAIAuditErrorCode(error),
    });
    throw error;
  }
}
