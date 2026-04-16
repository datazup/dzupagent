/**
 * HumanContactTimeoutScheduler -- server-side timeout enforcement for pending human contacts.
 *
 * Runs on the server (not in the agent process) to ensure timeout enforcement
 * survives agent process crashes. Checks pending contacts every 60 seconds
 * and auto-resumes runs whose timeout has expired.
 *
 * Implemented as a server lifecycle hook (start/stop), not a cron job.
 */
import type { RunStore, Run } from '@dzupagent/core'

export interface HumanContactTimeoutConfig {
  /** How often to check for expired contacts in ms (default: 60_000) */
  checkIntervalMs?: number
  /** Default fallback value for timed-out contacts (default: { timeout: true }) */
  defaultFallback?: unknown
}

export class HumanContactTimeoutScheduler {
  private intervalId?: ReturnType<typeof setInterval>
  private readonly checkIntervalMs: number
  private readonly defaultFallback: unknown

  constructor(
    private readonly runStore: RunStore,
    config: HumanContactTimeoutConfig = {},
  ) {
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000
    this.defaultFallback = config.defaultFallback ?? { timeout: true }
  }

  start(): void {
    if (this.intervalId) return // already running
    this.intervalId = setInterval(() => {
      void this.checkExpiredContacts()
    }, this.checkIntervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  async checkExpiredContacts(): Promise<void> {
    // Find runs that are in 'suspended' or 'awaiting_approval' state
    // with expired human contact requests.
    //
    // RunFilter.status accepts a single RunStatus, so we must query twice.
    // The scheduler wires into the server lifecycle via start()/stop().
    const now = new Date().toISOString()

    try {
      const suspendedRuns = await this.runStore.list({ status: 'suspended' })
      const awaitingRuns = await this.runStore.list({ status: 'awaiting_approval' })
      const pendingRuns: Run[] = [...suspendedRuns, ...awaitingRuns]

      for (const run of pendingRuns) {
        // Check if run has expired human contact metadata
        const metadata = run.metadata as Record<string, unknown> | undefined
        if (
          metadata?.['humanContactExpiresAt'] &&
          metadata['humanContactExpiresAt'] < now
        ) {
          await this.runStore.update(run.id, {
            status: 'running',
            metadata: {
              ...metadata,
              humanContactTimedOut: true,
              humanContactFallback: this.defaultFallback,
            },
          })
        }
      }
    } catch (err) {
      // Non-fatal: log and continue
      console.error('[HumanContactTimeoutScheduler] Error checking expired contacts:', err)
    }
  }
}
