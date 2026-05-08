import type { AgentEvent } from '@dzupagent/adapter-types'
import { getNumber, getString } from './utils/event-record.js'
import {
  extractUsage,
  readErrorCode,
  readErrorMessage,
} from './utils/provider-event-normalization.js'

// Claude SDK — message shapes from @anthropic-ai/claude-agent-sdk.
export function normalizeClaude(
  record: Record<string, unknown>,
  fallbackSessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type')
  if (!type) return null

  const sessionId = getString(record, 'session_id', 'sessionId') ?? fallbackSessionId

  switch (type) {
    case 'system': {
      if (!sessionId) return null
      return {
        type: 'adapter:started',
        providerId: 'claude',
        sessionId,
        timestamp: Date.now(),
        ...(getString(record, 'model') && { model: getString(record, 'model') }),
      }
    }

    case 'assistant': {
      const content = record['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          const btype = getString(b, 'type')
          if (btype === 'text') {
            const text = getString(b, 'text') ?? ''
            return {
              type: 'adapter:message',
              providerId: 'claude',
              content: text,
              role: 'assistant',
              timestamp: Date.now(),
            }
          }
          if (btype === 'tool_use') {
            return {
              type: 'adapter:tool_call',
              providerId: 'claude',
              toolName: getString(b, 'name') ?? 'unknown',
              input: b['input'] ?? {},
              timestamp: Date.now(),
            }
          }
        }
      }
      return null
    }

    case 'tool_progress': {
      const toolName = getString(record, 'tool_name') ?? 'unknown'
      const status = getString(record, 'status')
      if (status === 'started') {
        return {
          type: 'adapter:tool_call',
          providerId: 'claude',
          toolName,
          input: record['input'] ?? {},
          timestamp: Date.now(),
        }
      }
      if (status === 'completed' || status === 'failed') {
        return {
          type: 'adapter:tool_result',
          providerId: 'claude',
          toolName,
          output: getString(record, 'output') ?? '',
          durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
          timestamp: Date.now(),
        }
      }
      return null
    }

    case 'stream_event': {
      const delta = getString(record, 'delta')
      if (delta === undefined) return null
      return {
        type: 'adapter:stream_delta',
        providerId: 'claude',
        content: delta,
        timestamp: Date.now(),
      }
    }

    case 'result': {
      const subtype = getString(record, 'subtype')
      const usage = extractUsage(record)
      if (subtype === 'error' || record['error']) {
        return {
          type: 'adapter:failed',
          providerId: 'claude',
          sessionId,
          error: readErrorMessage(record['error']) ?? getString(record, 'error') ?? 'Unknown Claude error',
          code: readErrorCode(record['error']),
          timestamp: Date.now(),
        }
      }
      return {
        type: 'adapter:completed',
        providerId: 'claude',
        sessionId,
        result: getString(record, 'result') ?? '',
        usage,
        durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
        timestamp: Date.now(),
      }
    }

    default:
      return null
  }
}
