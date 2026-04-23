/**
 * Unified event normalization.
 *
 * `normalizeEvent(raw, provider)` maps a provider-specific raw event payload
 * (SDK message, JSONL record, CLI line, etc.) into a canonical DzupAgent
 * {@link AgentEvent}. Returns `null` when the raw input carries no usable
 * information for downstream consumers (unknown shape, heartbeat ping, etc.).
 *
 * The function is intentionally defensive: it never throws on malformed input.
 * Each provider branch is pure — callers can feed raw events straight from
 * the SDK `stdout` iterator or a persisted `raw-events.jsonl` replay stream.
 *
 * Canonical event types produced:
 *   - `adapter:started`      — run/session start
 *   - `adapter:completed`    — run/session end
 *   - `adapter:failed`       — run/session error
 *   - `adapter:message`      — assistant/user/system text
 *   - `adapter:stream_delta` — streaming text chunk
 *   - `adapter:tool_call`    — tool invocation start
 *   - `adapter:tool_result`  — tool invocation end
 */
import type {
  AdapterProviderId,
  AgentEvent,
  TokenUsage,
} from '@dzupagent/adapter-types'
import { getNumber, getObject, getString } from './utils/event-record.js'
import {
  extractUsage,
  mapCliProviderEvent,
  readErrorCode,
  readErrorMessage,
  readTextLike,
  serializeProviderPayload,
} from './utils/provider-event-normalization.js'

/** Providers recognized by {@link normalizeEvent}. */
export type Provider = AdapterProviderId

/**
 * Map a raw provider event to a canonical {@link AgentEvent}.
 *
 * Returns `null` when the raw input cannot be normalized (unknown type,
 * empty payload, non-object primitive, etc.). Never throws.
 */
export function normalizeEvent(raw: unknown, provider: Provider): AgentEvent | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const sessionId = getString(record, 'session_id', 'sessionId') ?? ''

  switch (provider) {
    case 'claude':
      return normalizeClaude(record, sessionId)
    case 'codex':
      return normalizeCodex(record, sessionId)
    case 'gemini':
    case 'gemini-sdk':
      return normalizeGemini(record, sessionId, provider)
    case 'goose':
      return normalizeGoose(record, sessionId)
    case 'qwen':
      return normalizeCliWithFallback(record, sessionId, {
        providerId: 'qwen',
        extraToolNameKeys: ['function'],
        defaultErrorMessage: 'Unknown Qwen CLI error',
      })
    case 'crush':
      return normalizeCliWithFallback(record, sessionId, {
        providerId: 'crush',
        defaultErrorMessage: 'Unknown Crush CLI error',
      })
    case 'openrouter':
      return normalizeCliWithFallback(record, sessionId, {
        providerId: 'openrouter',
        defaultErrorMessage: 'Unknown OpenRouter error',
      })
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Claude SDK — message shapes from @anthropic-ai/claude-agent-sdk
// ---------------------------------------------------------------------------

function normalizeClaude(
  record: Record<string, unknown>,
  fallbackSessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type')
  if (!type) return null

  const sessionId = getString(record, 'session_id', 'sessionId') ?? fallbackSessionId

  switch (type) {
    case 'system': {
      // system messages carry session_id + model info at run start
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
      // assistant content is an array of blocks (text, tool_use, ...).
      const content = record['content']
      if (Array.isArray(content)) {
        // Prefer the first text block; tool_use blocks become tool_call events.
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

// ---------------------------------------------------------------------------
// Codex SDK — item shapes from @openai/codex-sdk
// ---------------------------------------------------------------------------

function normalizeCodex(
  record: Record<string, unknown>,
  fallbackSessionId: string,
): AgentEvent | null {
  const type = getString(record, 'type')
  if (!type) return null

  const sessionId =
    getString(record, 'thread_id', 'threadId', 'session_id', 'sessionId') ?? fallbackSessionId

  switch (type) {
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
      const status = getString(record, 'status')
      if (status === 'completed' || status === 'failed') {
        const result = getObject(record, 'result')
        const output = serializeProviderPayload(result?.['structured_content'] ?? result?.['content'] ?? '') ?? ''
        return {
          type: 'adapter:tool_result',
          providerId: 'codex',
          toolName: tool,
          output,
          durationMs: getNumber(record, 'duration_ms', 'durationMs') ?? 0,
          timestamp: Date.now(),
        }
      }
      return {
        type: 'adapter:tool_call',
        providerId: 'codex',
        toolName: tool,
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

// ---------------------------------------------------------------------------
// Gemini — reuses the CLI mapping with lifecycle extensions
// ---------------------------------------------------------------------------

function normalizeGemini(
  record: Record<string, unknown>,
  sessionId: string,
  provider: Extract<AdapterProviderId, 'gemini' | 'gemini-sdk'>,
): AgentEvent | null {
  const type = getString(record, 'type', 'event')

  // Lifecycle events not covered by the generic CLI mapper.
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

// ---------------------------------------------------------------------------
// Goose — similar to Gemini, relies on the generic CLI mapper with fallback
// ---------------------------------------------------------------------------

function normalizeGoose(
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

// ---------------------------------------------------------------------------
// Shared helper: wrap mapCliProviderEvent + lifecycle fallback
// ---------------------------------------------------------------------------

function normalizeCliWithFallback(
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

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { AgentEvent, AdapterProviderId, TokenUsage }
