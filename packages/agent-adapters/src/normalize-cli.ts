import type {
  AdapterProviderId,
  AgentEvent,
} from '@dzupagent/adapter-types'
import { getString } from './utils/event-record.js'
import {
  mapCliProviderEvent,
  readTextLike,
} from './utils/provider-event-normalization.js'

// Gemini reuses the CLI mapping with lifecycle extensions.
export function normalizeGemini(
  record: Record<string, unknown>,
  sessionId: string,
  provider: Extract<AdapterProviderId, 'gemini' | 'gemini-sdk'>,
): AgentEvent | null {
  const type = getString(record, 'type', 'event')

  if (type === 'session_started' || type === 'started') {
    const sid = sessionId || getString(record, 'session_id', 'sessionId') || ''
    if (!sid) return null
    return {
      type: 'adapter:started',
      providerId: provider,
      sessionId: sid,
      timestamp: Date.now(),
    }
  }

  const mapped = mapCliProviderEvent(record, sessionId, {
    providerId: provider,
    defaultErrorMessage: 'Unknown Gemini error',
  })
  if (mapped) return mapped

  if (type === 'message' || type === 'response') {
    const content = readTextLike(record, 'content', 'text', 'message') ?? ''
    return {
      type: 'adapter:message',
      providerId: provider,
      content,
      role: 'assistant',
      timestamp: Date.now(),
    }
  }
  return null
}

// Goose relies on the generic CLI mapper with lifecycle fallback.
export function normalizeGoose(
  record: Record<string, unknown>,
  sessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type', 'event')
  if (type === 'session_started' || type === 'started') {
    const sid = sessionId || getString(record, 'session_id', 'sessionId') || ''
    if (!sid) return null
    return {
      type: 'adapter:started',
      providerId: 'goose',
      sessionId: sid,
      timestamp: Date.now(),
    }
  }
  return normalizeCliWithFallback(record, sessionId, {
    providerId: 'goose',
    defaultErrorMessage: 'Unknown Goose error',
  })
}

export function normalizeCliWithFallback(
  record: Record<string, unknown>,
  sessionId: string,
  config: {
    providerId: AdapterProviderId
    extraToolNameKeys?: string[]
    defaultErrorMessage: string
  },
): AgentEvent | null {
  const type = getString(record, 'type', 'event')
  if (type === 'session_started' || type === 'started' || type === 'start') {
    const sid = sessionId || getString(record, 'session_id', 'sessionId') || ''
    if (!sid) return null
    return {
      type: 'adapter:started',
      providerId: config.providerId,
      sessionId: sid,
      timestamp: Date.now(),
    }
  }
  const mapped = mapCliProviderEvent(record, sessionId, {
    providerId: config.providerId,
    extraToolNameKeys: config.extraToolNameKeys,
    defaultErrorMessage: config.defaultErrorMessage,
  })
  return mapped ?? null
}
