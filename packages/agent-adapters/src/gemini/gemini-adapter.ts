/**
 * Google Gemini CLI adapter.
 */

import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter } from '../base/base-cli-adapter.js'

const PROVIDER_ID: AdapterProviderId = 'gemini'
const GEMINI_BINARY = 'gemini'

/**
 * Map a raw JSONL record from the Gemini CLI to an AgentEvent.
 *
 * The exact JSONL schema depends on the Gemini CLI version. This function
 * handles known event shapes and ignores unknown records.
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

export class GeminiCLIAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super(PROVIDER_ID, config)
  }

  protected getBinaryName(): string {
    return GEMINI_BINARY
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapGeminiEvent(record, sessionId)
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

  protected buildArgs(input: AgentInput): string[] {
    const args: string[] = []

    args.push('--output-format', 'json')

    if (input.prompt) {
      args.push('-p', input.prompt)
    }

    if (input.resumeSessionId) {
      args.push('--session', input.resumeSessionId)
    }

    if (input.systemPrompt) {
      args.push('--system-prompt', input.systemPrompt)
    }

    if (this.config.model) {
      args.push('--model', this.config.model)
    }

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

    if (input.maxTurns !== undefined) {
      args.push('--max-turns', String(input.maxTurns))
    }

    return args
  }
}
