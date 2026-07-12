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
import { normalizeClaude } from './normalize-claude.js'
import { normalizeCliWithFallback, normalizeGemini, normalizeGoose } from './normalize-cli.js'
import { normalizeCodex } from './normalize-codex.js'
import { normalizeOpenAI } from './normalize-openai.js'
import { getString } from './utils/event-record.js'

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
    case 'openai':
      return normalizeOpenAI(record, sessionId)
    case 'ollama':
      return normalizeCliWithFallback(record, sessionId, {
        providerId: 'ollama',
        defaultErrorMessage: 'Unknown Ollama error',
      })
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { AgentEvent, AdapterProviderId, TokenUsage }
