/**
 * Google Gemini SDK adapter using @google/generative-ai.
 *
 * The SDK is an optional peer dependency and is loaded dynamically.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core/events'
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  AgentCLIAdapter,
} from '../types.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type {
  AdapterStreamSource,
  StreamContext,
} from '../base/stream-runner.js'

// SDK type stubs (for dynamic import)
interface GeminiSDK {
  getGenerativeModel(config: {
    model: string
    systemInstruction?: string
    generationConfig?: {
      responseMimeType?: string
      responseSchema?: Record<string, unknown>
    }
  }): GeminiModel
}
interface GeminiModel {
  generateContentStream(
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<GeminiStreamResult>
}
interface GeminiStreamResult {
  stream: AsyncIterable<GeminiChunk>
  response: Promise<GeminiResponse>
}
interface GeminiChunk {
  text(): string
  functionCalls?(): Array<{ name: string; args: Record<string, unknown> }> | undefined
}
interface GeminiResponse {
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

export interface GeminiSDKAdapterConfig extends AdapterConfig {
  /** Google API key. Falls back to GOOGLE_API_KEY env var. */
  googleApiKey?: string
  /** Max context tokens. Default: 2_000_000 */
  maxContextTokens?: number
}

const DEFAULT_MODEL = 'gemini-3-pro-preview'

/** Internal raw events streamed from open() through the runner. */
type GeminiRawEvent =
  | { kind: 'chunk'; text: string; calls?: Array<{ name: string; args: Record<string, unknown> }> }
  | { kind: 'completed'; fullText: string; usage?: { inputTokens: number; outputTokens: number }; durationMs: number }

export class GeminiSDKAdapter implements AgentCLIAdapter, AdapterStreamSource<GeminiRawEvent> {
  readonly providerId = 'gemini-sdk' as const
  private sdk?: GeminiSDK
  private currentController?: AbortController
  private currentSessionId = ''
  private currentModelName = DEFAULT_MODEL
  private currentStartTime = 0
  private currentFullText = ''

  constructor(private config: GeminiSDKAdapterConfig = {}) {}

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      maxContextTokens: this.config.maxContextTokens ?? 2_000_000,
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    // Eagerly load the SDK so any failure surfaces synchronously on first .next().
    await this.loadSDK()

    this.currentSessionId = randomUUID()
    this.currentModelName = this.config.model ?? DEFAULT_MODEL
    this.currentStartTime = Date.now()
    this.currentFullText = ''

    const runner = new AdapterStreamRunner<GeminiRawEvent>({
      emitStartedImmediately: true,
      emitFailedOnAbort: true,
      initialSessionId: this.currentSessionId,
      startedExtra: { model: this.currentModelName },
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
  // AdapterStreamSource<GeminiRawEvent>
  // -----------------------------------------------------------------------

  async *open(input: AgentInput, signal: AbortSignal): AsyncIterable<GeminiRawEvent> {
    const sdk = await this.loadSDK()
    const model = sdk.getGenerativeModel({
      model: this.currentModelName,
      ...(input.systemPrompt !== undefined
        ? { systemInstruction: String(new SystemPromptBuilder(input.systemPrompt).buildFor('gemini-sdk')) }
        : {}),
      ...(input.outputSchema !== undefined
        ? {
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: input.outputSchema,
            },
          }
        : {}),
    })

    const result = await model.generateContentStream(input.prompt, { signal })

    for await (const chunk of result.stream) {
      if (signal.aborted) break

      const text = chunk.text()
      const calls = chunk.functionCalls?.()
      yield {
        kind: 'chunk',
        text,
        ...(calls ? { calls } : {}),
      }
    }

    const response = await result.response
    const usage = response.usageMetadata
    yield {
      kind: 'completed',
      fullText: this.currentFullText,
      ...(usage
        ? {
            usage: {
              inputTokens: usage.promptTokenCount,
              outputTokens: usage.candidatesTokenCount,
            },
          }
        : {}),
      durationMs: Date.now() - this.currentStartTime,
    }
  }

  mapRawEvent(raw: GeminiRawEvent, context: StreamContext): AgentEvent | AgentEvent[] | null {
    if (!context.sessionId) {
      context.sessionId = this.currentSessionId
    }
    const input = context.input

    if (raw.kind === 'chunk') {
      const events: AgentEvent[] = []
      if (raw.text) {
        this.currentFullText += raw.text
        events.push({
          type: 'adapter:stream_delta',
          providerId: 'gemini-sdk',
          content: raw.text,
          timestamp: Date.now(),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        })
      }
      if (raw.calls) {
        for (const call of raw.calls) {
          events.push({
            type: 'adapter:tool_call',
            providerId: 'gemini-sdk',
            toolName: call.name,
            input: call.args,
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          })
        }
      }
      return events.length === 0 ? null : events
    }

    // raw.kind === 'completed'
    return {
      type: 'adapter:completed',
      providerId: 'gemini-sdk',
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
      message: 'Gemini SDK does not support session resume',
      recoverable: false,
      suggestion: 'Use GeminiCLIAdapter for session support',
      context: { providerId: 'gemini-sdk', model: this.config.model ?? DEFAULT_MODEL, operation: 'resumeSession' },
    })
  }

  interrupt(): void {
    this.currentController?.abort()
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.loadSDK()
      return {
        healthy: true,
        providerId: 'gemini-sdk',
        sdkInstalled: true,
        cliAvailable: false,
        monitorStatus: getDefaultMonitorStatus('gemini-sdk'),
      }
    } catch {
      return {
        healthy: false,
        providerId: 'gemini-sdk',
        sdkInstalled: false,
        cliAvailable: false,
        lastError: '@google/generative-ai not installed',
        monitorStatus: getDefaultMonitorStatus('gemini-sdk'),
      }
    }
  }

  configure(opts: Partial<GeminiSDKAdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  async warmup(): Promise<void> {
    await this.loadSDK()
  }

  private async loadSDK(): Promise<GeminiSDK> {
    if (this.sdk) return this.sdk
    try {
      const mod = await import(/* webpackIgnore: true */ '@google/generative-ai')
      const apiKey =
        this.config.googleApiKey ?? this.config.apiKey ?? process.env['GOOGLE_API_KEY']
      if (!apiKey) {
        throw new ForgeError({
          code: 'ADAPTER_SDK_NOT_INSTALLED',
          message:
            'Google API key required. Set GOOGLE_API_KEY or pass googleApiKey in config.',
          recoverable: false,
          context: { providerId: 'gemini-sdk', reason: 'missing_api_key' },
        })
      }
      this.sdk = new mod.GoogleGenerativeAI(apiKey) as unknown as GeminiSDK
      return this.sdk
    } catch {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message:
          'Failed to load @google/generative-ai. Install it: yarn add @google/generative-ai',
        recoverable: false,
        suggestion: 'yarn add @google/generative-ai',
        context: { providerId: 'gemini-sdk', sdkPackage: '@google/generative-ai' },
      })
    }
  }
}
