/**
 * P4 HA scheduling — store-backed claim-tick worker.
 *
 * Replaces TriggerManager's per-process, per-cron `setInterval` scheduling with
 * a single durable tick loop. Every `intervalMs` the worker atomically claims
 * the due occurrences it wins from the shared {@link ScheduleStore}
 * (`claimDue(skipIfRunning: true)`), fires each via the injected `onFire`
 * callback, emits `scheduler:triggered`, and marks the occurrence fired. Two
 * nodes sharing one store therefore fire a due cron exactly once: the store's
 * compare-and-set claim hands each occurrence to a single winner.
 *
 * Mirrors {@link MailDlqWorker}: one `setInterval` (injectable interval +
 * clock, `unref()`'d so it never blocks process exit), a re-entrancy guard, and
 * idempotent `start()` / `stop()`. `tick()` is exposed so tests and callers can
 * drive a pass outside the schedule.
 */
import type { DzupEvent } from '@dzupagent/core'
import type { ClaimedSchedule, ScheduleStore } from './schedule-store.js'

/** Default tick interval (10 seconds) — between the spec's 5-15s window. */
export const DEFAULT_SCHEDULE_TICK_INTERVAL_MS = 10_000

/** Default maximum schedules claimed per tick. */
export const DEFAULT_SCHEDULE_TICK_LIMIT = 50

/**
 * Subset of {@link ScheduleStore} the worker depends on. Pinning to a narrow
 * interface keeps the worker independent of CRUD helpers and trivially
 * mockable in tests.
 */
type ScheduleStoreDependency = Pick<ScheduleStore, 'claimDue' | 'markFired'>

export interface ScheduleTickWorkerConfig {
  /** Shared schedule store to claim due occurrences from. */
  store: ScheduleStoreDependency
  /** Identifier of this node (stored as claimedBy on each won occurrence). */
  claimerId: string
  /**
   * Fire a claimed occurrence. Returns the id of the run it started, which is
   * recorded via markFired for observability. The worker awaits this before
   * marking the occurrence fired.
   */
  onFire: (claimed: ClaimedSchedule) => Promise<string>
  /** Optional event sink for `scheduler:triggered`. */
  emit?: (event: DzupEvent) => void
  /** Tick interval in milliseconds. Defaults to 10s. */
  intervalMs?: number
  /** Maximum occurrences claimed per tick. Defaults to 50. */
  limit?: number
  /**
   * Opt-in bounded catch-up. Forwarded to claimDue; OFF by default
   * (skip-and-realign).
   */
  maxCatchUp?: number
  /** Injected clock (for deterministic tests). Defaults to `Date.now`. */
  now?: () => Date
  /** Called when an individual occurrence fails to fire. For tests/metrics. */
  onError?: (claimed: ClaimedSchedule, error: unknown) => void
}

export class ScheduleTickWorker {
  private readonly store: ScheduleStoreDependency
  private readonly claimerId: string
  private readonly onFire: (claimed: ClaimedSchedule) => Promise<string>
  private readonly emit?: (event: DzupEvent) => void
  private readonly intervalMs: number
  private readonly limit: number
  private readonly maxCatchUp?: number
  private readonly now: () => Date
  private readonly onError?: (claimed: ClaimedSchedule, error: unknown) => void

  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(config: ScheduleTickWorkerConfig) {
    this.store = config.store
    this.claimerId = config.claimerId
    this.onFire = config.onFire
    this.emit = config.emit
    this.intervalMs = config.intervalMs ?? DEFAULT_SCHEDULE_TICK_INTERVAL_MS
    this.limit = config.limit ?? DEFAULT_SCHEDULE_TICK_LIMIT
    this.maxCatchUp = config.maxCatchUp
    this.now = config.now ?? (() => new Date())
    this.onError = config.onError

    if (this.intervalMs <= 0) {
      throw new Error('ScheduleTickWorker intervalMs must be > 0')
    }
    if (this.limit <= 0) {
      throw new Error('ScheduleTickWorker limit must be > 0')
    }
  }

  /** Start the periodic tick loop. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // Do not block process exit on this timer.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      try {
        ;(this.timer as { unref: () => void }).unref()
      } catch {
        // noop — some environments (e.g. test timers) do not implement unref.
      }
    }
  }

  /** Stop the periodic tick loop. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return Promise.resolve()
  }

  /**
   * Run a single claim + fire pass. Exposed for tests and callers that want to
   * drive a tick outside the interval schedule. Re-entrant calls are a no-op
   * while a previous tick is still in flight.
   */
  async tick(): Promise<{ fired: number; failed: number }> {
    if (this.ticking) {
      return { fired: 0, failed: 0 }
    }
    this.ticking = true
    let fired = 0
    let failed = 0
    try {
      const claimed = await this.store.claimDue(this.now(), {
        limit: this.limit,
        claimerId: this.claimerId,
        skipIfRunning: true,
        ...(this.maxCatchUp !== undefined ? { maxCatchUp: this.maxCatchUp } : {}),
      })
      for (const occurrence of claimed) {
        const ok = await this.fireOne(occurrence)
        if (ok) {
          fired += 1
        } else {
          failed += 1
        }
      }
    } finally {
      this.ticking = false
    }
    return { fired, failed }
  }

  private async fireOne(claimed: ClaimedSchedule): Promise<boolean> {
    try {
      const runId = await this.onFire(claimed)
      // The scheduler:triggered event type only carries scheduleId; claimedBy
      // and occurrence live on the claimed record and the onFire callback, not
      // the event (adding them would break the core event union typing).
      this.emit?.({ type: 'scheduler:triggered', scheduleId: claimed.id } as DzupEvent)
      await this.store.markFired(claimed.id, claimed.occurrence, runId)
      return true
    } catch (error) {
      this.emit?.({
        type: 'scheduler:trigger_failed',
        scheduleId: claimed.id,
      } as DzupEvent)
      // Clear the running flag so a future tick can retry this schedule.
      try {
        await this.store.markFired(claimed.id, claimed.occurrence, '')
      } catch {
        // best-effort; surfaced via onError below.
      }
      this.onError?.(claimed, error)
      return false
    }
  }
}
