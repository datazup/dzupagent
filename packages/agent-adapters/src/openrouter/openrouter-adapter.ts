/**
 * OpenRouter adapter.
 *
 * OpenRouter provides an OpenAI-compatible API gateway to 100+ models.
 * Uses native `fetch` directly -- no external SDK dependency required.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core/events'
import { fetchWithOutboundUrlPolicy } from '@dzupagent/core/security'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  AgentCLIAdapter,
  AdapterProviderId,
} from '../types.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type {
  AdapterStreamSource,
  StreamContext,
} from '../base/stream-runner.js'
import { parseSSEStream } from '../utils/sse-parser.js'
import { httpErrorToForgeError } from '../utils/http-error.js'

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

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5-20250514'
const OPENROUTER_API_HOST = 'openrouter.ai'
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Internal raw events streamed from open() through the runner. */
type OpenRouterRawEvent =
  | { kind: 'sse'; chunk: SSEChunk }
  | { kind: 'completed'; fullText: string; usage?: { inputTokens: number; outputTokens: number }; durationMs: number }

export class OpenRouterAdapter implements AgentCLIAdapter, AdapterStreamSource<OpenRouterRawEvent> {
  readonly providerId: AdapterProviderId = 'openrouter'
  private currentController?: AbortController
  private currentSessionId = ''
  private currentModel = DEFAULT_MODEL
  private currentStartTime = 0
  private currentFullText = ''

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
    // Validate API key synchronously so first .next() throws.
    this.resolveApiKey()

    this.currentSessionId = randomUUID()
    this.currentModel =
      (input.options?.['model'] as string) ?? this.config.defaultModel ?? DEFAULT_MODEL
    this.currentStartTime = Date.now()
    this.currentFullText = ''

    const runner = new AdapterStreamRunner<OpenRouterRawEvent>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: this.currentSessionId,
      startedExtra: { model: this.currentModel },
      onAbortController: (ctrl) => {
        this.currentController = ctrl
      },
    })

    try {
      yield* runner.run(this, input, input.signal)
    } finally {
      this.currentController = undefined
    }
  }

  // -----------------------------------------------------------------------
  // AdapterStreamSource<OpenRouterRawEvent>
  // -----------------------------------------------------------------------

  async *open(input: AgentInput, signal: AbortSignal): AsyncIterable<OpenRouterRawEvent> {
    const apiKey = this.resolveApiKey()

    const messages: Array<{ role: string; content: string }> = []
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
    messages.push({ role: 'user', content: input.prompt })

    const response = await fetchWithOutboundUrlPolicy(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(this.config.siteUrl ? { 'HTTP-Referer': this.config.siteUrl } : {}),
        ...(this.config.siteName ? { 'X-Title': this.config.siteName } : {}),
      },
      body: JSON.stringify({
        model: this.currentModel,
        messages,
        stream: true,
        ...(this.config.providerPreferences
          ? { provider: this.config.providerPreferences }
          : {}),
      }),
      signal,
    }, {
      policy: { allowedHosts: [OPENROUTER_API_HOST] },
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText)
      throw httpErrorToForgeError(response.status, errorText, 'openrouter')
    }

    let usage: { inputTokens: number; outputTokens: number } | undefined

    for await (const chunk of this.parseSSE(response.body!, signal)) {
      yield { kind: 'sse', chunk }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
    }

    yield {
      kind: 'completed',
      fullText: this.currentFullText,
      ...(usage !== undefined ? { usage } : {}),
      durationMs: Date.now() - this.currentStartTime,
    }
  }

  mapRawEvent(raw: OpenRouterRawEvent, context: StreamContext): AgentEvent | AgentEvent[] | null {
    if (!context.sessionId) {
      context.sessionId = this.currentSessionId
    }
    const input = context.input

    if (raw.kind === 'sse') {
      const choice = raw.chunk.choices?.[0]
      if (!choice?.delta?.content) return null
      const content = choice.delta.content
      this.currentFullText += content
      return {
        type: 'adapter:stream_delta',
        providerId: this.providerId,
        content,
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
    }

    // raw.kind === 'completed'
    return {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId: this.currentSessionId,
      result: raw.fullText,
      durationMs: raw.durationMs,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
      timestamp: Date.now(),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
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
      monitorStatus: getDefaultMonitorStatus(this.providerId),
    }
  }

  configure(opts: Partial<OpenRouterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  private resolveApiKey(): string {
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
    return apiKey
  }

  private parseSSE(
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
}
