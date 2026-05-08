/**
 * HTTP / SSE / audit helpers for the OpenAI adapter.
 *
 * Extracted from `openai-adapter.ts` (MC-027a-1). Pure functions that
 * operate on a passed-in {@link OpenAIConfig} so they remain testable and
 * keep the main adapter class focused on lifecycle.
 */
import { ForgeError, type LlmAuditSink, type LlmInvocationRecord } from '@dzupagent/core/events'
import { fetchWithOutboundUrlPolicy } from '@dzupagent/core/security'
import { defaultLogger } from '@dzupagent/core/utils'
import type { AdapterProviderId } from '../types.js'
import { parseSSEStream } from '../utils/sse-parser.js'
import {
  DEFAULT_BASE_URL,
  defaultOpenAIOutboundPolicy,
  type OpenAIConfig,
  type OpenAIRunResult,
  type OpenAIToolWire,
  type SSEChunk,
} from './openai-types.js'

/**
 * Resolve an API key from config / environment, throwing a structured
 * {@link ForgeError} when neither is present.
 */
export function resolveOpenAIApiKey(config: OpenAIConfig): string {
  const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY']
  if (!apiKey) {
    throw new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'OpenAI API key required. Set OPENAI_API_KEY or pass apiKey in config.',
      recoverable: false,
      context: { providerId: 'openai', reason: 'missing_api_key' },
    })
  }
  return apiKey
}

/** Build chat-completion message array from a prompt + optional system prompt. */
export function buildOpenAIMessages(
  prompt: string,
  systemPrompt?: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })
  return messages
}

export interface PostChatCompletionsArgs {
  config: OpenAIConfig
  messages: Array<{ role: string; content: string }>
  model: string
  stream: boolean
  signal?: AbortSignal
  tools?: OpenAIToolWire[]
  toolChoice?: unknown
}

/**
 * POST `/chat/completions` against the configured baseURL using the shared
 * outbound URL policy guard. Throws a structured ForgeError on non-2xx.
 */
export async function postChatCompletions(args: PostChatCompletionsArgs): Promise<Response> {
  const apiKey = resolveOpenAIApiKey(args.config)
  const baseURL = args.config.baseURL ?? DEFAULT_BASE_URL
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: args.stream,
  }
  if (args.stream) body['stream_options'] = { include_usage: true }
  if (args.tools && args.tools.length > 0) body['tools'] = args.tools
  if (args.toolChoice !== undefined) body['tool_choice'] = args.toolChoice

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(args.signal ? { signal: args.signal } : {}),
  }

  const response = await fetchWithOutboundUrlPolicy(`${baseURL}/chat/completions`, fetchOptions, {
    policy: args.config.outboundUrlPolicy ?? defaultOpenAIOutboundPolicy(baseURL),
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: `OpenAI API error: ${response.status} ${errorText}`,
      recoverable: false,
      context: { providerId: 'openai', status: response.status },
    })
  }
  return response
}

/**
 * Parse an OpenAI SSE response body into typed `SSEChunk` records.
 * Lines that fail JSON parsing are skipped (the upstream parser handles
 * the `data: [DONE]` sentinel).
 */
export function parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SSEChunk> {
  return parseSSEStream<SSEChunk>(
    body,
    (data) => {
      try {
        return JSON.parse(data) as SSEChunk
      } catch {
        return null
      }
    },
    signal,
  )
}

export interface RunAuditArgs {
  config: OpenAIConfig
  providerId: AdapterProviderId
  prompt: string
  systemPrompt?: string
  model: string
  status: LlmInvocationRecord['status']
  durationMs: number
  startedAt: string
  usage?: OpenAIRunResult['usage']
  errorCode?: string
}

/**
 * Best-effort emit of an LLM audit record for the non-streaming `run()`
 * path. Sink failures are logged and swallowed so audit never breaks the
 * caller.
 */
export function emitOpenAIRunAudit(args: RunAuditArgs): void {
  const sink: LlmAuditSink | undefined = args.config.auditSink
  if (!sink) return
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
      ...(args.config.auditRunId !== undefined ? { runId: args.config.auditRunId } : {}),
      ...(args.config.auditTenantId !== undefined ? { tenantId: args.config.auditTenantId } : {}),
    }
    sink(record)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    defaultLogger.warn('[OpenAIAdapter] audit sink failed:', msg)
  }
}

function toAuditUsage(
  usage: NonNullable<OpenAIRunResult['usage']>,
): NonNullable<LlmInvocationRecord['usage']> {
  const promptTokens = usage.inputTokens
  const completionTokens = usage.outputTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  }
}

/**
 * Map an unknown error onto a stable audit error code. Falls back to
 * `'ADAPTER_EXECUTION_FAILED'` when the value carries no `code`.
 */
export function resolveOpenAIAuditErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'ADAPTER_EXECUTION_FAILED'
}

export interface NonStreamingRunArgs {
  config: OpenAIConfig
  providerId: AdapterProviderId
  prompt: string
  systemPrompt?: string
  model: string
  signal?: AbortSignal
}

/**
 * Execute a non-streaming chat completion and emit an audit record on
 * either success or failure. Returns the assembled content + usage.
 */
export async function runOpenAINonStreaming(args: NonStreamingRunArgs): Promise<OpenAIRunResult> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  // Avoid passing `signal: undefined` so we don't fight strict optional checks.
  const post: Parameters<typeof postChatCompletions>[0] = {
    config: args.config,
    messages: buildOpenAIMessages(args.prompt, args.systemPrompt),
    model: args.model,
    stream: false,
  }
  if (args.signal) post.signal = args.signal
  try {
    const response = await postChatCompletions(post)
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const content = data.choices?.[0]?.message?.content ?? ''
    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      model: args.model,
      status: 'completed',
      durationMs: Date.now() - startedAtMs,
      startedAt,
      ...(usage !== undefined ? { usage } : {}),
    })
    return usage ? { content, usage } : { content }
  } catch (error: unknown) {
    emitOpenAIRunAudit({
      config: args.config,
      providerId: args.providerId,
      prompt: args.prompt,
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      model: args.model,
      status: 'failed',
      durationMs: Date.now() - startedAtMs,
      startedAt,
      errorCode: resolveOpenAIAuditErrorCode(error),
    })
    throw error
  }
}
