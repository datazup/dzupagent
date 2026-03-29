/**
 * Google Gemini CLI adapter.
 *
 * Invokes the `gemini` binary as a child process, parses JSONL output
 * from stdout, and maps events to the unified AgentEvent type.
 *
 * The Gemini CLI supports:
 * - Prompts via `-p` flag or stdin
 * - JSON output via `--output-format json`
 * - Sandboxing and tool use
 * - Session management (via session IDs)
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

const PROVIDER_ID: AdapterProviderId = 'gemini'
const GEMINI_BINARY = 'gemini'

/**
 * Map a raw JSONL record from the Gemini CLI to an AgentEvent.
 *
 * The exact JSONL schema depends on the Gemini CLI version. This function
 * handles the known event shapes and returns undefined for unrecognized records.
 */
function mapGeminiEvent(
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

    case 'tool_call':
    case 'function_call': {
      const toolName = typeof record['name'] === 'string'
        ? record['name']
        : typeof record['tool_name'] === 'string'
          ? record['tool_name']
          : 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        input: record['arguments'] ?? record['input'] ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result':
    case 'function_response': {
      const toolName = typeof record['name'] === 'string'
        ? record['name']
        : typeof record['tool_name'] === 'string'
          ? record['tool_name']
          : 'unknown'
      const output = typeof record['output'] === 'string'
        ? record['output']
        : typeof record['result'] === 'string'
          ? record['result']
          : JSON.stringify(record['output'] ?? record['result'] ?? '')
      const durationMs = typeof record['duration_ms'] === 'number'
        ? record['duration_ms']
        : 0
      return {
        type: 'adapter:tool_result',
        providerId: PROVIDER_ID,
        toolName,
        output,
        durationMs,
        timestamp: Date.now(),
      }
    }

    case 'stream_delta':
    case 'delta': {
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
      const result = typeof record['result'] === 'string'
        ? record['result']
        : typeof record['content'] === 'string'
          ? record['content']
          : ''
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result,
        durationMs: typeof record['duration_ms'] === 'number' ? record['duration_ms'] : 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      const errorMsg = typeof record['message'] === 'string'
        ? record['message']
        : typeof record['error'] === 'string'
          ? record['error']
          : 'Unknown Gemini CLI error'
      return {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: errorMsg,
        code: typeof record['code'] === 'string' ? record['code'] : undefined,
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

/**
 * Gemini CLI agent adapter.
 *
 * Spawns the `gemini` binary, streams JSONL output, and emits unified
 * AgentEvent records. Supports cancellation via AbortController.
 */
export class GeminiCLIAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = PROVIDER_ID

  private config: AdapterConfig
  private currentAbortController: AbortController | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sessionId = randomUUID()
    const startTime = Date.now()

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

      for await (const record of spawnAndStreamJsonl(GEMINI_BINARY, args, {
        cwd: input.workingDirectory ?? this.config.workingDirectory,
        env,
        signal: combinedSignal,
        timeoutMs: this.config.timeoutMs,
      })) {
        const event = mapGeminiEvent(record, sessionId)
        if (event) {
          if (event.type === 'adapter:completed') {
            hasCompleted = true
          }
          yield event
        }
      }

      // If the CLI finished without emitting a completed event, synthesize one
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

      // Re-throw ForgeErrors so callers can handle specific failure modes
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
    // Gemini CLI supports session resume via --session flag
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
    const cliAvailable = await isBinaryAvailable(GEMINI_BINARY)
    return {
      healthy: cliAvailable,
      providerId: PROVIDER_ID,
      sdkInstalled: cliAvailable,
      cliAvailable,
      lastError: cliAvailable ? undefined : `'${GEMINI_BINARY}' binary not found in PATH`,
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  /** Build CLI arguments from the agent input. */
  private buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    // Output format
    args.push('--output-format', 'json')

    // Prompt
    if (input.prompt) {
      args.push('-p', input.prompt)
    }

    // Session resume
    if (input.resumeSessionId) {
      args.push('--session', input.resumeSessionId)
    }

    // System prompt
    if (input.systemPrompt) {
      args.push('--system-prompt', input.systemPrompt)
    }

    // Model override
    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    // Sandbox mode
    if (this.config.sandboxMode) {
      const modeMap: Record<string, string> = {
        'read-only': 'sandbox',
        'workspace-write': 'workspace',
        'full-access': 'none',
      }
      const mapped = modeMap[this.config.sandboxMode]
      if (mapped) {
        args.push('--sandbox', mapped)
      }
    }

    // Max turns
    if (input.maxTurns !== undefined) {
      args.push('--max-turns', String(input.maxTurns))
    }

    return args
  }

  /** Build environment variables for the child process. */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }

    if (this.config.apiKey) {
      env['GEMINI_API_KEY'] = this.config.apiKey
    }

    if (this.config.env) {
      Object.assign(env, this.config.env)
    }

    return env
  }
}
