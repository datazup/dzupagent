/**
 * OpenRouter adapter.
 *
 * OpenRouter provides an OpenAI-compatible API gateway to 100+ models.
 * Uses native `fetch` directly -- no external SDK dependency required.
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

/** SSE chunk shape returned by the OpenRouter streaming API. */
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

export interface OpenRouterConfig extends AdapterConfig {
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY env var. */
  openRouterApiKey?: string
  /** Default model when none specified. Default: 'anthropic/claude-sonnet-4-5-20250514' */
  defaultModel?: string
  /** Site URL for OpenRouter analytics */
  siteUrl?: string
  /** Site name for OpenRouter analytics */
  siteName?: string
  /** Provider routing preferences */
  providerPreferences?: {
    order?: string[]
    allow_fallbacks?: boolean
  }
}

export class OpenRouterAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = 'openrouter'
  private currentController?: AbortController

  constructor(private config: OpenRouterConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const apiKey =
      this.config.openRouterApiKey ??
      this.config.apiKey ??
      process.env['OPENROUTER_API_KEY']
    if (!apiKey) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message:
          'OpenRouter API key required. Set OPENROUTER_API_KEY or pass openRouterApiKey in config.',
        recoverable: false,
        context: { providerId: 'openrouter', reason: 'missing_api_key' },
      })
    }

    const model =
      (input.options?.['model'] as string) ??
      this.config.defaultModel ??
      'anthropic/claude-sonnet-4-5-20250514'
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
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(this.config.siteUrl ? { 'HTTP-Referer': this.config.siteUrl } : {}),
          ...(this.config.siteName ? { 'X-Title': this.config.siteName } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(this.config.providerPreferences
            ? { provider: this.config.providerPreferences }
            : {}),
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
        error: `OpenRouter API error: ${response.status} ${errorText}`,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      }
      return
    }

    // Parse SSE stream
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
      message: 'OpenRouter does not support session resume',
      recoverable: false,
      context: { providerId: 'openrouter', operation: 'resumeSession' },
    })
  }

  interrupt(): void {
    this.currentController?.abort()
  }

  async healthCheck(): Promise<HealthStatus> {
    const apiKey =
      this.config.openRouterApiKey ??
      this.config.apiKey ??
      process.env['OPENROUTER_API_KEY']
    return {
      healthy: !!apiKey,
      providerId: this.providerId,
      sdkInstalled: true,
      cliAvailable: false,
      lastError: apiKey ? undefined : 'No API key configured',
    }
  }

  configure(opts: Partial<OpenRouterConfig>): void {
    this.config = { ...this.config, ...opts }
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
