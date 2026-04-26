/**
 * OpenAI adapter.
 *
 * Thin wrapper around the OpenAI Chat Completions API for app-chat use.
 * Uses native `fetch` directly -- no external SDK dependency required.
 *
 * This adapter intentionally implements only `chat`/`run` semantics on top
 * of the AgentCLIAdapter contract. It is not a full agent CLI adapter --
 * approval gates, MCP tool calls, and session management are not handled.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  AgentCLIAdapter,
  AdapterProviderId,
} from '../types.js'

/** SSE chunk shape returned by the OpenAI streaming API. */
interface SSEChunkChoice {
  delta?: { content?: string }
}

interface SSEChunkUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface SSEChunk {
  choices?: SSEChunkChoice[]
  usage?: SSEChunkUsage
}

/** Non-streaming response shape. */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: SSEChunkUsage
}

export interface OpenAIConfig extends AdapterConfig {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string
  /** Default model when none specified. Default: 'gpt-4o-mini' */
  model?: string
  /** Custom base URL for OpenAI-compatible endpoints. Default: 'https://api.openai.com/v1' */
  baseURL?: string
}

export interface OpenAIRunResult {
  content: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Lightweight OpenAI Chat Completions adapter.
 *
 * Provides:
 *   - `run(prompt, opts)` for one-shot calls returning `{ content, usage }`
 *   - `chat(prompt, opts)` for streaming calls yielding agent events
 *   - `execute(input)` to satisfy the AgentCLIAdapter contract
 */
export class OpenAIAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = 'openai'
  private currentController?: AbortController

  constructor(private config: OpenAIConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: false,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  /**
   * Non-streaming convenience method.
   * Returns the assembled content and token usage.
   */
  async run(
    prompt: string,
    opts: {
      systemPrompt?: string
      model?: string
      signal?: AbortSignal
    } = {},
  ): Promise<OpenAIRunResult> {
    const apiKey = this.resolveApiKey()
    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL
    const model = opts.model ?? this.config.model ?? DEFAULT_MODEL

    const messages: Array<{ role: string; content: string }> = []
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
    messages.push({ role: 'user', content: prompt })

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: opts.signal,
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

    const data = (await response.json()) as OpenAIChatResponse
    const content = data.choices?.[0]?.message?.content ?? ''
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined

    return usage ? { content, usage } : { content }
  }

  /**
   * Streaming convenience method.
   * Yields agent events for each SSE delta plus a final completion event.
   */
  async *chat(
    prompt: string,
    opts: {
      systemPrompt?: string
      model?: string
      signal?: AbortSignal
      workingDirectory?: string
    } = {},
  ): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.execute({
      prompt,
      systemPrompt: opts.systemPrompt,
      options: opts.model ? { model: opts.model } : undefined,
      signal: opts.signal,
      workingDirectory: opts.workingDirectory,
    })
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    let apiKey: string
    try {
      apiKey = this.resolveApiKey()
    } catch (err) {
      throw err instanceof ForgeError
        ? err
        : new ForgeError({
            code: 'ADAPTER_EXECUTION_FAILED',
            message: 'OpenAI API key required. Set OPENAI_API_KEY or pass apiKey in config.',
            recoverable: false,
            context: { providerId: 'openai', reason: 'missing_api_key' },
          })
    }

    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL
    const model =
      (input.options?.['model'] as string | undefined) ?? this.config.model ?? DEFAULT_MODEL
    const sessionId = randomUUID()
    this.currentController = new AbortController()
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.currentController.signal])
      : this.currentController.signal

    yield {
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: Date.now(),
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      model,
      workingDirectory: input.workingDirectory,
      isResume: false,
    }

    const startTime = Date.now()

    const messages: Array<{ role: string; content: string }> = []
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
    messages.push({ role: 'user', content: input.prompt })

    let response: Response
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      })
    } catch (err) {
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        code: signal.aborted ? 'AGENT_ABORTED' : 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      }
      return
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText)
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: `OpenAI API error: ${response.status} ${errorText}`,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      }
      return
    }

    let fullText = ''
    let usage: { inputTokens: number; outputTokens: number } | undefined

    try {
      for await (const event of this.parseSSE(response.body!, signal)) {
        const choice = event.choices?.[0]
        if (choice?.delta?.content) {
          const content = choice.delta.content
          fullText += content
          yield {
            type: 'adapter:stream_delta',
            providerId: this.providerId,
            content,
            timestamp: Date.now(),
          }
        }
        if (event.usage) {
          usage = {
            inputTokens: event.usage.prompt_tokens ?? 0,
            outputTokens: event.usage.completion_tokens ?? 0,
          }
        }
      }
    } catch (err) {
      if (signal.aborted) {
        yield {
          type: 'adapter:failed',
          providerId: this.providerId,
          sessionId,
          error: 'Aborted',
          code: 'AGENT_ABORTED',
          timestamp: Date.now(),
        }
        return
      }
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      }
      return
    }

    yield {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId,
      result: fullText,
      durationMs: Date.now() - startTime,
      usage,
      timestamp: Date.now(),
    }
  }

  async *resumeSession(
    _sessionId: string,
    _input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    throw new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: 'OpenAI adapter does not support session resume',
      recoverable: false,
      context: { providerId: 'openai', operation: 'resumeSession' },
    })
  }

  interrupt(): void {
    this.currentController?.abort()
  }

  async healthCheck(): Promise<HealthStatus> {
    const apiKey = this.config.apiKey ?? process.env['OPENAI_API_KEY']
    return {
      healthy: !!apiKey,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: false,
      lastError: apiKey ? undefined : 'No API key configured',
    }
  }

  configure(opts: Partial<OpenAIConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  private resolveApiKey(): string {
    const apiKey = this.config.apiKey ?? process.env['OPENAI_API_KEY']
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

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<SSEChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') return
          try {
            yield JSON.parse(data) as SSEChunk
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
