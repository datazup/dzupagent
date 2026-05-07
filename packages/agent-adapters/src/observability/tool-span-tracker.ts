import type { TraceSpan } from './trace-types.js'

type ToolEvent = {
  toolName: string
} & Record<string, unknown>

const TOOL_CALL_ID_KEYS = ['toolCallId', 'tool_call_id', 'callId', 'call_id', 'id']

/**
 * Tracks open tool spans by explicit call id when provider events expose one,
 * and otherwise by FIFO order per tool name. The FIFO fallback preserves span
 * fidelity for concurrent calls with the same tool name without widening the
 * public AgentEvent contract.
 */
export class ToolSpanTracker {
  private readonly byId = new Map<string, TraceSpan>()
  private readonly byName = new Map<string, TraceSpan[]>()
  private readonly spanIds = new Map<TraceSpan, string>()

  add(event: ToolEvent, span: TraceSpan): void {
    const id = getToolCallId(event)
    if (id) {
      this.byId.set(id, span)
      this.spanIds.set(span, id)
    }

    const queue = this.byName.get(event.toolName) ?? []
    queue.push(span)
    this.byName.set(event.toolName, queue)
  }

  take(event: ToolEvent): TraceSpan | undefined {
    const id = getToolCallId(event)
    if (id) {
      const byId = this.byId.get(id)
      if (byId) {
        this.byId.delete(id)
        this.spanIds.delete(byId)
        this.removeFromNameQueue(event.toolName, byId)
        return byId
      }
    }

    const queue = this.byName.get(event.toolName)
    if (!queue) return undefined

    while (queue.length > 0) {
      const span = queue.shift()!
      if (queue.length === 0) {
        this.byName.delete(event.toolName)
      }
      if (span.endTime !== undefined) continue

      const spanId = this.spanIds.get(span)
      if (spanId) {
        this.byId.delete(spanId)
        this.spanIds.delete(span)
      }
      return span
    }

    return undefined
  }

  openSpans(): TraceSpan[] {
    const spans = new Set<TraceSpan>()
    for (const queue of this.byName.values()) {
      for (const span of queue) {
        if (span.endTime === undefined) {
          spans.add(span)
        }
      }
    }
    return [...spans]
  }

  clear(): void {
    this.byId.clear()
    this.byName.clear()
    this.spanIds.clear()
  }

  private removeFromNameQueue(toolName: string, span: TraceSpan): void {
    const queue = this.byName.get(toolName)
    if (!queue) return
    const index = queue.indexOf(span)
    if (index !== -1) {
      queue.splice(index, 1)
    }
    if (queue.length === 0) {
      this.byName.delete(toolName)
    }
  }
}

export function getToolCallId(event: ToolEvent): string | undefined {
  for (const key of TOOL_CALL_ID_KEYS) {
    const value = event[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}
