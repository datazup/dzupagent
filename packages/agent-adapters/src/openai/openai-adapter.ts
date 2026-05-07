/**
 * OpenAI adapter — thin wrapper around the OpenAI Chat Completions API.
 *
 * Uses native `fetch` directly (no external SDK dependency). Stream lifecycle
 * delegates to {@link AdapterStreamRunner}; this class implements
 * {@link AdapterStreamSource} so the runner owns abort control, heartbeat
 * detection, and adapter:started/completed/failed lifecycle events.
 */
import { randomUUID } from 'node:crypto'
import { ForgeError, defaultLogger, type LlmAuditSink, type LlmInvocationRecord } from '@dzupagent/core'
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
import { parseSSEStream } from '../utils/sse-parser.js'

/**
 * Streaming tool-call delta as emitted by OpenAI Chat Completions.
 *
 * Each chunk may carry a partial tool call: `id` and `function.name` typically
 * appear on the first chunk for a given `index`, while `function.arguments`
 * arrives in fragments that must be concatenated until `finish_reason` flips
 * to `tool_calls`.
 */
interface SSEToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

/** SSE chunk shape returned by the OpenAI streaming API. */
interface SSEChunkChoice {
  delta?: {
    content?: string
    tool_calls?: SSEToolCallDelta[]
  }
  finish_reason?: string | null
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
  /**
   * Pending tool calls keyed by their stream `index`. Reset at the start of
   * every {@link execute} run to keep state isolated across invocations.
   * Chunks may arrive across many SSE deltas; we accumulate until completion.
   */
  private pendingToolCalls = new Map<number, {
    index: number
    id?: string
    name?: string
    arguments: string
    emitted: boolean
  }>()

  constructor(private config: OpenAIConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  /** Non-streaming convenience method returning the assembled content + usage. */
  async run(
    prompt: string,
    opts: { systemPrompt?: string; model?: string; signal?: AbortSignal } = {},
  ): Promise<OpenAIRunResult> {
    const model = opts.model ?? this.config.model ?? DEFAULT_MODEL
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    try {
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
      this.emitRunAudit({
        prompt,
        systemPrompt: opts.systemPrompt,
        model,
        status: 'completed',
        durationMs: Date.now() - startedAtMs,
        startedAt,
        usage,
      })
      return usage ? { content, usage } : { content }
    } catch (error: unknown) {
      this.emitRunAudit({
        prompt,
        systemPrompt: opts.systemPrompt,
        model,
        status: 'failed',
        durationMs: Date.now() - startedAtMs,
        startedAt,
        errorCode: this.resolveAuditErrorCode(error),
      })
      throw error
    }
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
    this.pendingToolCalls = new Map()

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
      ...(this.config.auditRunId !== undefined ? { auditRunId: this.config.auditRunId } : {}),
      ...(this.config.auditTenantId !== undefined ? { auditTenantId: this.config.auditTenantId } : {}),
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
    const tools = this.resolveTools(input)
    const toolChoice = input.options?.['tool_choice']
    const response = await this.postChatCompletions({
      messages: this.buildMessages(input.prompt, input.systemPrompt),
      model: this.currentModel,
      stream: true,
      signal,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
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
      if (!choice) return null

      const events: AgentEvent[] = []

      // Accumulate any tool-call fragments first so finish_reason='tool_calls'
      // observed on the same chunk can flush them in-order.
      if (choice.delta?.tool_calls) {
        this.accumulateToolCalls(choice.delta.tool_calls)
      }

      if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
        const content = choice.delta.content
        this.currentFullText += content
        events.push({
          type: 'adapter:stream_delta',
          providerId: this.providerId,
          content,
          timestamp: Date.now(),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        })
      }

      // Emit tool_call events when the model signals it is done dispatching
      // tools for this turn. We also emit on stream-end (handled below).
      if (choice.finish_reason === 'tool_calls') {
        events.push(...this.flushPendingToolCalls(input.correlationId))
      }

      if (events.length === 0) return null
      if (events.length === 1) return events[0]!
      return events
    }

    // raw.kind === 'completed'
    // Flush any tool calls that were not closed by an explicit
    // finish_reason='tool_calls' marker (some providers/proxies omit it).
    const flushed = this.flushPendingToolCalls(input.correlationId)
    const completed: AgentEvent = {
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId: this.currentSessionId,
      result: raw.fullText,
      durationMs: raw.durationMs,
      ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
      timestamp: Date.now(),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }
    if (flushed.length === 0) return completed
    return [...flushed, completed]
  }

  /**
   * Merge incoming tool_call fragments (`index`-keyed) into the pending map.
   * The first fragment for a given `index` typically supplies `id` and
   * `function.name`; subsequent fragments append `function.arguments` text.
   */
  private accumulateToolCalls(deltas: SSEToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.pendingToolCalls.get(delta.index)
      if (existing) {
        if (delta.id !== undefined) existing.id = delta.id
        if (delta.function?.name !== undefined) existing.name = delta.function.name
        if (delta.function?.arguments !== undefined) {
          existing.arguments += delta.function.arguments
        }
      } else {
        this.pendingToolCalls.set(delta.index, {
          index: delta.index,
          ...(delta.id !== undefined ? { id: delta.id } : {}),
          ...(delta.function?.name !== undefined ? { name: delta.function.name } : {}),
          arguments: delta.function?.arguments ?? '',
          emitted: false,
        })
      }
    }
  }

  /**
   * Convert any unemitted accumulated tool calls into `adapter:tool_call`
   * events (in stream order — sorted by `index`) and mark them emitted.
   *
   * Tool calls without a resolved `name` are skipped since `toolName` is
   * required by the unified event contract; this should never happen for
   * conformant OpenAI streams.
   */
  private flushPendingToolCalls(correlationId: string | undefined): AgentEvent[] {
    const events: AgentEvent[] = []
    const ordered = [...this.pendingToolCalls.values()].sort((a, b) => a.index - b.index)
    for (const call of ordered) {
      if (call.emitted) continue
      call.emitted = true
      if (call.name === undefined || call.name.length === 0) continue
      events.push({
        type: 'adapter:tool_call',
        providerId: this.providerId,
        toolName: call.name,
        input: this.parseToolArguments(call.arguments),
        timestamp: Date.now(),
        ...(correlationId ? { correlationId } : {}),
      })
    }
    return events
  }

  /**
   * Parse the accumulated `function.arguments` JSON string. Returns `{}` when
   * the buffer is empty and falls back to the raw string when JSON parsing
   * fails so consumers still receive the model output for diagnostics.
   */
  private parseToolArguments(buffer: string): unknown {
    if (buffer.length === 0) return {}
    try {
      return JSON.parse(buffer) as unknown
    } catch {
      return buffer
    }
  }

  /**
   * Read tool definitions from `input.options.tools` and convert them into
   * the OpenAI Chat Completions wire format. Accepts either:
   *   1. The flat `OpenAIToolDefinition` shape — `{name, description?, parameters?}`
   *   2. The pre-wrapped wire shape — `{type:'function', function:{...}}`
   *
   * Invalid entries are silently skipped to keep parity with other adapters.
   */
  private resolveTools(input: AgentInput): OpenAIToolWire[] | undefined {
    const raw = input.options?.['tools']
    if (!Array.isArray(raw)) return undefined
    const wire: OpenAIToolWire[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      // Pre-wrapped form
      if ('type' in entry && (entry as { type?: unknown }).type === 'function' && 'function' in entry) {
        const fn = (entry as { function?: unknown }).function
        if (fn !== null && typeof fn === 'object' && 'name' in fn && typeof (fn as { name?: unknown }).name === 'string') {
          const named = fn as { name: string; description?: unknown; parameters?: unknown }
          wire.push({
            type: 'function',
            function: {
              name: named.name,
              ...(typeof named.description === 'string' ? { description: named.description } : {}),
              ...(named.parameters && typeof named.parameters === 'object'
                ? { parameters: named.parameters as Record<string, unknown> }
                : {}),
            },
          })
        }
        continue
      }
      // Flat form
      if ('name' in entry && typeof (entry as { name?: unknown }).name === 'string') {
        const flat = entry as { name: string; description?: unknown; parameters?: unknown }
        wire.push({
          type: 'function',
          function: {
            name: flat.name,
            ...(typeof flat.description === 'string' ? { description: flat.description } : {}),
            ...(flat.parameters && typeof flat.parameters === 'object'
              ? { parameters: flat.parameters as Record<string, unknown> }
              : {}),
          },
        })
      }
    }
    return wire
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
    tools?: OpenAIToolWire[]
    toolChoice?: unknown
  }): Promise<Response> {
    const apiKey = this.resolveApiKey()
    const baseURL = this.config.baseURL ?? DEFAULT_BASE_URL
    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      stream: args.stream,
    }
    if (args.stream) body['stream_options'] = { include_usage: true }
    if (args.tools && args.tools.length > 0) body['tools'] = args.tools
    if (args.toolChoice !== undefined) body['tool_choice'] = args.toolChoice
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

  private emitRunAudit(args: {
    prompt: string
    systemPrompt?: string
    model: string
    status: LlmInvocationRecord['status']
    durationMs: number
    startedAt: string
    usage?: OpenAIRunResult['usage']
    errorCode?: string
  }): void {
    const sink = this.config.auditSink
    if (!sink) return
    try {
      const record: LlmInvocationRecord = {
        providerId: this.providerId,
        model: args.model,
        promptCharCount: args.prompt.length,
        ...(args.systemPrompt !== undefined
          ? { systemPromptCharCount: args.systemPrompt.length }
          : {}),
        status: args.status,
        ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
        durationMs: args.durationMs,
        ...(args.usage !== undefined ? { usage: this.toAuditUsage(args.usage) } : {}),
        startedAt: args.startedAt,
        ...(this.config.auditRunId !== undefined ? { runId: this.config.auditRunId } : {}),
        ...(this.config.auditTenantId !== undefined ? { tenantId: this.config.auditTenantId } : {}),
      }
      sink(record)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      defaultLogger.warn('[OpenAIAdapter] audit sink failed:', msg)
    }
  }

  private toAuditUsage(usage: NonNullable<OpenAIRunResult['usage']>): NonNullable<LlmInvocationRecord['usage']> {
    const promptTokens = usage.inputTokens
    const completionTokens = usage.outputTokens
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    }
  }

  private resolveAuditErrorCode(error: unknown): string {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code.length > 0) return code
    }
    return 'ADAPTER_EXECUTION_FAILED'
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
