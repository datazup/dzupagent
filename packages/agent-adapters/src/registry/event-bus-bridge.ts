/**
 * EventBusBridge — bridges adapter events to DzipEventBus.
 *
 * Wraps an AsyncGenerator<AgentEvent> and for each yielded event,
 * emits the corresponding DzipEvent on the bus. The original events
 * are yielded unchanged (pass-through).
 */

import type { DzipEvent, DzipEventBus } from '@dzipagent/core'
import { randomUUID } from 'node:crypto'

import type { AgentEvent } from '../types.js'

/**
 * Bridges adapter-level events (AgentEvent) to the unified DzipEventBus.
 *
 * Usage:
 * ```ts
 * const bridge = new EventBusBridge(eventBus)
 * const events = bridge.bridge(adapter.execute(input), runId)
 * for await (const event of events) {
 *   // event is the original AgentEvent, unchanged
 *   // DzipEvent has already been emitted on the bus
 * }
 * ```
 */
export class EventBusBridge {
  private readonly bus: DzipEventBus

  constructor(bus: DzipEventBus) {
    this.bus = bus
  }

  /**
   * Wrap an async generator of adapter events, emitting each as a
   * DzipEvent on the bus while yielding the original events unchanged.
   *
   * @param source - The adapter event stream to bridge
   * @param runId  - Optional run ID; generated if not provided
   */
  async *bridge(
    source: AsyncGenerator<AgentEvent, void, undefined>,
    runId?: string,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const resolvedRunId = runId ?? randomUUID()

    for await (const event of source) {
      const dzipEvent = EventBusBridge.mapToDzipEvent(event, resolvedRunId)
      if (dzipEvent !== null) {
        this.bus.emit(dzipEvent)
      }
      yield event
    }
  }

  /**
   * Map an adapter event to the corresponding DzipEvent.
   * Returns `null` if the event type has no DzipEvent mapping.
   */
  static mapToDzipEvent(event: AgentEvent, runId: string): DzipEvent | null {
    switch (event.type) {
      case 'adapter:started':
        return {
          type: 'agent:started',
          agentId: event.providerId,
          runId,
        }

      case 'adapter:message':
        return {
          type: 'agent:stream_delta',
          agentId: event.providerId,
          runId,
          content: event.content,
        }

      case 'adapter:tool_call':
        return {
          type: 'tool:called',
          toolName: event.toolName,
          input: event.input,
        }

      case 'adapter:tool_result':
        return {
          type: 'tool:result',
          toolName: event.toolName,
          durationMs: event.durationMs,
        }

      case 'adapter:completed':
        return {
          type: 'agent:completed',
          agentId: event.providerId,
          runId,
          durationMs: event.durationMs,
        }

      case 'adapter:failed':
        return {
          type: 'agent:failed',
          agentId: event.providerId,
          runId,
          errorCode: 'ADAPTER_EXECUTION_FAILED',
          message: event.error,
        }

      case 'adapter:stream_delta':
        return {
          type: 'agent:stream_delta',
          agentId: event.providerId,
          runId,
          content: event.content,
        }

      default:
        return null
    }
  }
}
