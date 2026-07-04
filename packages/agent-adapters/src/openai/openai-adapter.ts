/**
 * OpenAI adapter — thin wrapper around the OpenAI Chat Completions API.
 *
 * Uses native `fetch` directly (no external SDK dependency). Stream lifecycle
 * delegates to {@link AdapterStreamRunner}; this class implements
 * {@link AdapterStreamSource} so the runner owns abort control, heartbeat
 * detection, and adapter:started/completed/failed lifecycle events.
 *
 * Wire-format types, tool-call assembly, and HTTP/audit helpers live in
 * sibling modules (`./openai-types`, `./openai-tool-calls`, `./openai-http`)
 * after the MC-027a-1 split.
 */
import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'
import {
  DEFAULT_MODEL,
  type OpenAIConfig,
  type OpenAIRawEvent,
  type OpenAIRunResult,
} from './openai-types.js'
import { OpenAIToolCallAccumulator, resolveOpenAITools } from './openai-tool-calls.js'
import {
  buildOpenAIMessages,
  parseOpenAISSE,
  postChatCompletions,
  resolveOpenAIApiKey,
  runOpenAINonStreaming,
} from './openai-http.js'

export type {
  OpenAIConfig,
  OpenAIRunResult,
  OpenAIToolDefinition,
  OpenAIToolWire,
} from './openai-types.js'

export class OpenAIAdapter implements AgentCLIAdapter, AdapterStreamSource<OpenAIRawEvent> {
  readonly providerId: AdapterProviderId = 'openai'
  private currentController?: AbortController
  private currentSessionId = ''
  private currentModel = DEFAULT_MODEL
  private currentStartTime = 0
  private currentFullText = ''
  private toolCalls = new OpenAIToolCallAccumulator()

  constructor(private config: OpenAIConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: {
        mode: true,
        allowlist: true,
        blocklist: true,
      },
    }
  }

  /** Non-streaming convenience method returning the assembled content + usage. */
  async run(
    prompt: string,
    opts: { systemPrompt?: string; model?: string; signal?: AbortSignal } = {},
  ): Promise<OpenAIRunResult> {
    const model = opts.model ?? this.config.model ?? DEFAULT_MODEL
    return runOpenAINonStreaming({
      config: this.config,
      providerId: this.providerId,
      prompt,
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      model,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
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
    resolveOpenAIApiKey(this.config)

    this.currentSessionId = randomUUID()
    this.currentModel =
      (input.options?.['model'] as string | undefined) ?? this.config.model ?? DEFAULT_MODEL
    this.currentStartTime = Date.now()
    this.currentFullText = ''
    this.toolCalls.reset()

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
    const tools = resolveOpenAITools(input)
    const toolChoice = input.options?.['tool_choice']
    const response = await postChatCompletions({
      config: this.config,
      messages: buildOpenAIMessages(input.prompt, input.systemPrompt),
      model: this.currentModel,
      stream: true,
      signal,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(tools && tools.length > 0 && toolChoice !== undefined ? { toolChoice } : {}),
    })

    let usage: { inputTokens: number; outputTokens: number } | undefined

    for await (const chunk of parseOpenAISSE(response.body!, signal)) {
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
      const result = this.toolCalls.processSseChoice(choice, this.providerId, input.correlationId)
      this.currentFullText += result.appendedContent
      if (result.events.length === 0) return null
      if (result.events.length === 1) return result.events[0]!
      return result.events
    }

    // raw.kind === 'completed' — flush any tool calls not closed by an
    // explicit `finish_reason='tool_calls'` marker (some providers omit it).
    const flushed = this.toolCalls.flush(this.providerId, input.correlationId)
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
}
