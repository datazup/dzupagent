/**
 * Qwen CLI adapter (stub).
 *
 * Qwen models are primarily accessible via OpenAI-compatible API endpoints
 * (Alibaba Cloud DashScope or local deployments). There is no official
 * dedicated Qwen CLI agent SDK yet.
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
import { getNumber, getObject, getString, toJsonString } from '../utils/event-record.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'

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
  const type = getString(record, 'type', 'event')
  const tool = getObject(record, 'tool', 'function_call')
  const nestedResult = getObject(record, 'tool_result')

  switch (type) {
    case 'message':
    case 'response': {
      const content = getString(record, 'content', 'text', 'message') ?? ''
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
      const toolName = getString(record, 'name', 'tool_name', 'function')
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        input: record['arguments'] ?? record['parameters'] ?? record['input']
          ?? tool?.['arguments'] ?? tool?.['parameters'] ?? tool?.['input']
          ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result': {
      const toolName = getString(record, 'name', 'tool_name')
        ?? getString(nestedResult ?? {}, 'name', 'tool_name')
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      const output = toJsonString(
        record['output'] ?? record['result'] ?? record['content']
        ?? nestedResult?.['output'] ?? nestedResult?.['result'] ?? nestedResult?.['content']
        ?? '',
      )
      return {
        type: 'adapter:tool_result',
        providerId: PROVIDER_ID,
        toolName,
        output,
        durationMs: getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms')
          ?? getNumber(nestedResult ?? {}, 'duration_ms', 'durationMs', 'elapsed_ms')
          ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'stream_delta':
    case 'delta':
    case 'stream': {
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
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result: getString(record, 'result', 'content', 'output', 'text') ?? '',
        durationMs: getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      const errorMsg = getString(record, 'message', 'error')
      const errorObj = getObject(record, 'error')
      return {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: typeof errorMsg === 'string'
          ? errorMsg
          : typeof errorObj?.['message'] === 'string'
            ? errorObj['message']
          : 'Unknown Qwen CLI error',
        code: getString(record, 'code')
          ?? getString(errorObj ?? {}, 'code'),
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

export class QwenAdapter extends BaseCliAdapter {
  constructor(config: AdapterConfig = {}) {
    super(PROVIDER_ID, config)
  }

  protected getBinaryName(): string {
    return QWEN_BINARY
  }

  protected async assertReady(): Promise<void> {
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
  }

  protected getUnavailableBinaryMessage(binary: string): string {
    return `'${binary}' binary not found in PATH. ` +
      'Qwen models can be accessed via ModelRegistry with OpenAI-compatible provider.'
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapQwenEvent(record, sessionId)
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

  protected buildArgs(input: AgentInput): string[] {
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

  protected buildEnv(): Record<string, string> {
    const env = super.buildEnv()

    if (this.config.apiKey) {
      // DashScope uses DASHSCOPE_API_KEY
      env['DASHSCOPE_API_KEY'] = this.config.apiKey
    }

    return env
  }
}
