/**
 * Background worker that drains the mail dead-letter queue and attempts
 * redelivery through the configured {@link MailboxStore}.
 *
 * Every `intervalMs` the worker:
 *   1. Asks the DLQ for up to `batchSize` due rows via `drain()`.
 *   2. For each row, attempts redelivery by calling `mailbox.save()` with the
 *      original {@link MailMessage}.
 *   3. On success, removes the DLQ row so it is not retried again.
 *   4. On failure, calls `dlq.recordAttempt(id)` which advances the attempt
 *      counter and either reschedules (exponential backoff) or marks the row
 *      dead once {@link MAX_DLQ_ATTEMPTS} has been reached.
 *
 * The worker is intentionally simple: a single setInterval loop, no
 * concurrency beyond whatever `mailbox.save()` does internally. It is safe to
 * call `start()` / `stop()` multiple times and to trigger a drain manually via
 * `tick()` in tests.
 */
import type { MailboxStore, MailMessage } from '@dzupagent/agent'
import {
  type DrizzleDlqStore,
  dlqRowToMessage,
  type DlqRow,
} from '../persistence/drizzle-dlq-store.js'

/** Default drain interval (10 seconds). */
export const DEFAULT_DLQ_WORKER_INTERVAL_MS = 10_000

/** Default batch size per drain tick. */
export const DEFAULT_DLQ_WORKER_BATCH_SIZE = 50

export interface MailDlqWorkerConfig {
  /** DLQ store to drain. */
  dlq: DrizzleDlqStore
  /** Mailbox store to retry delivery through. */
  mailbox: MailboxStore
  /** Drain interval in milliseconds. Defaults to 10s. */
  intervalMs?: number
  /** Maximum rows processed per tick. Defaults to 50. */
  batchSize?: number
  /**
   * Called after a failed redelivery attempt. Receives the DLQ row id and the
   * classified failure reason ('rate_limit' | 'transient' | 'unknown'). Useful
   * for metrics and tests. The worker itself still updates DLQ state via
   * `dlq.recordAttempt(id)` regardless of whether this is provided.
   */
  onFailure?: (id: string, reason: string, error: unknown) => void
  /** Called after a successful redelivery. For tests/observability. */
  onSuccess?: (id: string) => void
  /** Injected clock (for deterministic tests). Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Classify a redelivery failure into a coarse reason string. `MailRateLimitError`
 * is identified structurally (by `name`) so we do not import it at runtime and
 * avoid a circular-dependency risk.
 */
function classifyFailure(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name: unknown }).name
    if (name === 'MailRateLimitError') return 'rate_limit'
  }
  if (error instanceof Error) return 'transient'
  return 'unknown'
}

export class MailDlqWorker {
  private readonly dlq: DrizzleDlqStore
  private readonly mailbox: MailboxStore
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly onFailure?: (id: string, reason: string, error: unknown) => void
  private readonly onSuccess?: (id: string) => void
  private readonly now: () => number

  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false

  constructor(config: MailDlqWorkerConfig) {
    this.dlq = config.dlq
    this.mailbox = config.mailbox
    this.intervalMs = config.intervalMs ?? DEFAULT_DLQ_WORKER_INTERVAL_MS
    this.batchSize = config.batchSize ?? DEFAULT_DLQ_WORKER_BATCH_SIZE
    this.onFailure = config.onFailure
    this.onSuccess = config.onSuccess
    this.now = config.now ?? (() => Date.now())

    if (this.intervalMs <= 0) {
      throw new Error('MailDlqWorker intervalMs must be > 0')
    }
    if (this.batchSize <= 0) {
      throw new Error('MailDlqWorker batchSize must be > 0')
    }
  }

  /** Start the periodic drain loop. Safe to call repeatedly. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // Do not block process exit on this timer.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      try {
        (this.timer as { unref: () => void }).unref()
      } catch {
        // noop — some environments (e.g. test timers) do not implement unref.
      }
    }
  }

  /** Stop the periodic drain loop. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return Promise.resolve()
  }

  /**
   * Run a single drain + redeliver pass. Exposed for tests and for callers
   * that want to trigger a drain outside of the interval schedule.
   */
  async tick(): Promise<{ delivered: number; failed: number }> {
    if (this.draining) {
      return { delivered: 0, failed: 0 }
    }
    this.draining = true
    let delivered = 0
    let failed = 0
    try {
      const rows = await this.dlq.drain(this.batchSize, this.now())
      for (const row of rows) {
        const ok = await this.redeliver(row)
        if (ok) {
          delivered += 1
        } else {
          failed += 1
        }
      }
    } finally {
      this.draining = false
    }
    return { delivered, failed }
  }

  private async redeliver(row: DlqRow): Promise<boolean> {
    const message: MailMessage = dlqRowToMessage(row)
    try {
      await this.mailbox.save(message)
      // Remove the original DLQ row so it is not retried again. We call the
      // private helper below to avoid double-insert via `dlq.redeliver()`
      // (which would re-insert into the mailbox).
      await this.removeDlqRow(row.id)
      this.onSuccess?.(row.id)
      return true
    } catch (error) {
      const reason = classifyFailure(error)
      try {
        await this.dlq.recordAttempt(row.id, this.now())
      } catch (recordError) {
        // Swallow — surface via onFailure so a metrics collector can track.
        this.onFailure?.(row.id, reason, recordError)
        return false
      }
      this.onFailure?.(row.id, reason, error)
      return false
    }
  }

  /**
   * Delete a DLQ row by id using the same Drizzle client the store holds.
   * We reach through the store's `db` because the public API does not expose
   * a plain `remove(id)` helper — the existing `redeliver(id)` would also
   * re-insert into the mailbox, which we have already done via
   * `mailbox.save()`.
   */
  private async removeDlqRow(id: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dlq = this.dlq as unknown as { db: any }
    const { agentMailDlq } = await import('../persistence/drizzle-schema.js')
    const { eq } = await import('drizzle-orm')
    await dlq.db.delete(agentMailDlq).where(eq(agentMailDlq.id, id))
  }
}
