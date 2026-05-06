/**
 * OpenAI adapter — thin wrapper around the OpenAI Chat Completions API.
 *
 * Uses native `fetch` directly (no external SDK dependency). Stream lifecycle
 * delegates to {@link AdapterStreamRunner}; this class implements
 * {@link AdapterStreamSource} so the runner owns abort control, heartbeat
 * detection, and adapter:started/completed/failed lifecycle events.
 */
import { randomUUID } from 'node:crypto'
import { ForgeError, type LlmAuditSink } from '@dzupagent/core'
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
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'

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
  /**
   * Optional best-effort audit sink invoked once per terminal LLM call.
   * Wire via `attachLlmAuditEventBridge` from `@dzupagent/core` to forward
   * records onto a `DzupEventBus`.
   *
   * Note: only the streaming `execute()` path emits audit records. The
   * non-streaming `run()` convenience does not flow through the runner
   * (audit emission for that path is deferred — see TODO in run()).
   */
  auditSink?: LlmAuditSink
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

/** Raw event shape streamed between open() and mapRawEvent(). */
type OpenAIRawEvent =
  | { kind: 'sse'; chunk: SSEChunk }
  | { kind: 'completed'; fullText: string; usage?: { inputTokens: number; outputTokens: number }; durationMs: number }

export class OpenAIAdapter implements AgentCLIAdapter, AdapterStreamSource<OpenAIRawEvent> {
  readonly providerId: AdapterProviderId = 'openai'
  private currentController?: AbortController
  private currentSessionId = ''
  private currentModel = DEFAULT_MODEL
  private currentStartTime = 0
  private currentFullText = ''

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
   * Non-streaming convenience method returning the assembled content + usage.
   *
   * TODO(H-25): emit `llm:invocation_recorded` for the non-streaming path.
   * The streaming path goes through {@link AdapterStreamRunner} which owns
   * audit emission; this path does not, so audit records for callers using
   * `run()` are not yet captured. Streaming covers the bulk of LLM traffic;
   * this is deferred to a follow-up.
   */
  async run(
    prompt: string,
    opts: { systemPrompt?: string; model?: string; signal?: AbortSignal } = {},
  ): Promise<OpenAIRunResult> {
    const model = opts.model ?? this.config.model ?? DEFAULT_MODEL
    const response = await this.postChatCompletions({
      messages: this.buildMessages(prompt, opts.systemPrompt),
      model,
      stream: false,
      signal: opts.signal,
    })
    const data = (await response.json()) as OpenAIChatResponse
    const content = data.choices?.[0]?.message?.content ?? ''
    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined
    return usage ? { content, usage } : { content }
  }

  /** Streaming convenience that delegates to {@link execute}. */
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
    // Validate API key up-front so we throw a ForgeError synchronously
    // (preserves prior behaviour expected by callers).
    this.resolveApiKey()

    this.currentSessionId = randomUUID()
    this.currentModel =
      (input.options?.['model'] as string | undefined) ?? this.config.model ?? DEFAULT_MODEL
    this.currentStartTime = Date.now()
    this.currentFullText = ''

    const runner = new AdapterStreamRunner<OpenAIRawEvent>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: this.currentSessionId,
      startedExtra: {
        model: this.currentModel,
      },
      onAbortController: (ctrl) => {
        this.currentController = ctrl
      },
      ...(this.config.auditSink ? { auditSink: this.config.auditSink } : {}),
      auditModel: this.currentModel,
    })

    try {
      yield* runner.run(this, input, input.signal)
    } finally {
      this.currentController = undefined
    }
  }

  // -----------------------------------------------------------------------
  // AdapterStreamSource<OpenAIRawEvent>
  // -----------------------------------------------------------------------

  async *open(input: AgentInput, signal: AbortSignal): AsyncIterable<OpenAIRawEvent> {
    const response = await this.postChatCompletions({
      messages: this.buildMessages(input.prompt, input.systemPrompt),
      model: this.currentModel,
      stream: true,
      signal,
    })

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

  mapRawEvent(raw: OpenAIRawEvent, context: StreamContext): AgentEvent | AgentEvent[] | null {
    // Ensure runner-context sessionId tracks our locally generated id so
    // adapter:started carries the same session as adapter:completed.
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
      monitorStatus: getDefaultMonitorStatus(this.providerId),
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

  private buildMessages(prompt: string, systemPrompt?: string): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: prompt })
    return messages
  }

  private async postChatCompletions(args: {
    messages: Array<{ role: string; content: string }>
    model: string
    stream: boolean
    signal?: AbortSignal
  }): Promise<Response> {
    const apiKey = this.resolveApiKey()
    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL
    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      stream: args.stream,
    }
    if (args.stream) body['stream_options'] = { include_usage: true }
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: args.signal,
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
