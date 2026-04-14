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
import { getNumber, getObject, getString } from '../utils/event-record.js'
import {
  readErrorCode,
  readErrorMessage,
  serializeProviderPayload,
} from '../utils/provider-event-normalization.js'

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
  const type = getString(record, 'type', 'event')
  const tool = getObject(record, 'tool', 'function_call')
  const nestedResult = getObject(record, 'tool_result', 'function_response')

  switch (type) {
    case 'message':
    case 'response': {
      const content = serializeProviderPayload(record['content'] ?? record['text'] ?? record['message'] ?? '')
        ?? ''
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
      const toolName = getString(record, 'name', 'tool_name')
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        input: record['arguments'] ?? record['input'] ?? record['parameters']
          ?? tool?.['arguments'] ?? tool?.['input'] ?? tool?.['parameters']
          ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result':
    case 'function_response': {
      const toolName = getString(record, 'name', 'tool_name')
        ?? getString(nestedResult ?? {}, 'name', 'tool_name')
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      const output = serializeProviderPayload(
        record['output'] ?? record['result'] ?? record['content']
        ?? nestedResult?.['output'] ?? nestedResult?.['result'] ?? nestedResult?.['content']
        ?? '',
      ) ?? ''
      const durationMs = getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms')
        ?? getNumber(nestedResult ?? {}, 'duration_ms', 'durationMs', 'elapsed_ms')
        ?? 0
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
      const content = getString(record, 'content', 'text', 'delta') ?? ''
      return {
        type: 'adapter:stream_delta',
        providerId: PROVIDER_ID,
        content,
        timestamp: Date.now(),
      }
    }

    case 'done':
    case 'completed': {
      const result = serializeProviderPayload(
        record['result'] ?? record['content'] ?? record['output'] ?? record['text'] ?? '',
      ) ?? ''
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result,
        durationMs: getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      const errorCode = readErrorCode(record)
      return {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: readErrorMessage(record) ?? 'Unknown Gemini CLI error',
        ...(errorCode !== undefined ? { code: errorCode } : {}),
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
