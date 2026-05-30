/**
 * Streaming tool-call assembly helpers for the OpenAI adapter.
 *
 * Extracted from `openai-adapter.ts` (MC-027a-1). Encapsulates the
 * `index`-keyed accumulation of tool_call deltas, ordered flushing into
 * `adapter:tool_call` events, and tool-definition normalization.
 */
import type { AdapterProviderId, AgentEvent, AgentInput } from '../types.js'
import type { OpenAIToolWire, SSEChunkChoice, SSEToolCallDelta } from './openai-types.js'

export interface SseChoiceProcessResult {
  events: AgentEvent[]
  /** Content text appended to the current run's full-text accumulator. */
  appendedContent: string
}

interface PendingToolCall {
  index: number
  id?: string
  name?: string
  arguments: string
  emitted: boolean
}

/**
 * Accumulates streaming tool-call fragments and flushes them as ordered
 * `adapter:tool_call` events. State is reset between executions via
 * {@link OpenAIToolCallAccumulator.reset}.
 */
export class OpenAIToolCallAccumulator {
  private pending = new Map<number, PendingToolCall>()

  reset(): void {
    this.pending = new Map()
  }

  /**
   * Merge incoming tool_call fragments (`index`-keyed) into the pending map.
   * The first fragment for a given `index` typically supplies `id` and
   * `function.name`; subsequent fragments append `function.arguments` text.
   */
  accumulate(deltas: SSEToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.pending.get(delta.index)
      if (existing) {
        if (delta.id !== undefined) existing.id = delta.id
        if (delta.function?.name !== undefined) existing.name = delta.function.name
        if (delta.function?.arguments !== undefined) {
          existing.arguments += delta.function.arguments
        }
      } else {
        this.pending.set(delta.index, {
          index: delta.index,
          ...(delta.id !== undefined ? { id: delta.id } : {}),
          ...(delta.function?.name !== undefined ? { name: delta.function.name } : {}),
          arguments: delta.function?.arguments ?? '',
          emitted: false,
        })
      }
    }
  }

  /**
   * Convert any unemitted accumulated tool calls into `adapter:tool_call`
   * events (in stream order — sorted by `index`) and mark them emitted.
   *
   * Tool calls without a resolved `name` are skipped since `toolName` is
   * required by the unified event contract; this should never happen for
   * conformant OpenAI streams.
   */
  flush(providerId: AdapterProviderId, correlationId: string | undefined): AgentEvent[] {
    const events: AgentEvent[] = []
    const ordered = [...this.pending.values()].sort((a, b) => a.index - b.index)
    for (const call of ordered) {
      if (call.emitted) continue
      call.emitted = true
      if (call.name === undefined || call.name.length === 0) continue
      events.push({
        type: 'adapter:tool_call',
        providerId,
        toolName: call.name,
        input: parseToolArguments(call.arguments),
        timestamp: Date.now(),
        ...(correlationId ? { correlationId } : {}),
      })
    }
    return events
  }

  /**
   * Process a single SSE choice payload: accumulate any tool-call fragments,
   * emit a `stream_delta` for textual content, and flush pending tool calls
   * when `finish_reason === 'tool_calls'`. Returns the mapped events plus
   * any text the caller should append to its full-text accumulator.
   */
  processSseChoice(
    choice: SSEChunkChoice,
    providerId: AdapterProviderId,
    correlationId: string | undefined,
  ): SseChoiceProcessResult {
    const events: AgentEvent[] = []
    let appendedContent = ''

    if (choice.delta?.tool_calls) {
      this.accumulate(choice.delta.tool_calls)
    }

    if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
      appendedContent = choice.delta.content
      events.push({
        type: 'adapter:stream_delta',
        providerId,
        content: appendedContent,
        timestamp: Date.now(),
        ...(correlationId ? { correlationId } : {}),
      })
    }

    if (choice.finish_reason === 'tool_calls') {
      events.push(...this.flush(providerId, correlationId))
    }

    return { events, appendedContent }
  }
}

/**
 * Parse the accumulated `function.arguments` JSON string. Returns `{}` when
 * the buffer is empty and falls back to the raw string when JSON parsing
 * fails so consumers still receive the model output for diagnostics.
 */
export function parseToolArguments(buffer: string): unknown {
  if (buffer.length === 0) return {}
  try {
    return JSON.parse(buffer) as unknown
  } catch {
    return buffer
  }
}

/**
 * Read tool definitions from `input.options.tools` and convert them into
 * the OpenAI Chat Completions wire format. Accepts either:
 *   1. The flat `OpenAIToolDefinition` shape — `{name, description?, parameters?}`
 *   2. The pre-wrapped wire shape — `{type:'function', function:{...}}`
 *
 * Invalid entries are silently skipped to keep parity with other adapters.
 */
export function resolveOpenAITools(input: AgentInput): OpenAIToolWire[] | undefined {
  const raw = input.options?.['tools']
  if (!Array.isArray(raw)) return undefined
  const wire: OpenAIToolWire[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    // Pre-wrapped form
    if ('type' in entry && (entry as { type?: unknown }).type === 'function' && 'function' in entry) {
      const fn = (entry as { function?: unknown }).function
      if (
        fn !== null &&
        typeof fn === 'object' &&
        'name' in fn &&
        typeof (fn as { name?: unknown }).name === 'string'
      ) {
        const named = fn as { name: string; description?: unknown; parameters?: unknown }
        wire.push({
          type: 'function',
          function: {
            name: named.name,
            ...(typeof named.description === 'string' ? { description: named.description } : {}),
            ...(named.parameters && typeof named.parameters === 'object'
              ? { parameters: named.parameters as Record<string, unknown> }
              : {}),
          },
        })
      }
      continue
    }
    // Flat form
    if ('name' in entry && typeof (entry as { name?: unknown }).name === 'string') {
      const flat = entry as { name: string; description?: unknown; parameters?: unknown }
      wire.push({
        type: 'function',
        function: {
          name: flat.name,
          ...(typeof flat.description === 'string' ? { description: flat.description } : {}),
          ...(flat.parameters && typeof flat.parameters === 'object'
            ? { parameters: flat.parameters as Record<string, unknown> }
            : {}),
        },
      })
    }
  }
  return wire
}
