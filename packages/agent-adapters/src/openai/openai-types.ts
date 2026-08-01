import type { LlmAuditSink } from "@dzupagent/core/events";
import type { OutboundUrlSecurityPolicy } from "@dzupagent/core/security";
import type { AdapterConfig } from "../types.js";
import type { AdapterHardBudgetPolicy } from "../context/hard-budget-input.js";

export type OpenAITransport = "chat-completions" | "responses";

export interface SSEToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface SSEChunkChoice {
  delta?: {
    content?: string;
    tool_calls?: SSEToolCallDelta[];
  };
  finish_reason?: string | null;
}

export interface SSEChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface SSEChunk {
  choices?: SSEChunkChoice[];
  usage?: SSEChunkUsage;
}

export interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: SSEChunkUsage;
}

export interface OpenAIToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface OpenAIToolWire {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAIResponsesInputRequest {
  model: string;
  input: readonly { role: "system" | "user"; content: string }[];
  tools?: readonly {
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  }[];
  tool_choice?: unknown;
}

export interface OpenAIConfig extends AdapterConfig {
  apiKey?: string;
  model?: string;
  transport?: OpenAITransport;
  baseURL?: string;
  outboundUrlPolicy?: OutboundUrlSecurityPolicy;
  auditSink?: LlmAuditSink;
  auditRunId?: string;
  auditTenantId?: string;
  fetchImpl?: typeof fetch;
  hardBudget?: AdapterHardBudgetPolicy;
}

export interface OpenAIRunResult {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

export function defaultOpenAIOutboundPolicy(
  baseURL: string
): OutboundUrlSecurityPolicy | undefined {
  try {
    const parsed = new URL(baseURL);
    return { allowedHosts: [parsed.host] };
  } catch {
    return undefined;
  }
}

export type OpenAIRawEvent =
  | { kind: "sse"; chunk: SSEChunk }
  | {
      kind: "completed";
      fullText: string;
      usage?: { inputTokens: number; outputTokens: number };
      durationMs: number;
    };
