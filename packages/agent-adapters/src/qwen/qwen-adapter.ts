/**
 * Qwen CLI adapter (stub).
 *
 * Qwen models are primarily accessible via OpenAI-compatible API endpoints
 * (Alibaba Cloud DashScope or local deployments). There is no official
 * dedicated Qwen CLI agent SDK yet.
 *
 * This adapter:
 * - Spawns the `qwen` CLI binary if available
 * - Parses JSONL output from stdout
 * - Falls back with a clear error indicating that Qwen models should be
 *   accessed via ModelRegistry's OpenAI-compatible provider (baseUrl override)
 *
 * TODO: Replace child_process spawning with official Qwen Agent SDK once available.
 * TODO: Add support for DashScope-specific features (long-context, code interpreter).
 * TODO: Map Qwen-specific tool call formats to AgentEvent.
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

const PROVIDER_ID: AdapterProviderId = 'qwen'
const QWEN_BINARY = 'qwen'

/**
 * Map a raw JSONL record from the Qwen CLI to an AgentEvent.
 *
 * TODO: Update event mapping once the Qwen CLI stabilizes its output schema.
 */
function mapQwenEvent(
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
      // TODO: Map Qwen-specific tool call format
      const toolName = typeof record['name'] === 'string'
        ? record['name']
        : typeof record['function'] === 'string'
          ? record['function']
          : 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        input: record['arguments'] ?? record['parameters'] ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result': {
      // TODO: Map Qwen-specific tool result format
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
          : 'Unknown Qwen CLI error',
        code: typeof record['code'] === 'string' ? record['code'] : undefined,
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

/**
 * Qwen CLI agent adapter (stub implementation).
 *
 * Spawns the `qwen` binary if available and streams JSONL output. If the binary
 * is not installed, throws ADAPTER_SDK_NOT_INSTALLED with a suggestion to use
 * the OpenAI-compatible provider via ModelRegistry instead.
 *
 * TODO: Replace with official Qwen Agent SDK integration when available.
 */
export class QwenAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = PROVIDER_ID

  private config: AdapterConfig
  private currentAbortController: AbortController | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()

    // Check binary availability upfront to give a helpful error message
    const available = await isBinaryAvailable(QWEN_BINARY)
    if (!available) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${QWEN_BINARY}' binary not found in PATH`,
        recoverable: false,
        suggestion:
          'Install the Qwen CLI, or use Qwen models via ModelRegistry with an ' +
          'OpenAI-compatible provider (set baseUrl to your DashScope or local endpoint)',
        context: { command: QWEN_BINARY, providerId: PROVIDER_ID },
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

      for await (const record of spawnAndStreamJsonl(QWEN_BINARY, args, {
        cwd: input.workingDirectory ?? this.config.workingDirectory,
        env,
        signal: combinedSignal,
        timeoutMs: this.config.timeoutMs,
      })) {
        const event = mapQwenEvent(record, sessionId)
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
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    // TODO: Implement session resume once Qwen CLI supports it
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
    const cliAvailable = await isBinaryAvailable(QWEN_BINARY)
    return {
      healthy: cliAvailable,
      providerId: PROVIDER_ID,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable
        ? undefined
        : `'${QWEN_BINARY}' binary not found in PATH. ` +
          'Qwen models can be accessed via ModelRegistry with OpenAI-compatible provider.',
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  /**
   * Build CLI arguments from the agent input.
   *
   * TODO: Update argument mapping once the Qwen CLI stabilizes.
   */
  private buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    // TODO: Confirm output format flag name for Qwen CLI
    args.push('--output-format', 'jsonl')

    if (input.prompt) {
      args.push('--prompt', input.prompt)
    }

    if (input.resumeSessionId) {
      args.push('--session', input.resumeSessionId)
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

    return args
  }

  /** Build environment variables for the child process. */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }

    if (this.config.apiKey) {
      // DashScope uses DASHSCOPE_API_KEY
      env['DASHSCOPE_API_KEY'] = this.config.apiKey
    }

    if (this.config.env) {
      Object.assign(env, this.config.env)
    }

    return env
  }
}
