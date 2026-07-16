import type { AgentEvent } from '@dzupagent/adapter-types'
import { getNumber, getObject, getString } from './utils/event-record.js'
import {
  extractUsage,
  readErrorCode,
  readErrorMessage,
  serializeProviderPayload,
} from './utils/provider-event-normalization.js'

// Codex SDK — item shapes from @openai/codex-sdk.
export function normalizeCodex(
  record: Record<string, unknown>,
  fallbackSessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type')
  if (!type) return null

  const sessionId =
    getString(record, 'thread_id', 'threadId', 'session_id', 'sessionId') ?? fallbackSessionId

  switch (type) {
    case 'item.started':
    case 'item.completed': {
      const item = getObject(record, 'item')
      return item ? normalizeCodex(item, sessionId) : null
    }

    case 'thread_started':
    case 'thread.started': {
      if (!sessionId) return null
      return {
        type: 'adapter:started',
        providerId: 'codex',
        sessionId,
        timestamp: Date.now(),
      }
    }

    case 'agent_message':
    case 'agent.message': {
      return {
        type: 'adapter:message',
        providerId: 'codex',
        content: getString(record, 'text', 'content') ?? '',
        role: 'assistant',
        timestamp: Date.now(),
      }
    }

    case 'agent_message_delta':
    case 'stream_delta': {
      const delta = getString(record, 'delta', 'text') ?? ''
      return {
        type: 'adapter:stream_delta',
        providerId: 'codex',
        content: delta,
        timestamp: Date.now(),
      }
    }

    case 'command_execution': {
      const status = getString(record, 'status')
      if (status === 'in_progress' || status === 'started') {
        return {
          type: 'adapter:tool_call',
          providerId: 'codex',
          toolName: 'shell',
          input: { command: getString(record, 'command') ?? '' },
          timestamp: Date.now(),
        }
      }
      return {
        type: 'adapter:tool_result',
        providerId: 'codex',
        toolName: 'shell',
        output: getString(record, 'aggregated_output', 'output') ?? '',
        durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'mcp_tool_call': {
      const tool = getString(record, 'tool', 'toolName') ?? 'unknown'
      const server = getString(record, 'server', 'serverName')
      const toolName = server ? `${server}/${tool}` : tool
      const status = getString(record, 'status')
      if (status === 'completed' || status === 'failed') {
        const result = getObject(record, 'result')
        const output = status === 'failed'
          ? `MCP_TOOL_FAILED:${safeMcpFailureCode(readErrorMessage(record['error']))}`
          : serializeProviderPayload(result?.['structured_content'] ?? result?.['content'] ?? '') ?? ''
        return {
          type: 'adapter:tool_result',
          providerId: 'codex',
          toolName,
          output,
          durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
          timestamp: Date.now(),
        }
      }
      return {
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName,
        input: record['arguments'] ?? {},
        timestamp: Date.now(),
      }
    }

    case 'file_change': {
      return {
        type: 'adapter:tool_result',
        providerId: 'codex',
        toolName: 'file_change',
        output: serializeProviderPayload(record['changes']) ?? '',
        durationMs: 0,
        timestamp: Date.now(),
      }
    }

    case 'turn_completed':
    case 'turn.completed':
    case 'run_completed':
    case 'thread.completed': {
      return {
        type: 'adapter:completed',
        providerId: 'codex',
        sessionId,
        result: getString(record, 'result', 'final_text', 'text') ?? '',
        usage: extractUsage(record),
        durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error':
    case 'turn_failed':
    case 'thread.failed': {
      return {
        type: 'adapter:failed',
        providerId: 'codex',
        sessionId,
        error:
          readErrorMessage(record['error']) ??
          getString(record, 'message', 'error') ??
          'Unknown Codex error',
        code: readErrorCode(record['error']) ?? getString(record, 'code'),
        timestamp: Date.now(),
      }
    }

    default:
      return null
  }
}

function safeMcpFailureCode(value: string | undefined): string {
  const normalized = value?.toUpperCase().replace(/[^A-Z0-9_:.-]+/gu, '_').slice(0, 96) ?? ''
  return /^[A-Z0-9_:.-]{3,96}$/u.test(normalized) ? normalized : 'MCP_TOOL_ERROR'
}
