/**
 * Postgres-backed ApprovalStateStore.
 *
 * This implementation is intentionally generic: it accepts any client that
 * conforms to the minimal {@link SqlClient} interface below so the package
 * avoids a hard `pg` / `postgres-js` dependency. Hosts wire whichever driver
 * they already use (node-postgres Pool, postgres.js sql tag wrapped in a
 * helper, Drizzle `execute`, etc.).
 *
 * Schema expected in the target database:
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS approval_requests (
 *   id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 *   run_id       TEXT        NOT NULL,
 *   approval_id  TEXT        NOT NULL,
 *   status       TEXT        NOT NULL CHECK (status IN ('pending','granted','rejected')),
 *   payload      JSONB       NOT NULL,
 *   response     JSONB,
 *   reason       TEXT,
 *   created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   resolved_at  TIMESTAMPTZ,
 *   UNIQUE (run_id, approval_id)
 * );
 * CREATE INDEX IF NOT EXISTS approval_requests_status_idx
 *   ON approval_requests (status);
 * ```
 *
 * `poll()` uses a 500ms polling loop — deliberately simple, no LISTEN/NOTIFY
 * coupling. Hosts that need sub-second latency can implement a LISTEN-based
 * store on top of the same schema.
 */
import type { ApprovalOutcome, ApprovalStateStore } from './approval-state-store.js'
import {
  ApprovalTimeoutError,
  DuplicateApprovalError,
  UnknownApprovalError,
} from './approval-state-store.js'

/** Minimal parameterised-query interface supported by node-postgres and postgres.js wrappers. */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>
}

export interface PostgresApprovalStateStoreOptions {
  /** Override the default table name. */
  tableName?: string
  /** Polling interval in ms (default: 500). */
  pollIntervalMs?: number
}

interface ApprovalRow {
  status: 'pending' | 'granted' | 'rejected'
  response: unknown
  reason: string | null
}

export class PostgresApprovalStateStore implements ApprovalStateStore {
  private readonly tableName: string
  private readonly pollIntervalMs: number

  constructor(
    private readonly client: SqlClient,
    options: PostgresApprovalStateStoreOptions = {},
  ) {
    this.tableName = options.tableName ?? 'approval_requests'
    this.pollIntervalMs = options.pollIntervalMs ?? 500
  }

  async createPending(runId: string, approvalId: string, payload: unknown): Promise<void> {
    // ON CONFLICT DO NOTHING is intentional — we detect duplicates via the
    // row count so the caller gets a typed error instead of a unique-violation
    // bubbling up from the driver.
    const sql =
      `INSERT INTO ${this.tableName} (run_id, approval_id, status, payload)
       VALUES ($1, $2, 'pending', $3::jsonb)
       ON CONFLICT (run_id, approval_id) DO NOTHING
       RETURNING 1`
    const { rows } = await this.client.query(sql, [runId, approvalId, JSON.stringify(payload ?? null)])
    if (rows.length === 0) {
      throw new DuplicateApprovalError(runId, approvalId)
    }
  }

  async grant(runId: string, approvalId: string, response?: unknown): Promise<void> {
    const sql =
      `UPDATE ${this.tableName}
          SET status = 'granted',
              response = $3::jsonb,
              resolved_at = now()
        WHERE run_id = $1 AND approval_id = $2 AND status = 'pending'
        RETURNING 1`
    const { rows } = await this.client.query(sql, [
      runId,
      approvalId,
      JSON.stringify(response ?? null),
    ])
    if (rows.length === 0) {
      // Differentiate "no such row" from "already resolved" — we still throw
      // UnknownApprovalError in both cases because the caller cannot act
      // meaningfully on an already-resolved approval.
      await this.assertExists(runId, approvalId)
    }
  }

  async reject(runId: string, approvalId: string, reason: string): Promise<void> {
    const sql =
      `UPDATE ${this.tableName}
          SET status = 'rejected',
              reason = $3,
              resolved_at = now()
        WHERE run_id = $1 AND approval_id = $2 AND status = 'pending'
        RETURNING 1`
    const { rows } = await this.client.query(sql, [runId, approvalId, reason])
    if (rows.length === 0) {
      await this.assertExists(runId, approvalId)
    }
  }

  async poll(runId: string, approvalId: string, timeoutMs: number): Promise<ApprovalOutcome> {
    const deadline = Date.now() + timeoutMs
    // Fast path: decision may already be recorded when poll begins.
    const initial = await this.fetch(runId, approvalId)
    if (!initial) {
      throw new UnknownApprovalError(runId, approvalId)
    }
    const initialOutcome = toOutcome(initial)
    if (initialOutcome) {
      return initialOutcome
    }

    // Poll until deadline. We use setTimeout-based waits (no busy loop) so
    // the event loop is free between checks.
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const wait = Math.min(this.pollIntervalMs, Math.max(0, remaining))
      await sleep(wait)
      if (Date.now() >= deadline) {
        break
      }
      const row = await this.fetch(runId, approvalId)
      // Row deletion between createPending and poll shouldn't happen in
      // practice; surfacing UnknownApprovalError here matches the in-memory
      // store's semantics.
      if (!row) {
        throw new UnknownApprovalError(runId, approvalId)
      }
      const outcome = toOutcome(row)
      if (outcome) {
        return outcome
      }
    }

    throw new ApprovalTimeoutError(runId, approvalId, timeoutMs)
  }

  private async fetch(runId: string, approvalId: string): Promise<ApprovalRow | null> {
    const sql =
      `SELECT status, response, reason
         FROM ${this.tableName}
        WHERE run_id = $1 AND approval_id = $2`
    const { rows } = await this.client.query<ApprovalRow>(sql, [runId, approvalId])
    return rows[0] ?? null
  }

  private async assertExists(runId: string, approvalId: string): Promise<void> {
    const row = await this.fetch(runId, approvalId)
    if (!row) {
      throw new UnknownApprovalError(runId, approvalId)
    }
  }
}

function toOutcome(row: ApprovalRow): ApprovalOutcome | null {
  if (row.status === 'granted') {
    return { decision: 'granted', response: row.response }
  }
  if (row.status === 'rejected') {
    return { decision: 'rejected', reason: row.reason ?? undefined }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
