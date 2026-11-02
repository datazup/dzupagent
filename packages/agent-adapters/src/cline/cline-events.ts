import type { AgentEvent } from '../types.js'
import type { ClineNativeEvent } from './cline-sdk-types.js'
import { finiteCount, record } from './cline-worker-protocol.js'
import type { ClineStreamEvent, ClineUsage } from './cline-worker-protocol.js'

/** Invalid/partial metrics remain unknown; dollars have no verified accounting contract here. */
export function clineUsage(value: unknown): ClineUsage | undefined {
  if (!record(value) || !finiteCount(value.inputTokens) || !finiteCount(value.outputTokens)) return undefined
  if (value.cacheReadTokens !== undefined && !finiteCount(value.cacheReadTokens)) return undefined
  if (value.cacheWriteTokens !== undefined && !finiteCount(value.cacheWriteTokens)) return undefined
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    ...(finiteCount(value.cacheReadTokens) ? { cachedInputTokens: value.cacheReadTokens } : {}),
    ...(finiteCount(value.cacheWriteTokens) ? { cacheWriteTokens: value.cacheWriteTokens } : {}) }
}
/** SDK lifecycle events are advisory; only start().result decides completion. */
export function clineStreamEvent(event: ClineNativeEvent, sessionId: string): ClineStreamEvent | undefined {
  if (!record(event) || !record(event.payload) || event.payload.sessionId !== sessionId || event.type !== 'agent_event') return undefined
  const raw = event.payload.event
  if (!record(raw) || raw.parentAgentId || event.payload.teamRole === 'teammate') return undefined
  if (raw.type === 'content_start' && raw.contentType === 'text' && typeof raw.text === 'string') return { kind: 'text', text: raw.text }
  if (raw.contentType !== 'tool' || typeof raw.toolName !== 'string' || typeof raw.toolCallId !== 'string') return undefined
  if (raw.type === 'content_start') return { kind: 'tool_call', name: raw.toolName, id: raw.toolCallId, input: raw.input ?? null }
  if (raw.type === 'content_end') {
    const output = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output ?? null)
    return { kind: 'tool_result', name: raw.toolName, id: raw.toolCallId, output,
      durationMs: finiteCount(raw.durationMs) ? raw.durationMs : 0, isError: typeof raw.error === 'string' }
  }
  return undefined
}
export function normalizeClineEvent(event: ClineStreamEvent, correlationId?: string): AgentEvent {
  const base = { providerId: 'cline' as const, timestamp: Date.now(), ...(correlationId ? { correlationId } : {}) }
  if (event.kind === 'text') return { ...base, type: 'adapter:stream_delta', content: event.text }
  if (event.kind === 'tool_call') return { ...base, type: 'adapter:tool_call', toolName: event.name, toolCallId: event.id, input: event.input }
  return { ...base, type: 'adapter:tool_result', toolName: event.name, toolCallId: event.id, output: event.output, durationMs: event.durationMs, isError: event.isError }
}
