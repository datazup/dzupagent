/**
 * Queue metrics tracking for EvalOrchestrator.
 *
 * Encapsulates the queue lifecycle counters, MetricsCollector emission,
 * and queue-stats snapshot construction. Extracted from
 * eval-orchestrator-impl.ts in MC-026a.
 */

import type { MetricsCollector } from '@dzupagent/core/utils'
import type {
  EvalQueueStats,
  EvalRunStore,
} from '@dzupagent/eval-contracts'

export type QueueCounterName =
  | 'enqueued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retried'
  | 'recovered'
  | 'requeued'

export interface QueueCounters {
  enqueued: number
  started: number
  completed: number
  failed: number
  cancelled: number
  retried: number
  recovered: number
  requeued: number
}

export interface QueueMetricsTrackerConfig {
  metrics?: MetricsCollector
  store: EvalRunStore
  pendingRunIds: ReadonlyArray<string>
  pendingRunSet: ReadonlySet<string>
  activeRunControllers: ReadonlyMap<string, AbortController>
}

export class QueueMetricsTracker {
  readonly counters: QueueCounters = {
    enqueued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    retried: 0,
    recovered: 0,
    requeued: 0,
  }

  private readonly metrics: MetricsCollector | undefined
  private readonly store: EvalRunStore
  private readonly pendingRunIds: ReadonlyArray<string>
  private readonly pendingRunSet: ReadonlySet<string>
  private readonly activeRunControllers: ReadonlyMap<string, AbortController>

  constructor(config: QueueMetricsTrackerConfig) {
    this.metrics = config.metrics
    this.store = config.store
    this.pendingRunIds = config.pendingRunIds
    this.pendingRunSet = config.pendingRunSet
    this.activeRunControllers = config.activeRunControllers
  }

  increment(counter: QueueCounterName, by = 1): void {
    this.counters[counter] += by
  }

  recordQueueEvent(metricName: string): void {
    this.metrics?.increment(metricName)
  }

  recordQueueHistogram(metricName: string, value: number): void {
    if (!this.metrics) return
    if (!Number.isFinite(value) || value < 0) return
    this.metrics.observe(metricName, value)
  }

  /**
   * Increment a counter, emit the matching `forge_eval_queue_{event}_total`
   * event, and refresh queue gauges. Equivalent to the inline three-step
   * pattern used by the orchestrator on every lifecycle transition.
   */
  async track(counter: QueueCounterName, eventName: string): Promise<void> {
    this.increment(counter)
    this.recordQueueEvent(eventName)
    await this.refreshQueueMetrics()
  }

  async buildQueueStats(): Promise<EvalQueueStats> {
    let oldestPendingAgeMs: number | null = null
    const now = Date.now()

    for (const runId of this.pendingRunIds) {
      const run = await this.store.getRun(runId)
      if (!run || run.status !== 'queued') {
        continue
      }

      const queuedAtMs = Date.parse(run.queuedAt)
      if (!Number.isFinite(queuedAtMs)) {
        continue
      }

      oldestPendingAgeMs = Math.max(0, now - queuedAtMs)
      break
    }

    return {
      pending: this.pendingRunSet.size,
      active: this.activeRunControllers.size,
      oldestPendingAgeMs,
      ...this.counters,
    }
  }

  async refreshQueueMetrics(): Promise<void> {
    if (!this.metrics) return

    const stats = await this.buildQueueStats()
    this.metrics.gauge('forge_eval_queue_pending', stats.pending)
    this.metrics.gauge('forge_eval_queue_active', stats.active)
    this.metrics.gauge('forge_eval_queue_oldest_pending_age_ms', stats.oldestPendingAgeMs ?? 0)
  }
}
