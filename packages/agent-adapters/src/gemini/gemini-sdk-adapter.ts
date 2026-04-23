/**
 * Google Gemini SDK adapter using @google/generative-ai.
 *
 * The SDK is an optional peer dependency and is loaded dynamically.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core'
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  AgentCLIAdapter,
} from '../types.js'

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

export class GeminiSDKAdapter implements AgentCLIAdapter {
  readonly providerId = 'gemini-sdk' as const
  private sdk?: GeminiSDK
  private currentController?: AbortController

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
    const sdk = await this.loadSDK()
    const model = sdk.getGenerativeModel({
      model: this.config.model ?? 'gemini-3-pro-preview',
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

    const sessionId = randomUUID()
    this.currentController = new AbortController()
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.currentController.signal])
      : this.currentController.signal

    yield {
      type: 'adapter:started',
      providerId: 'gemini-sdk',
      sessionId,
      timestamp: Date.now(),
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      model: this.config.model ?? 'gemini-3-pro-preview',
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
      isResume: false,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }

    const startTime = Date.now()
    let fullText = ''

    try {
      const result = await model.generateContentStream(input.prompt, { signal })

      for await (const chunk of result.stream) {
        if (signal.aborted) break

        const text = chunk.text()
        if (text) {
          fullText += text
          yield {
            type: 'adapter:stream_delta',
            providerId: 'gemini-sdk',
            content: text,
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
        }

        const calls = chunk.functionCalls?.()
        if (calls) {
          for (const call of calls) {
            yield {
              type: 'adapter:tool_call',
              providerId: 'gemini-sdk',
              toolName: call.name,
              input: call.args,
              timestamp: Date.now(),
              ...(input.correlationId ? { correlationId: input.correlationId } : {}),
            }
          }
        }
      }

      const response = await result.response
      const usage = response.usageMetadata

      yield {
        type: 'adapter:completed',
        providerId: 'gemini-sdk',
        sessionId,
        result: fullText,
        durationMs: Date.now() - startTime,
        ...(usage
          ? {
              usage: {
                inputTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
              },
            }
          : {}),
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
    } catch (err) {
      if (signal.aborted) {
        yield {
          type: 'adapter:failed',
          providerId: 'gemini-sdk',
          sessionId,
          error: 'Execution aborted',
          code: 'AGENT_ABORTED',
          timestamp: Date.now(),
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        }
        return
      }
      yield {
        type: 'adapter:failed',
        providerId: 'gemini-sdk',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
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
      context: { providerId: 'gemini-sdk', model: this.config.model ?? 'gemini-3-pro-preview', operation: 'resumeSession' },
    })
  }

  interrupt(): void {
    this.currentController?.abort()
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.loadSDK()
      return { healthy: true, providerId: 'gemini-sdk', sdkInstalled: true, cliAvailable: false }
    } catch {
      return {
        healthy: false,
        providerId: 'gemini-sdk',
        sdkInstalled: false,
        cliAvailable: false,
        lastError: '@google/generative-ai not installed',
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
