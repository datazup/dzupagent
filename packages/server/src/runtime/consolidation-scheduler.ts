/**
 * Periodic memory consolidation scheduler.
 *
 * Runs the SleepConsolidator (or a custom consolidation function) on a
 * configurable interval, with idle detection and backpressure so it
 * doesn't overlap or run during heavy workloads.
 *
 * Integrates with GracefulShutdown for clean teardown.
 */
import type { DzipEventBus } from '@dzipagent/core'

export interface ConsolidationTask {
  /** Run one consolidation cycle. Returns a summary string for logging. */
  run(signal: AbortSignal): Promise<ConsolidationReport>
}

export interface ConsolidationReport {
  /** Total records processed */
  recordsProcessed: number
  /** Records pruned */
  pruned: number
  /** Records merged/deduplicated */
  merged: number
  /** Duration in ms */
  durationMs: number
}

export interface ConsolidationSchedulerConfig {
  /** The consolidation task to run each cycle */
  task: ConsolidationTask
  /** Interval between consolidation runs in ms (default: 3_600_000 = 1 hour) */
  intervalMs?: number
  /** Minimum idle time (no active runs) before triggering (default: 30_000 = 30s) */
  idleThresholdMs?: number
  /** Maximum concurrent consolidation runs (default: 1) */
  maxConcurrent?: number
  /** Optional event bus for emitting consolidation lifecycle events */
  eventBus?: DzipEventBus
  /** Active run count provider — consolidation waits until this returns 0 */
  activeRunCount?: () => number
}

export class ConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private activeConsolidations = 0
  private lastRunAt: Date | null = null
  private abort: AbortController | null = null
  private lastIdleAt = Date.now()

  private readonly intervalMs: number
  private readonly idleThresholdMs: number
  private readonly maxConcurrent: number
  private readonly task: ConsolidationTask
  private readonly eventBus?: DzipEventBus
  private readonly activeRunCount: () => number

  constructor(config: ConsolidationSchedulerConfig) {
    this.task = config.task
    this.intervalMs = config.intervalMs ?? 3_600_000
    this.idleThresholdMs = config.idleThresholdMs ?? 30_000
    this.maxConcurrent = config.maxConcurrent ?? 1
    this.eventBus = config.eventBus
    this.activeRunCount = config.activeRunCount ?? (() => 0)
  }

  /** Start the periodic scheduler */
  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()

    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)

    // Run immediately on first start if idle
    void this.tick()
  }

  /** Stop the scheduler and wait for any in-progress consolidation */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.abort) {
      this.abort.abort()
      this.abort = null
    }

    // Wait for active consolidations to finish (up to 30s)
    const deadline = Date.now() + 30_000
    while (this.activeConsolidations > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  /** Get scheduler status */
  status(): {
    running: boolean
    activeConsolidations: number
    lastRunAt: Date | null
  } {
    return {
      running: this.running,
      activeConsolidations: this.activeConsolidations,
      lastRunAt: this.lastRunAt,
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    if (this.activeConsolidations >= this.maxConcurrent) return

    // Check if there are active runs — if so, postpone
    const activeRuns = this.activeRunCount()
    if (activeRuns > 0) {
      this.lastIdleAt = Date.now()
      return
    }

    // Check idle threshold
    const idleDuration = Date.now() - this.lastIdleAt
    if (idleDuration < this.idleThresholdMs) return

    this.activeConsolidations++
    const startedAt = Date.now()

    try {
      this.eventBus?.emit({
        type: 'system:consolidation_started' as string,
      } as never)

      const signal = this.abort?.signal ?? new AbortController().signal
      const report = await this.task.run(signal)
      this.lastRunAt = new Date()

      this.eventBus?.emit({
        type: 'system:consolidation_completed' as string,
        durationMs: report.durationMs,
        recordsProcessed: report.recordsProcessed,
        pruned: report.pruned,
        merged: report.merged,
      } as never)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.eventBus?.emit({
          type: 'system:consolidation_failed' as string,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        } as never)
      }
    } finally {
      this.activeConsolidations--
    }
  }
}
