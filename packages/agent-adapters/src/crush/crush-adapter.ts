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
import { getNumber, getObject, getString, toJsonString } from '../utils/event-record.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'

const PROVIDER_ID: AdapterProviderId = 'crush'
const CRUSH_BINARY = 'crush'

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10)
  }
  return undefined
}

/**
 * Map a raw JSONL record from the Crush CLI to an AgentEvent.
 *
 * TODO: Update event mapping once the Crush CLI output schema is documented.
 */
function mapCrushEvent(
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
          : 'Unknown Crush CLI error',
        code: getString(record, 'code')
          ?? getString(errorObj ?? {}, 'code'),
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

    const providerOpts = this.config.providerOptions ?? {}

    const quantization = getString(
      providerOpts,
      'quantization',
      'quant',
      'quantizationMode',
    )
    if (quantization && quantization.trim().length > 0) {
      args.push('--quantization', quantization)
    }

    const gpuLayers = parseNonNegativeInt(
      providerOpts['gpuLayers'] ?? providerOpts['gpu_layers'] ?? providerOpts['gpu-layers'],
    )
    if (gpuLayers !== undefined) {
      args.push('--gpu-layers', String(gpuLayers))
    }

    const contextSize = parseNonNegativeInt(
      providerOpts['contextSize'] ?? providerOpts['context_size'] ?? providerOpts['context-size'],
    )
    if (contextSize !== undefined && contextSize > 0) {
      args.push('--context-size', String(contextSize))
    }

    return args
  }
}
