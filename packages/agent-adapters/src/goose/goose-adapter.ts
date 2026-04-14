/**
 * Goose CLI adapter for headless agent execution.
 *
 * Goose is a CLI-based agent runtime that supports tool calls, streaming,
 * and session resume via the `goose run --headless` surface.
 */

import type {
  AdapterConfig,
  AdapterCapabilityProfile,
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

const GOOSE_BINARY = 'goose'

/**
 * Map a raw JSONL record from the Goose CLI to an AgentEvent.
 */
function mapGooseEvent(
  record: Record<string, unknown>,
  sessionId: string,
): AgentEvent | undefined {
  const type = getString(record, 'type', 'event')

  switch (type) {
    case 'message':
    case 'response': {
      const content = serializeProviderPayload(record['content'] ?? record['text'] ?? '') ?? ''
      return {
        type: 'adapter:message',
        providerId: 'goose',
        content,
        role: record['role'] === 'user' ? 'user' : 'assistant',
        timestamp: Date.now(),
      }
    }

    case 'tool_call':
    case 'function_call': {
      const tool = getObject(record, 'tool', 'function_call') ?? record
      return {
        type: 'adapter:tool_call',
        providerId: 'goose',
        toolName: getString(tool, 'name', 'tool') ?? 'unknown',
        input: tool['arguments'] ?? tool['input'] ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result':
    case 'function_response': {
      const result = getObject(record, 'tool_result', 'function_response') ?? record
      return {
        type: 'adapter:tool_result',
        providerId: 'goose',
        toolName: getString(result, 'name', 'tool') ?? 'unknown',
        output: serializeProviderPayload(result['output'] ?? result['content'] ?? '') ?? '',
        durationMs: getNumber(result, 'duration_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'completed':
    case 'done': {
      return {
        type: 'adapter:completed',
        providerId: 'goose',
        sessionId,
        result: serializeProviderPayload(record['result'] ?? record['output'] ?? '') ?? '',
        durationMs: getNumber(record, 'duration_ms', 'elapsed_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      return {
        type: 'adapter:failed',
        providerId: 'goose',
        error: readErrorMessage(record) ?? 'Unknown error',
        code: readErrorCode(record),
        timestamp: Date.now(),
      }
    }

    case 'stream_delta':
    case 'delta': {
      const content = serializeProviderPayload(record['content'] ?? record['text'] ?? record['delta'] ?? '') ?? ''
      if (!content) return undefined
      return {
        type: 'adapter:stream_delta',
        providerId: 'goose',
        content,
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

export class GooseAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super('goose', config)
  }

  protected getBinaryName(): string {
    return GOOSE_BINARY
  }

  protected buildArgs(input: AgentInput): string[] {
    const args = ['run', '--headless', '--output-format', 'jsonl']

    if (input.systemPrompt) {
      args.push('--system', input.systemPrompt)
    }

    if (input.workingDirectory) {
      args.push('--working-directory', input.workingDirectory)
    }

    if (input.options?.['recipe']) {
      args.push('--recipe', String(input.options['recipe']))
    }

    if (input.options?.['permissionMode']) {
      args.push('--permission-mode', String(input.options['permissionMode']))
    }

    if (input.maxTurns) {
      args.push('--max-turns', String(input.maxTurns))
    }

    if (input.resumeSessionId) {
      args.push('--session', input.resumeSessionId)
    }

    args.push('--prompt', input.prompt)

    return args
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapGooseEvent(record, sessionId)
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    }
  }
}
