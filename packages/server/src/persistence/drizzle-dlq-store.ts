/**
 * Drizzle-backed dead-letter queue for undeliverable agent mail messages.
 *
 * Messages that fail to deliver (rate-limit overflow, transient DB failure,
 * etc.) are parked in the `agent_mail_dlq` table. A worker periodically
 * {@link DrizzleDlqStore.drain}s due rows and calls {@link redeliver} to move
 * the message back to `agent_mailbox`. After {@link MAX_DLQ_ATTEMPTS} failed
 * redelivery attempts the row is marked dead ({@link markDead}) and no
 * longer appears in `drain()` output.
 *
 * Retry policy: exponential backoff starting at
 * {@link DLQ_INITIAL_BACKOFF_MS} (30s), doubling each attempt, capped at
 * {@link MAX_DLQ_ATTEMPTS} total attempts. No jitter — deterministic for
 * testing.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm'
import type { MailMessage } from '@dzupagent/agent'
import { agentMailbox, agentMailDlq } from './drizzle-schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzle = any

/** Initial backoff delay before first retry (30 seconds). */
export const DLQ_INITIAL_BACKOFF_MS = 30_000

/** Maximum attempts before a row is marked dead. */
export const MAX_DLQ_ATTEMPTS = 5

/**
 * Compute exponential backoff for the next retry.
 *
 * attempts=0 → 30s, attempts=1 → 60s, attempts=2 → 120s, ...
 */
export function computeNextRetryDelayMs(attempts: number): number {
  const clamped = Math.max(0, attempts)
  return DLQ_INITIAL_BACKOFF_MS * 2 ** clamped
}

/** Row shape matching {@link agentMailDlq}. */
export interface DlqRow {
  id: string
  originalMessageId: string
  fromAgent: string
  toAgent: string
  subject: string
  body: Record<string, unknown>
  failReason: string
  attempts: number
  nextRetryAt: number
  createdAt: number
  deadAt: number | null
}

/** Convert a stored DLQ row back to a {@link MailMessage}. */
export function dlqRowToMessage(row: DlqRow): MailMessage {
  return {
    id: row.originalMessageId,
    from: row.fromAgent,
    to: row.toAgent,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt,
  }
}

/**
 * Drizzle-backed dead-letter queue store.
 *
 * All writes are single-row; no transactions required. Callers that need
 * atomic enqueue+delete semantics should wrap calls externally.
 */
export class DrizzleDlqStore {
  constructor(private readonly db: AnyDrizzle) {}

  /**
   * Enqueue a message for later redelivery.
   *
   * The row is stored with `attempts=0` and `nextRetryAt = now + 30s`.
   */
  async enqueue(
    msg: MailMessage,
    reason: string,
    now: number = Date.now(),
  ): Promise<DlqRow> {
    const id = randomUUID()
    const row: DlqRow = {
      id,
      originalMessageId: msg.id,
      fromAgent: msg.from,
      toAgent: msg.to,
      subject: msg.subject,
      body: msg.body,
      failReason: reason,
      attempts: 0,
      nextRetryAt: now + DLQ_INITIAL_BACKOFF_MS,
      createdAt: now,
      deadAt: null,
    }
    await this.db.insert(agentMailDlq).values(row)
    return row
  }

  /**
   * Return DLQ rows that are due for retry.
   *
   * Rows are filtered: `deadAt IS NULL AND nextRetryAt <= now`, ordered by
   * `nextRetryAt` ASC so oldest-due rows drain first.
   */
  async drain(limit = 100, now: number = Date.now()): Promise<DlqRow[]> {
    const rows: DlqRow[] = await this.db
      .select()
      .from(agentMailDlq)
      .where(and(isNull(agentMailDlq.deadAt), lte(agentMailDlq.nextRetryAt, now)))
      .orderBy(asc(agentMailDlq.nextRetryAt))
      .limit(limit)
    return rows
  }

  /**
   * List all dead rows for a given recipient (for UI / manual inspection).
   */
  async listDead(recipientId: string): Promise<DlqRow[]> {
    const rows: DlqRow[] = await this.db
      .select()
      .from(agentMailDlq)
      .where(and(eq(agentMailDlq.toAgent, recipientId), sql`${agentMailDlq.deadAt} IS NOT NULL`))
      .orderBy(asc(agentMailDlq.createdAt))
    return rows
  }

  /**
   * Redeliver a DLQ entry: move the message back into `agent_mailbox` and
   * remove the DLQ row. The original message id is preserved.
   *
   * Returns `true` if the row was found and redelivered, `false` otherwise.
   */
  async redeliver(id: string): Promise<boolean> {
    const rows: DlqRow[] = await this.db
      .select()
      .from(agentMailDlq)
      .where(eq(agentMailDlq.id, id))
      .limit(1)

    const row = rows[0]
    if (!row) return false

    await this.db.insert(agentMailbox).values({
      id: row.originalMessageId,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      subject: row.subject,
      body: row.body,
      createdAt: row.createdAt,
      readAt: null,
      ttlSeconds: null,
    })

    await this.db.delete(agentMailDlq).where(eq(agentMailDlq.id, id))
    return true
  }

  /**
   * Mark a DLQ row dead. Dead rows are skipped by {@link drain}.
   */
  async markDead(id: string, now: number = Date.now()): Promise<void> {
    await this.db
      .update(agentMailDlq)
      .set({ deadAt: now })
      .where(eq(agentMailDlq.id, id))
  }

  /**
   * Record a redelivery attempt failure.
   *
   * Increments `attempts` and either schedules the next retry with
   * exponential backoff or marks the row dead if the attempt count has
   * reached {@link MAX_DLQ_ATTEMPTS}.
   *
   * Returns `true` if the row was marked dead by this call.
   */
  async recordAttempt(id: string, now: number = Date.now()): Promise<boolean> {
    const rows: DlqRow[] = await this.db
      .select()
      .from(agentMailDlq)
      .where(eq(agentMailDlq.id, id))
      .limit(1)
    const row = rows[0]
    if (!row) return false

    const nextAttempts = row.attempts + 1
    if (nextAttempts >= MAX_DLQ_ATTEMPTS) {
      await this.db
        .update(agentMailDlq)
        .set({ attempts: nextAttempts, deadAt: now })
        .where(eq(agentMailDlq.id, id))
      return true
    }

    await this.db
      .update(agentMailDlq)
      .set({
        attempts: nextAttempts,
        nextRetryAt: now + computeNextRetryDelayMs(nextAttempts),
      })
      .where(eq(agentMailDlq.id, id))
    return false
  }
}
