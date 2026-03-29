/**
 * Crush adapter (stub).
 *
 * Crush is a local model runner optimized for code tasks. It runs models
 * locally and exposes a CLI interface with JSONL output.
 *
 * This is a stub implementation with TODO markers for areas that need
 * completion once the Crush CLI stabilizes.
 *
 * TODO: Finalize CLI argument mapping once Crush CLI reaches a stable release.
 * TODO: Add support for Crush-specific features (model selection, quantization).
 * TODO: Map Crush-specific event types to AgentEvent.
 * TODO: Implement session management if/when Crush supports it.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzipagent/core'
import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'

const PROVIDER_ID: AdapterProviderId = 'crush'
const CRUSH_BINARY = 'crush'

/**
 * Map a raw JSONL record from the Crush CLI to an AgentEvent.
 *
 * TODO: Update event mapping once the Crush CLI output schema is documented.
 */
function mapCrushEvent(
  record: Record<string, unknown>,
  sessionId: string,
): AgentEvent | undefined {
  const type = typeof record['type'] === 'string' ? record['type'] : undefined

  switch (type) {
    case 'message':
    case 'response': {
      const content = typeof record['content'] === 'string' ? record['content'] : ''
      const role = record['role'] === 'user' || record['role'] === 'system'
        ? record['role']
        : 'assistant' as const
      return {
        type: 'adapter:message',
        providerId: PROVIDER_ID,
        content,
        role,
        timestamp: Date.now(),
      }
    }

    case 'tool_call': {
      // TODO: Confirm Crush tool call format
      const toolName = typeof record['name'] === 'string' ? record['name'] : 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        input: record['arguments'] ?? record['input'] ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result': {
      // TODO: Confirm Crush tool result format
      const toolName = typeof record['name'] === 'string' ? record['name'] : 'unknown'
      const output = typeof record['output'] === 'string'
        ? record['output']
        : JSON.stringify(record['output'] ?? '')
      return {
        type: 'adapter:tool_result',
        providerId: PROVIDER_ID,
        toolName,
        output,
        durationMs: typeof record['duration_ms'] === 'number' ? record['duration_ms'] : 0,
        timestamp: Date.now(),
      }
    }

    case 'delta':
    case 'stream': {
      const content = typeof record['content'] === 'string'
        ? record['content']
        : typeof record['text'] === 'string'
          ? record['text']
          : ''
      return {
        type: 'adapter:stream_delta',
        providerId: PROVIDER_ID,
        content,
        timestamp: Date.now(),
      }
    }

    case 'done':
    case 'completed': {
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result: typeof record['result'] === 'string' ? record['result'] : '',
        durationMs: typeof record['duration_ms'] === 'number' ? record['duration_ms'] : 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      return {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: typeof record['message'] === 'string'
          ? record['message']
          : 'Unknown Crush CLI error',
        code: typeof record['code'] === 'string' ? record['code'] : undefined,
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

/**
 * Crush CLI agent adapter (stub implementation).
 *
 * Spawns the `crush` binary if available and streams JSONL output.
 * Crush runs models locally, so no API key is typically required.
 *
 * TODO: Replace stub with full implementation once Crush CLI is stable.
 */
export class CrushAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = PROVIDER_ID

  private config: AdapterConfig
  private currentAbortController: AbortController | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()

    // Check binary availability upfront
    const available = await isBinaryAvailable(CRUSH_BINARY)
    if (!available) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${CRUSH_BINARY}' binary not found in PATH`,
        recoverable: false,
        suggestion: 'Install the Crush local model runner and ensure it is available in PATH',
        context: { command: CRUSH_BINARY, providerId: PROVIDER_ID },
      })
    }

    yield {
      type: 'adapter:started',
      providerId: PROVIDER_ID,
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

      for await (const record of spawnAndStreamJsonl(CRUSH_BINARY, args, {
        cwd: input.workingDirectory ?? this.config.workingDirectory,
        env,
        signal: combinedSignal,
        timeoutMs: this.config.timeoutMs,
      })) {
        const event = mapCrushEvent(record, sessionId)
        if (event) {
          if (event.type === 'adapter:completed') {
            hasCompleted = true
          }
          yield event
        }
      }

      if (!hasCompleted) {
        yield {
          type: 'adapter:completed',
          providerId: PROVIDER_ID,
          sessionId,
          result: '',
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      yield {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: message,
        code: ForgeError.is(err) ? err.code : undefined,
        timestamp: Date.now(),
      }

      if (ForgeError.is(err)) {
        throw err
      }
    } finally {
      this.currentAbortController = null
    }
  }

  async *resumeSession(
    _sessionId: string,
    _input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    // TODO: Implement session resume once Crush CLI supports it
    throw new ForgeError({
      code: 'ADAPTER_SESSION_NOT_FOUND',
      message: 'Crush adapter does not support session resume yet',
      recoverable: false,
      suggestion: 'Start a new session instead',
      context: { providerId: PROVIDER_ID },
    })
  }

  interrupt(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const cliAvailable = await isBinaryAvailable(CRUSH_BINARY)
    return {
      healthy: cliAvailable,
      providerId: PROVIDER_ID,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable
        ? undefined
        : `'${CRUSH_BINARY}' binary not found in PATH`,
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  /**
   * Build CLI arguments from the agent input.
   *
   * TODO: Confirm argument mapping once Crush CLI is documented.
   */
  private buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    // TODO: Confirm output format flag for Crush CLI
    args.push('--output-format', 'jsonl')

    if (input.prompt) {
      args.push('--prompt', input.prompt)
    }

    if (input.systemPrompt) {
      args.push('--system', input.systemPrompt)
    }

    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    if (input.maxTurns !== undefined) {
      args.push('--max-turns', String(input.maxTurns))
    }

    // TODO: Add Crush-specific flags (quantization, GPU layers, context size, etc.)

    return args
  }

  /** Build environment variables for the child process. */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }

    // Crush runs locally and typically does not need an API key,
    // but pass through any configured env vars.
    if (this.config.env) {
      Object.assign(env, this.config.env)
    }

    return env
  }
}
