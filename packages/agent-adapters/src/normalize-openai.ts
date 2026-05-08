import type { AgentEvent } from '@dzupagent/adapter-types'
import { getNumber, getObject, getString } from './utils/event-record.js'
import {
  extractUsage,
  readErrorCode,
  readErrorMessage,
} from './utils/provider-event-normalization.js'

// OpenAI — Chat Completions and Responses API raw payloads.
export function normalizeOpenAI(
  record: Record<string, unknown>,
  fallbackSessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type', 'object', 'event')
  const sessionId = getString(record, 'id', 'session_id', 'sessionId') ?? fallbackSessionId

  const errorValue = record['error'] ?? getObject(record, 'response')?.['error']
  if (errorValue) {
    return {
      type: 'adapter:failed',
      providerId: 'openai',
      sessionId,
      error:
        readErrorMessage(errorValue) ??
        getString(record, 'message', 'error') ??
        'Unknown OpenAI error',
      code: readErrorCode(errorValue) ?? getString(record, 'code'),
      timestamp: Date.now(),
    }
  }

  switch (type) {
    case 'response.in_progress':
    case 'response.created':
    case 'response.queued': {
      return {
        type: 'adapter:progress',
        providerId: 'openai',
        phase: type.replace('response.', ''),
        message: getString(getObject(record, 'response') ?? {}, 'status'),
        timestamp: Date.now(),
      }
    }

    case 'response.output_text.delta': {
      const delta = getString(record, 'delta')
      if (delta === undefined) return null
      return {
        type: 'adapter:stream_delta',
        providerId: 'openai',
        content: delta,
        timestamp: Date.now(),
      }
    }

    case 'response.output_text.done': {
      const text = getString(record, 'text')
      if (text === undefined) return null
      return {
        type: 'adapter:message',
        providerId: 'openai',
        content: text,
        role: 'assistant',
        timestamp: Date.now(),
      }
    }

    case 'response.completed': {
      const response = getObject(record, 'response') ?? record
      return {
        type: 'adapter:completed',
        providerId: 'openai',
        sessionId,
        result: getString(response, 'output_text', 'text') ?? '',
        usage: extractUsage(response),
        durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'response.failed': {
      const response = getObject(record, 'response') ?? record
      const responseError = response['error']
      return {
        type: 'adapter:failed',
        providerId: 'openai',
        sessionId,
        error:
          readErrorMessage(responseError) ??
          getString(response, 'message', 'error') ??
          'Unknown OpenAI error',
        code: readErrorCode(responseError) ?? getString(response, 'code'),
        timestamp: Date.now(),
      }
    }

    case 'chat.completion.chunk': {
      const choice = getFirstChoice(record)
      const delta = getObject(choice ?? {}, 'delta')
      const content = getString(delta ?? {}, 'content')
      if (content !== undefined) {
        return {
          type: 'adapter:stream_delta',
          providerId: 'openai',
          content,
          timestamp: Date.now(),
        }
      }

      const role = getString(delta ?? {}, 'role')
      if (role) {
        return {
          type: 'adapter:progress',
          providerId: 'openai',
          phase: 'message_start',
          message: role,
          timestamp: Date.now(),
        }
      }

      return null
    }

    case 'chat.completion': {
      const content = getOpenAIChoiceMessageContent(record)
      if (content === undefined) return null
      return {
        type: 'adapter:completed',
        providerId: 'openai',
        sessionId,
        result: content,
        usage: extractUsage(record),
        durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
        timestamp: Date.now(),
      }
    }

    default:
      return null
  }
}

function getFirstChoice(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = record['choices']
  const first = Array.isArray(choices) ? choices[0] : undefined
  return first && typeof first === 'object' ? first as Record<string, unknown> : undefined
}

function getOpenAIChoiceMessageContent(record: Record<string, unknown>): string | undefined {
  const choice = getFirstChoice(record)
  const message = getObject(choice ?? {}, 'message')
  return getString(message ?? {}, 'content')
}
