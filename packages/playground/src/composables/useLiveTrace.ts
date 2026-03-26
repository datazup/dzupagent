/**
 * Composable for building live trace data from a stream of replay events.
 *
 * Computes timeline entries, per-node metrics, token usage, and cost estimates
 * from an accumulating event stream. Updates reactively as new events arrive.
 *
 * @module useLiveTrace
 */
import { computed, ref, type Ref } from 'vue'
import type { ReplayEvent } from './useEventStream.js'
import type { TraceEvent } from '../types.js'

/** Per-node performance metrics */
export interface NodeMetrics {
  /** Node/tool name */
  name: string
  /** Total invocations */
  callCount: number
  /** Total duration in ms */
  totalDurationMs: number
  /** Average duration in ms */
  avgDurationMs: number
  /** Number of successful calls */
  successCount: number
  /** Number of failed calls */
  failureCount: number
  /** Success rate (0-1) */
  successRate: number
  /** Recent latency samples for sparkline rendering (last 20) */
  latencySamples: number[]
}

/** Aggregated token usage from LLM events */
export interface TokenUsageStats {
  /** Total input/prompt tokens */
  input: number
  /** Total output/completion tokens */
  output: number
  /** Total tokens (input + output) */
  total: number
}

/** Live memory operation entry */
export interface MemoryOperation {
  /** Operation type */
  type: 'write' | 'search' | 'error'
  /** Namespace or key affected */
  target: string
  /** ISO timestamp */
  timestamp: string
  /** Duration if available */
  durationMs: number
  /** Additional details */
  details: Record<string, unknown>
}

/** Timeline data structure compatible with TraceTimeline rendering */
export interface TimelineData {
  /** Trace events for the timeline */
  events: TraceEvent[]
  /** Total duration of all events */
  totalDurationMs: number
  /** Number of events */
  eventCount: number
}

// ── Cost estimation constants ────────────────────────────
// Approximate costs per 1K tokens (blended estimate)
const INPUT_COST_PER_1K = 0.003
const OUTPUT_COST_PER_1K = 0.015

/** Maximum latency samples to keep per tool for sparklines */
const MAX_LATENCY_SAMPLES = 20

/**
 * Map WsEvent type to TraceEvent type for timeline display.
 */
function eventTypeToTraceType(eventType: string): TraceEvent['type'] {
  if (eventType.startsWith('tool:')) return 'tool'
  if (eventType.startsWith('memory:')) return 'memory'
  if (eventType.startsWith('agent:stream') || eventType.includes('llm')) return 'llm'
  if (eventType.includes('guard')) return 'guardrail'
  return 'system'
}

/**
 * Extract a display name from a replay event.
 */
function eventDisplayName(event: ReplayEvent): string {
  const payload = event.payload

  // Tool events
  const toolName = payload['toolName'] as string | undefined
  if (toolName) return toolName

  // Memory events
  const namespace = payload['namespace'] as string | undefined
  if (namespace) return `${event.type.split(':')[1] ?? event.type}: ${namespace}`

  // Agent events
  const content = payload['content'] as string | undefined
  if (content && content.length > 0) {
    return content.length > 50 ? `${content.slice(0, 47)}...` : content
  }

  // Phase changes
  const phase = payload['phase'] as string | undefined
  if (phase) return `Phase: ${phase}`

  return event.type.replace(/:/g, ' ')
}

export interface UseLiveTraceReturn {
  /** Computed timeline data for rendering */
  timelineData: Ref<TimelineData>
  /** Per-node/tool metrics map */
  nodeMetrics: Ref<Map<string, NodeMetrics>>
  /** Currently highlighted node in the timeline */
  currentNode: Ref<string | null>
  /** Aggregated token usage */
  tokenUsage: Ref<TokenUsageStats>
  /** Estimated cost in USD */
  costEstimate: Ref<number>
  /** Live memory operations */
  memoryOperations: Ref<MemoryOperation[]>
  /** Set the currently highlighted node */
  setCurrentNode: (nodeId: string | null) => void
}

/**
 * Composable for building live trace analytics from a stream of replay events.
 *
 * @param events - Reactive ref of accumulated replay events from useEventStream
 * @returns Computed timeline data, metrics, token usage, and cost estimates
 */
export function useLiveTrace(events: Ref<ReplayEvent[]>): UseLiveTraceReturn {
  const currentNode = ref<string | null>(null)

  // ── Timeline data ────────────────────────────────────

  const timelineData = computed<TimelineData>(() => {
    const traceEvents: TraceEvent[] = events.value.map((event) => ({
      id: event.id,
      type: eventTypeToTraceType(event.type),
      name: eventDisplayName(event),
      startedAt: event.timestamp,
      durationMs: (event.payload['durationMs'] as number | undefined) ?? 0,
      metadata: event.payload,
    }))

    const totalDurationMs = traceEvents.reduce(
      (sum, e) => sum + e.durationMs,
      0,
    )

    return {
      events: traceEvents,
      totalDurationMs,
      eventCount: traceEvents.length,
    }
  })

  // ── Node metrics ─────────────────────────────────────

  const nodeMetrics = computed<Map<string, NodeMetrics>>(() => {
    const metrics = new Map<string, NodeMetrics>()

    for (const event of events.value) {
      // Only track tool and memory events for metrics
      if (!event.type.startsWith('tool:') && !event.type.startsWith('memory:')) {
        continue
      }

      const name =
        (event.payload['toolName'] as string | undefined) ??
        (event.payload['namespace'] as string | undefined) ??
        event.type

      const existing = metrics.get(name)
      const durationMs = (event.payload['durationMs'] as number | undefined) ?? 0
      const isError = event.type.endsWith(':error')
      const isResult = event.type.endsWith(':result') || event.type.endsWith(':written') || event.type.endsWith(':searched')

      if (existing) {
        existing.callCount += 1
        existing.totalDurationMs += durationMs
        existing.avgDurationMs = existing.totalDurationMs / existing.callCount
        if (isError) {
          existing.failureCount += 1
        } else if (isResult) {
          existing.successCount += 1
        }
        existing.successRate =
          existing.callCount > 0
            ? existing.successCount / existing.callCount
            : 0

        // Update latency samples for sparkline
        if (durationMs > 0) {
          existing.latencySamples.push(durationMs)
          if (existing.latencySamples.length > MAX_LATENCY_SAMPLES) {
            existing.latencySamples.shift()
          }
        }
      } else {
        metrics.set(name, {
          name,
          callCount: 1,
          totalDurationMs: durationMs,
          avgDurationMs: durationMs,
          successCount: isResult ? 1 : 0,
          failureCount: isError ? 1 : 0,
          successRate: isResult ? 1 : 0,
          latencySamples: durationMs > 0 ? [durationMs] : [],
        })
      }
    }

    return metrics
  })

  // ── Token usage ──────────────────────────────────────

  const tokenUsage = computed<TokenUsageStats>(() => {
    let input = 0
    let output = 0

    for (const event of events.value) {
      const payload = event.payload

      // Look for token counts in event payloads
      if (typeof payload['promptTokens'] === 'number') {
        input += payload['promptTokens']
      }
      if (typeof payload['completionTokens'] === 'number') {
        output += payload['completionTokens']
      }
      if (typeof payload['inputTokens'] === 'number') {
        input += payload['inputTokens']
      }
      if (typeof payload['outputTokens'] === 'number') {
        output += payload['outputTokens']
      }

      // Estimate from content length for stream events
      if (event.type === 'agent:stream_done') {
        const finalContent = payload['finalContent'] as string | undefined
        if (finalContent) {
          output += Math.ceil(finalContent.length / 4)
        }
      }
    }

    return { input, output, total: input + output }
  })

  // ── Cost estimate ────────────────────────────────────

  const costEstimate = computed<number>(() => {
    const usage = tokenUsage.value
    return (
      (usage.input / 1000) * INPUT_COST_PER_1K +
      (usage.output / 1000) * OUTPUT_COST_PER_1K
    )
  })

  // ── Memory operations ────────────────────────────────

  const memoryOperations = computed<MemoryOperation[]>(() => {
    const ops: MemoryOperation[] = []

    for (const event of events.value) {
      if (!event.type.startsWith('memory:')) continue

      let opType: MemoryOperation['type']
      if (event.type === 'memory:written') {
        opType = 'write'
      } else if (event.type === 'memory:searched') {
        opType = 'search'
      } else if (event.type === 'memory:error') {
        opType = 'error'
      } else {
        continue
      }

      const target =
        (event.payload['namespace'] as string | undefined) ??
        (event.payload['key'] as string | undefined) ??
        'unknown'

      ops.push({
        type: opType,
        target,
        timestamp: event.timestamp,
        durationMs: (event.payload['durationMs'] as number | undefined) ?? 0,
        details: event.payload,
      })
    }

    return ops
  })

  // ── Public methods ───────────────────────────────────

  function setCurrentNode(nodeId: string | null): void {
    currentNode.value = nodeId
  }

  return {
    timelineData,
    nodeMetrics,
    currentNode,
    tokenUsage,
    costEstimate,
    memoryOperations,
    setCurrentNode,
  }
}
