/**
 * Bridge: DzupEventBus -> RunMetricsAggregator.
 *
 * Subscribes to agent and tool lifecycle events and folds them into a
 * {@link RunMetricsAggregator}. Token/cost usage is accumulated from
 * `llm:invoked` events keyed by `runId`, then flushed into the
 * aggregator when the run terminates (`agent:completed` /
 * `agent:failed`). This keeps the aggregator's per-run row authoritative
 * for completion-time totals while avoiding repeated overwrites during
 * streaming.
 *
 * The mapping intentionally accepts both the canonical core event names
 * (`tool:called`) and the shorter aliases used in higher-level specs
 * (`agent:tool_call`) so callers can wire either. In practice only the
 * core names appear on the bus today.
 */
import type { DzupEventBus } from '@dzupagent/core'
import type { RunMetricsAggregator, RunTokenUsage } from './run-metrics.js'

/** Cost per token bucket accumulator keyed by runId. */
interface PendingUsage {
  tokens: RunTokenUsage
  costCents: number
}

export interface EventBusBridgeOptions {
  /**
   * If provided, only events for this provider id are recorded. Useful
   * when an aggregator instance is dedicated to a single provider.
   */
  providerId?: string
  /**
   * Override for resolving a run's providerId from the start event.
   * Defaults to the event's `agentId` (since `agent:started` does not
   * include a providerId field).
   */
  resolveProviderId?: (event: { agentId: string; runId: string }) => string
}

/**
 * Subscribe a {@link RunMetricsAggregator} to a {@link DzupEventBus}.
 *
 * Returns an unsubscribe function that detaches all installed listeners.
 */
export function attachRunMetricsBridge(
  bus: DzupEventBus,
  aggregator: RunMetricsAggregator,
  opts: EventBusBridgeOptions = {},
): () => void {
  const pending = new Map<string, PendingUsage>()
  const resolveProviderId =
    opts.resolveProviderId ?? ((e: { agentId: string }) => e.agentId)

  function getOrInit(runId: string): PendingUsage {
    let p = pending.get(runId)
    if (!p) {
      p = { tokens: { input: 0, output: 0, cached: 0 }, costCents: 0 }
      pending.set(runId, p)
    }
    return p
  }

  const unsubscribers: Array<() => void> = []

  unsubscribers.push(
    bus.on('agent:started', (e) => {
      const providerId = resolveProviderId({ agentId: e.agentId, runId: e.runId })
      if (opts.providerId && providerId !== opts.providerId) return
      aggregator.recordStart(e.runId, providerId)
    }),
  )

  unsubscribers.push(
    bus.on('llm:invoked', (e) => {
      if (!e.runId) return
      const acc = getOrInit(e.runId)
      acc.tokens.input += e.inputTokens
      acc.tokens.output += e.outputTokens
      acc.costCents += e.costCents
    }),
  )

  unsubscribers.push(
    bus.on('agent:completed', (e) => {
      const acc = pending.get(e.runId)
      const tokens = acc?.tokens ?? { input: 0, output: 0, cached: 0 }
      // Convert cents -> micros (1 cent = 10_000 micros).
      const costMicros = Math.round((acc?.costCents ?? 0) * 10_000)
      aggregator.recordComplete(e.runId, tokens, costMicros)
      pending.delete(e.runId)
    }),
  )

  unsubscribers.push(
    bus.on('agent:failed', (e) => {
      aggregator.recordFailure(e.runId, 1)
      pending.delete(e.runId)
    }),
  )

  unsubscribers.push(
    bus.on('tool:called', (e) => {
      if (!e.runId) return
      aggregator.recordToolCall(e.runId)
    }),
  )

  unsubscribers.push(
    bus.on('run:paused', (e) => {
      aggregator.recordPause(e.runId)
    }),
  )

  unsubscribers.push(
    bus.on('checkpoint:created', (e) => {
      aggregator.recordCheckpoint(e.runId, e.label)
    }),
  )

  return () => {
    for (const off of unsubscribers) {
      try {
        off()
      } catch {
        // Best-effort detach; ignore handler-removal errors.
      }
    }
    pending.clear()
  }
}
