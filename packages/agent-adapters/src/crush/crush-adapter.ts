/**
 * Crush adapter (stub).
 *
 * Crush is a local model runner optimized for code tasks and exposes a CLI.
 */

import { ForgeError } from '@dzipagent/core'

import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'

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

export class CrushAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super(PROVIDER_ID, config)
  }

  protected getBinaryName(): string {
    return CRUSH_BINARY
  }

  protected async assertReady(): Promise<void> {
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
  }

  async *resumeSession(
    _sessionId: string,
    _input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    throw new ForgeError({
      code: 'ADAPTER_SESSION_NOT_FOUND',
      message: 'Crush adapter does not support session resume yet',
      recoverable: false,
      suggestion: 'Start a new session instead',
      context: { providerId: PROVIDER_ID },
    })
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    }
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapCrushEvent(record, sessionId)
  }

  protected buildArgs(input: AgentInput): string[] {
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
}
