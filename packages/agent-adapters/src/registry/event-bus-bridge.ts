/**
 * EventBusBridge — bridges adapter events to DzupEventBus.
 *
 * Wraps an AsyncGenerator<AgentEvent> and for each yielded event,
 * emits the corresponding DzupEvent on the bus. The original events
 * are yielded unchanged (pass-through).
 */

import {
  requireTerminalToolExecutionRunId,
  type DzupEvent,
  type DzupEventBus,
} from '@dzupagent/core'
import { randomUUID } from 'node:crypto'

import type { AgentEvent } from '../types.js'

/**
 * Bridges adapter-level events (AgentEvent) to the unified DzupEventBus.
 *
 * Usage:
 * ```ts
 * const bridge = new EventBusBridge(eventBus)
 * const events = bridge.bridge(adapter.execute(input), runId)
 * for await (const event of events) {
 *   // event is the original AgentEvent, unchanged
 *   // DzupEvent has already been emitted on the bus
 * }
 * ```
 */
export class EventBusBridge {
  private readonly bus: DzupEventBus

  constructor(bus: DzupEventBus) {
    this.bus = bus
  }

  /**
   * Wrap an async generator of adapter events, emitting each as a
   * DzupEvent on the bus while yielding the original events unchanged.
   *
   * @param source - The adapter event stream to bridge
   * @param runId  - Optional run ID; generated if not provided
   */
  async *bridge(
    source: AsyncGenerator<AgentEvent, void, undefined>,
    runId?: string,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const resolvedRunId = runId ?? randomUUID()
    let activeToolName: string | undefined

    for await (const event of source) {
      if (event.type === 'adapter:tool_call') {
        activeToolName = event.toolName
      } else if (event.type === 'adapter:tool_result') {
        activeToolName = undefined
      } else if (event.type === 'adapter:failed' && activeToolName) {
        const executionRunId = requireTerminalToolExecutionRunId({
          eventType: 'tool:error',
          toolName: activeToolName,
          executionRunId: resolvedRunId,
        })
        this.bus.emit({
          type: 'tool:error',
          toolName: activeToolName,
          errorCode: 'TOOL_EXECUTION_FAILED',
          message: event.error,
          executionRunId,
        })
        activeToolName = undefined
      }

      const dzipEvent = EventBusBridge.mapToDzupEvent(event, resolvedRunId)
      if (dzipEvent !== null) {
        this.bus.emit(dzipEvent)
      }
      yield event
    }
  }

  /**
   * Map an adapter event to the corresponding DzupEvent.
   * Returns `null` if the event type has no DzupEvent mapping.
   */
  static mapToDzupEvent(event: AgentEvent, runId: string): DzupEvent | null {
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
          executionRunId: runId,
        } as DzupEvent

      case 'adapter:tool_result':
        {
          const executionRunId = requireTerminalToolExecutionRunId({
            eventType: 'tool:result',
            toolName: event.toolName,
            executionRunId: runId,
          })

          return {
            type: 'tool:result',
            toolName: event.toolName,
            durationMs: event.durationMs,
            executionRunId,
          } as DzupEvent
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
          errorCode: event.code === 'AGENT_ABORTED' ? 'AGENT_ABORTED' : 'ADAPTER_EXECUTION_FAILED',
          message: event.error,
        }

      case 'recovery:cancelled':
        return {
          type: 'recovery:cancelled',
          agentId: event.providerId,
          runId,
          attempts: event.totalAttempts,
          durationMs: event.totalDurationMs,
          reason: event.error,
        }

      case 'adapter:stream_delta':
        return {
          type: 'agent:stream_delta',
          agentId: event.providerId,
          runId,
          content: event.content,
        }

      case 'adapter:progress':
        return {
          type: 'agent:progress',
          agentId: event.providerId,
          phase: event.phase ?? 'unknown',
          percentage: typeof event.percentage === 'number' ? event.percentage : 0,
          message: event.message ?? '',
          timestamp: event.timestamp,
        }

      default:
        return null
    }
  }
}
