/**
 * OpenAI adapter — shared types, constants, and policy helpers.
 *
 * Extracted from `openai-adapter.ts` (MC-027a-1) to keep the main class
 * focused on lifecycle while wire-format and configuration details live
 * alongside the helpers that use them.
 */
import type { LlmAuditSink } from '@dzupagent/core/events'
import type { OutboundUrlSecurityPolicy } from '../utils/security-lite.js'
import type { AdapterConfig } from '../types.js'

/**
 * Streaming tool-call delta as emitted by OpenAI Chat Completions.
 *
 * Each chunk may carry a partial tool call: `id` and `function.name` typically
 * appear on the first chunk for a given `index`, while `function.arguments`
 * arrives in fragments that must be concatenated until `finish_reason` flips
 * to `tool_calls`.
 */
export interface SSEToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

/** SSE chunk shape returned by the OpenAI streaming API. */
export interface SSEChunkChoice {
  delta?: {
    content?: string
    tool_calls?: SSEToolCallDelta[]
  }
  finish_reason?: string | null
}

export interface SSEChunkUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

export interface SSEChunk {
  choices?: SSEChunkChoice[]
  usage?: SSEChunkUsage
}

/** Non-streaming response shape. */
export interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: SSEChunkUsage
}

/**
 * Tool definition consumed by the OpenAI adapter via `input.options.tools`.
 *
 * Shape mirrors the OpenAI Chat Completions `tools[].function` schema and the
 * common `AgentTool` contract used by other adapters: `{name, description,
 * parameters}` where `parameters` is a JSON Schema object.
 */
export interface OpenAIToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/**
 * Wire shape for OpenAI Chat Completions `tools` parameter.
 * Exactly: `[{ type: 'function', function: {name, description, parameters} }]`.
 */
export interface OpenAIToolWire {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAIConfig extends AdapterConfig {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string
  /** Default model when none specified. Default: 'gpt-4o-mini' */
  model?: string
  /** Custom base URL for OpenAI-compatible endpoints. Default: 'https://api.openai.com/v1' */
  baseURL?: string
  /**
   * Outbound URL policy for OpenAI-compatible endpoints. When omitted, the
   * configured baseURL host is treated as operator-owned for compatibility
   * with local/self-hosted providers; redirects remain policy-validated.
   */
  outboundUrlPolicy?: OutboundUrlSecurityPolicy
  /**
   * Optional best-effort audit sink invoked once per terminal LLM call.
   * Wire via `attachLlmAuditEventBridge` from `@dzupagent/core` to forward
   * records onto a `DzupEventBus`.
   *
   * Both the streaming `execute()` path and non-streaming `run()` path emit
   * a best-effort audit record. Sink failures are logged and swallowed.
   */
  auditSink?: LlmAuditSink
  /** Optional audit run identifier copied into LLM audit records. */
  auditRunId?: string
  /** Optional audit tenant identifier copied into LLM audit records. */
  auditTenantId?: string
}

export interface OpenAIRunResult {
  content: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Build a default outbound URL policy that whitelists the configured baseURL
 * host. Used when the operator does not supply an explicit policy.
 */
export function defaultOpenAIOutboundPolicy(baseURL: string): OutboundUrlSecurityPolicy | undefined {
  try {
    const parsed = new URL(baseURL)
    const host = parsed.hostname.toLowerCase()
    const isHttp = parsed.protocol === 'http:'
    const isPrivate =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '0.0.0.0' ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host === '::1'
    return {
      allowedHosts: [host],
      ...(isHttp ? { allowHttp: true } : {}),
      ...(isPrivate ? { allowPrivateNetwork: true } : {}),
    }
  } catch {
    return undefined
  }
}

/** Raw event shape streamed between open() and mapRawEvent(). */
export type OpenAIRawEvent =
  | { kind: 'sse'; chunk: SSEChunk }
  | {
      kind: 'completed'
      fullText: string
      usage?: { inputTokens: number; outputTokens: number }
      durationMs: number
    }
