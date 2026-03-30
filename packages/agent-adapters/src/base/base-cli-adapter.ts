import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzipagent/core'

import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AdapterCapabilityProfile,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'

interface NormalizedAdapterError {
  message: string
  code?: string
  original: unknown
}

/**
 * Shared base class for CLI-backed adapters (Gemini/Qwen/Crush).
 *
 * Centralizes:
 * - process spawn + JSONL stream loop
 * - started/completed/failed lifecycle events
 * - abort composition and interrupt behavior
 * - common health-check + configuration updates
 */
export abstract class BaseCliAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId

  protected config: AdapterConfig
  private currentAbortController: AbortController | null = null

  constructor(providerId: AdapterProviderId, config: AdapterConfig = {}) {
    this.providerId = providerId
    this.config = { ...config }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()

    await this.assertReady()

    yield {
      type: 'adapter:started',
      providerId: this.providerId,
      sessionId,
      timestamp: startTime,
    }

    this.currentAbortController = new AbortController()
    const combinedSignal = input.signal
      ? AbortSignal.any([this.currentAbortController.signal, input.signal])
      : this.currentAbortController.signal

    const args = this.buildArgs(input)
    const env = this.buildEnv()

    try {
      let hasCompleted = false

      for await (const record of spawnAndStreamJsonl(this.getBinaryName(), args, {
        cwd: input.workingDirectory ?? this.config.workingDirectory,
        env,
        signal: combinedSignal,
        timeoutMs: this.config.timeoutMs,
      })) {
        const event = this.mapProviderEvent(record, sessionId)
        if (!event) continue

        if (event.type === 'adapter:completed') {
          hasCompleted = true
        }
        yield event
      }

      if (!hasCompleted) {
        yield {
          type: 'adapter:completed',
          providerId: this.providerId,
          sessionId,
          result: '',
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        }
      }
    } catch (err: unknown) {
      const normalized = this.normalizeError(err)
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: normalized.message,
        code: normalized.code,
        timestamp: Date.now(),
      }

      if (this.shouldRethrow(normalized.original)) {
        throw normalized.original
      }
    } finally {
      this.currentAbortController = null
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const modifiedInput: AgentInput = {
      ...input,
      resumeSessionId: sessionId,
    }
    yield* this.execute(modifiedInput)
  }

  interrupt(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const binary = this.getBinaryName()
    const cliAvailable = await isBinaryAvailable(binary)
    return {
      healthy: cliAvailable,
      providerId: this.providerId,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable ? undefined : this.getUnavailableBinaryMessage(binary),
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  protected getUnavailableBinaryMessage(binary: string): string {
    return `'${binary}' binary not found in PATH`
  }

  protected buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    if (this.config.env) {
      Object.assign(env, this.config.env)
    }
    return env
  }

  protected normalizeError(err: unknown): NormalizedAdapterError {
    if (err instanceof Error) {
      return {
        message: err.message,
        code: ForgeError.is(err) ? err.code : undefined,
        original: err,
      }
    }
    return {
      message: String(err),
      code: undefined,
      original: err,
    }
  }

  protected shouldRethrow(err: unknown): boolean {
    return ForgeError.is(err)
  }

  protected async assertReady(): Promise<void> {
    // default: no preflight checks
  }

  protected abstract getBinaryName(): string
  protected abstract buildArgs(input: AgentInput): string[]
  protected abstract mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined
}
