import { getString, getNumber, getObject, toJsonString } from './event-record.js'
import type { AdapterProviderId, AgentEvent, TokenUsage } from '../types.js'

export function readTextLikeValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return getString(record, 'text', 'content', 'message', 'result', 'output')
      ?? readTextLikeValue(record['text'])
      ?? readTextLikeValue(record['content'])
      ?? readTextLikeValue(record['message'])
      ?? readTextLikeValue(record['result'])
      ?? readTextLikeValue(record['output'])
      ?? toJsonString(value)
  }
  return undefined
}

export function readTextLike(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const text = readTextLikeValue(record[key])
    if (text !== undefined) {
      return text
    }
  }
  return undefined
}

export function serializeProviderPayload(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    return toJsonString(value)
  }
  return undefined
}

export function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return getString(record, 'message', 'error', 'detail', 'description')
      ?? readErrorMessage(record['error'])
      ?? readErrorMessage(record['cause'])
  }
  return undefined
}

export function readErrorCode(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return getString(record, 'code', 'error_code', 'status')
      ?? readErrorCode(record['error'])
      ?? readErrorCode(record['cause'])
  }
  return undefined
}

/**
 * Extract a usage record from a raw provider record.
 *
 * Checks common field names used by OpenAI-compatible CLIs.
 */
function readUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/**
 * Extract a normalized {@link TokenUsage} from a raw provider JSONL record.
 *
 * Checks common field names used by OpenAI-compatible CLIs
 * (usage, token_usage, tokenUsage, metrics).
 */
export function extractUsage(record: Record<string, unknown>): TokenUsage | undefined {
  const usage =
    readUsageRecord(record['usage']) ??
    readUsageRecord(record['token_usage']) ??
    readUsageRecord(record['tokenUsage']) ??
    readUsageRecord(record['metrics'])
  if (!usage) return undefined

  const inputTokens = getNumber(usage, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens')
  const outputTokens = getNumber(usage, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens')
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined
  }

  const result: TokenUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }

  const cachedInputTokens = getNumber(usage, 'cached_input_tokens', 'cachedInputTokens')
  if (cachedInputTokens !== undefined) {
    result.cachedInputTokens = cachedInputTokens
  }

  const costCents = getNumber(usage, 'cost_cents', 'costCents')
  if (costCents !== undefined) {
    result.costCents = costCents
  }

  return result
}

/**
 * Configuration for provider-specific differences in CLI event mapping.
 */
export interface CliEventMappingConfig {
  /** Provider ID to stamp on every event. */
  providerId: AdapterProviderId
  /** Extra field names to check when resolving tool_call name (e.g. `['function']` for Qwen). */
  extraToolNameKeys?: string[] | undefined
  /** Default error message when no error text can be extracted. */
  defaultErrorMessage?: string | undefined
}

/**
 * Generic JSONL-to-AgentEvent mapper for OpenAI-compatible CLI adapters.
 *
 * Covers the common event shapes emitted by Qwen, Crush, and similar CLI tools.
 * Provider-specific differences are captured in {@link CliEventMappingConfig}.
 */
export function mapCliProviderEvent(
  record: Record<string, unknown>,
  sessionId: string,
  config: CliEventMappingConfig,
): AgentEvent | undefined {
  const { providerId, extraToolNameKeys = [], defaultErrorMessage = 'Unknown CLI error' } = config
  const type = getString(record, 'type', 'event')
  const tool = getObject(record, 'tool', 'function_call')
  const nestedResult = getObject(record, 'tool_result', 'function_response')

  switch (type) {
    case 'message':
    case 'response': {
      const content = readTextLike(record, 'content', 'text', 'message') ?? ''
      const role = record['role'] === 'user' || record['role'] === 'system'
        ? record['role']
        : 'assistant' as const
      return {
        type: 'adapter:message',
        providerId,
        content,
        role,
        timestamp: Date.now(),
      }
    }

    case 'tool_call':
    case 'function_call': {
      const toolName = getString(record, 'name', 'tool_name', ...extraToolNameKeys)
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      return {
        type: 'adapter:tool_call',
        providerId,
        toolName,
        input: record['arguments'] ?? record['parameters'] ?? record['input']
          ?? tool?.['arguments'] ?? tool?.['parameters'] ?? tool?.['input']
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
      const output = readTextLike(record, 'output', 'result', 'content', 'text')
        ?? readTextLike(nestedResult ?? {}, 'output', 'result', 'content', 'text')
        ?? ''
      return {
        type: 'adapter:tool_result',
        providerId,
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
      const content = readTextLike(record, 'content', 'text', 'delta') ?? ''
      return {
        type: 'adapter:stream_delta',
        providerId,
        content,
        timestamp: Date.now(),
      }
    }

    case 'done':
    case 'completed': {
      return {
        type: 'adapter:completed',
        providerId,
        sessionId,
        result: readTextLike(record, 'result', 'content', 'output', 'text') ?? '',
        usage: extractUsage(record),
        durationMs: getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      const errorValue = record['error']
      const errorObj = getObject(record, 'error')
      return {
        type: 'adapter:failed',
        providerId,
        sessionId,
        error: readErrorMessage(errorValue)
          ?? getString(record, 'message', 'error')
          ?? defaultErrorMessage,
        code: getString(record, 'code')
          ?? readErrorCode(errorValue)
          ?? getString(errorObj ?? {}, 'code'),
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}
