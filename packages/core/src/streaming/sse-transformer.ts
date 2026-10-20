import type { StreamEvent } from '@langchain/core/tracers/log_stream'
import type { AgentRunEventEnvelope } from '@dzupagent/agent-types/run'
import type { StandardSSEEvent } from './event-types.js'

export type EventTransformer = (event: StreamEvent) => StandardSSEEvent | null

/**
 * Converts LangGraph `StreamEvent` objects into a normalised
 * `StandardSSEEvent` structure suitable for sending over SSE.
 *
 * Built-in rules handle the most common LangGraph events
 * (`on_chat_model_stream`, `on_chat_model_end`, `on_tool_start`,
 * `on_tool_end`, `on_chain_end`). Custom transformers registered
 * via `addTransformer()` take priority.
 */
export class SSETransformer {
  private customTransformers: Map<string, EventTransformer> = new Map()

  /** Register a custom transformer for a specific event name. */
  addTransformer(eventName: string, transformer: EventTransformer): this {
    this.customTransformers.set(eventName, transformer)
    return this
  }

  /** Transform a LangGraph StreamEvent into a StandardSSEEvent (or null to skip). */
  transform(event: StreamEvent): StandardSSEEvent | null {
    // Custom transformers take priority
    const custom = this.customTransformers.get(event.event)
    if (custom) return custom(event)

    // Built-in transformations
    switch (event.event) {
      case 'on_chat_model_stream': {
        const chunk = event.data?.chunk as Record<string, unknown> | undefined
        const content = chunk?.['content']
        if (typeof content === 'string' && content.length > 0) {
          return { type: 'message', data: { content } }
        }
        return null
      }

      case 'on_chat_model_end': {
        const output = event.data?.output as Record<string, unknown> | undefined
        if (output && 'tool_calls' in output) {
          const toolCalls = output['tool_calls']
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            return {
              type: 'tool_call',
              data: {
                tools: toolCalls.map((tc: Record<string, unknown>) => ({
                  name: tc['name'],
                  args: tc['args'],
                })),
              },
            }
          }
        }
        return null
      }

      case 'on_tool_start': {
        const name = event.name ?? 'unknown'
        return { type: 'progress', data: { status: 'running', tool: name } }
      }

      case 'on_tool_end': {
        const output = event.data?.output as
          | string
          | Record<string, unknown>
          | undefined
        const content =
          typeof output === 'string'
            ? output
            : typeof output?.['content'] === 'string'
              ? (output['content'] as string)
              : JSON.stringify(output)
        return { type: 'tool_result', data: { content } }
      }

      case 'on_chain_end': {
        const name = event.name
        if (name && !name.startsWith('__')) {
          return { type: 'phase_change', data: { phase: name } }
        }
        return null
      }

      default:
        return null
    }
  }

  /**
   * Project a run-event envelope (B-02) to an SSE frame carrying its
   * `sequence`. `tool.started` keeps the legacy `progress` frame shape that
   * `on_tool_start` produces, plus `sequence`; every other kind is framed as
   * `{ type: <kind>, data: { sequence, eventId, payload } }`.
   */
  fromEnvelope(envelope: AgentRunEventEnvelope): StandardSSEEvent {
    const { sequence } = envelope
    if (envelope.type === 'tool.started') {
      const bus = (envelope.payload as { bus?: { toolName?: unknown } } | null)?.bus
      const tool = typeof bus?.toolName === 'string' ? bus.toolName : 'unknown'
      return { type: 'progress', data: { status: 'running', tool, sequence } }
    }
    return {
      type: envelope.type,
      data: { sequence, eventId: envelope.eventId, payload: envelope.payload },
    }
  }
}
