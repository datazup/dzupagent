/**
 * Postgres-native run queue (P2 Queue — "Option C").
 *
 * A {@link RunQueue} implementation backed by the `flow_jobs` table that needs
 * no Redis. The queue polls for `pending` rows on a configurable interval and
 * claims them atomically using `FOR UPDATE SKIP LOCKED`, so any number of
 * worker processes can drain one shared queue without grabbing the same job.
 *
 * Trade-offs vs {@link BullMQRunQueue}:
 *  - Polling adds up to `pollIntervalMs` of latency (default 500ms) but removes
 *    the Redis dependency and the LISTEN/NOTIFY driver requirement.
 *  - Stale claims (a worker died mid-job) are reclaimed once `claimedAt` is
 *    older than `claimTimeoutMs`.
 *
 * Claim query (one row per poll, highest priority / oldest first):
 * ```sql
 * UPDATE flow_jobs
 * SET status='claimed', claimed_at=now(), claimed_by=$worker, attempts=attempts+1
 * WHERE id = (
 *   SELECT id FROM flow_jobs
 *   WHERE status='pending' OR (status='claimed' AND claimed_at < $staleBefore)
 *   ORDER BY priority ASC, created_at ASC
 *   LIMIT 1 FOR UPDATE SKIP LOCKED
 * )
 * RETURNING *
 * ```
 *
 * Anti-starvation: on a shared (tenant-agnostic) worker, `fairScheduling`
 * (default on) splits the claim into two steps — first pick the least-loaded
 * pending tenant (lowest pending count, oldest-arrival tiebreak), then claim
 * one job scoped to that tenant — so a flood from one tenant cannot starve the
 * rest. A tenant-scoped worker (`config.tenantId` set) or `fairScheduling:
 * false` keeps the single-step claim above.
 *
 * @example
 * ```ts
 * import { PostgresRunQueue } from '@dzupagent/server'
 * import { drizzle } from 'drizzle-orm/postgres-js'
 *
 * const queue = new PostgresRunQueue({ db: drizzle(sql), concurrency: 10 })
 * queue.start(async (job, signal) => { ... })
 * ```
 */
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type {
  RunQueue,
  RunJob,
  RunQueueConfig,
  QueueStats,
  JobProcessor,
  DeadLetterEntry,
} from "./run-queue.js";

/**
 * Minimal Drizzle client surface used by {@link PostgresRunQueue}. Only
 * `execute(sql`...`)` is needed; the result is the driver's row list. We accept
 * both postgres-js (array) and node-postgres (`{ rows }`) shapes at runtime.
 */
export interface PostgresRunQueueDatabase {
  execute(query: SQL): Promise<unknown>;
}

export interface PostgresRunQueueConfig extends Partial<RunQueueConfig> {
  /** Drizzle client (same shape used by the worker-node store). */
  db: PostgresRunQueueDatabase;
  /** Identity recorded in `claimed_by` (default: random uuid). */
  workerId?: string;
  /** Poll interval in ms; 0 disables the background timer (default 500). */
  pollIntervalMs?: number;
  /** Reclaim `claimed` rows older than this many ms (default 60_000). */
  claimTimeoutMs?: number;
  /**
   * When set, the queue only claims jobs whose `tenant_id` matches, so a
   * worker is scoped to a single tenant. Unset = tenant-agnostic (any job).
   */
  tenantId?: string;
  /**
   * Anti-starvation fair scheduling for shared (tenant-agnostic) workers. When
   * enabled, the claim runs in two steps: first pick the least-loaded pending
   * tenant (lowest pending count, oldest tiebreak), then claim one job from
   * that tenant — so a flood from one tenant cannot starve the others.
   *
   * Defaults to `true` when {@link tenantId} is unset and `false` when it is
   * set (a tenant-scoped worker is already fair). Set explicitly to `false`
   * on a shared worker to restore the plain priority/created_at ordering.
   */
  fairScheduling?: boolean;
}

/** Raw `flow_jobs` row as returned by the driver (snake_case columns). */
interface FlowJobRow {
  id: string;
  run_id: string;
  agent_id: string;
  input: unknown;
  metadata: Record<string, unknown> | null;
  tenant_id: string | null;
  priority: number | string;
  attempts: number | string;
  status: string;
  claimed_at: Date | string | null;
  claimed_by: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Normalize a driver result into a row array (postgres-js | node-postgres). */
function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function toDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date();
}

function rowToJob(row: FlowJobRow): RunJob {
  const job: RunJob = {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    input: row.input,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    createdAt: toDate(row.created_at),
  };
  if (row.metadata) job.metadata = row.metadata;
  if (row.tenant_id) job.tenantId = row.tenant_id;
  return job;
}

export class PostgresRunQueue implements RunQueue {
  private readonly db: PostgresRunQueueDatabase;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly claimTimeoutMs: number;
  private readonly tenantId: string | undefined;
  private readonly fairScheduling: boolean;
  private readonly config: Required<RunQueueConfig>;

  private processor: JobProcessor | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight job promises keyed by job id, plus their abort controllers. */
  private active = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();

  constructor(config: PostgresRunQueueConfig) {
    this.db = config.db;
    this.workerId = config.workerId ?? `pg-worker-${randomUUID()}`;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.claimTimeoutMs = config.claimTimeoutMs ?? 60_000;
    this.tenantId = config.tenantId;
    // Fair scheduling only applies to shared (tenant-agnostic) workers; a
    // tenant-scoped worker is already fair. Default on for shared workers.
    this.fairScheduling =
      config.tenantId !== undefined ? false : config.fairScheduling ?? true;
    this.config = {
      concurrency: config.concurrency ?? 5,
      jobTimeoutMs: config.jobTimeoutMs ?? 300_000,
      maxRetries: config.maxRetries ?? 0,
      retryBackoffMs: config.retryBackoffMs ?? 1000,
    };
  }

  async enqueue(
    input: Omit<RunJob, "id" | "createdAt" | "attempts">
  ): Promise<RunJob> {
    const id = randomUUID();
    const metadata = input.metadata ?? null;
    const result = await this.db.execute(sql`
      INSERT INTO flow_jobs (id, run_id, agent_id, input, metadata, tenant_id, priority, status, attempts)
      VALUES (
        ${id},
        ${input.runId},
        ${input.agentId},
        ${JSON.stringify(input.input ?? {})}::jsonb,
        ${metadata === null ? null : JSON.stringify(metadata)}::jsonb,
        ${input.tenantId ?? "default"},
        ${input.priority},
        'pending',
        0
      )
      RETURNING *
    `);
    const rows = toRows(result);
    const row = rows[0] as FlowJobRow | undefined;
    if (row) return rowToJob(row);
    // Fall back to the constructed job if the driver returned no rows.
    const job: RunJob = {
      id,
      runId: input.runId,
      agentId: input.agentId,
      input: input.input,
      priority: input.priority,
      attempts: 0,
      createdAt: new Date(),
    };
    if (input.metadata) job.metadata = input.metadata;
    if (input.tenantId) job.tenantId = input.tenantId;
    return job;
  }

  start(processor: JobProcessor): void {
    this.processor = processor;
    this.running = true;
    if (this.pollIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this._poll();
      }, this.pollIntervalMs);
      // Don't keep the event loop alive for the poll timer alone.
      this.timer.unref?.();
    }
  }

  async stop(waitForActive = true): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (waitForActive && this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((e) => e.promise));
    } else {
      for (const { abort } of this.active.values()) abort.abort();
    }
    this.active.clear();
  }

  /**
   * Claim and dispatch as many pending jobs as remaining concurrency allows.
   * Exposed (underscore-prefixed) so tests can drive the loop deterministically
   * without relying on the background interval.
   */
  async _poll(): Promise<void> {
    if (!this.running || !this.processor) return;
    while (this.active.size < this.config.concurrency) {
      const job = await this.claimNext();
      if (!job) break;
      this.dispatch(job);
    }
  }

  cancel(runId: string): boolean {
    void this.cancelAsync(runId);
    return false;
  }

  /**
   * Async cancel — UPDATEs pending rows for `runId` to `cancelled`. Returns
   * true when at least one row changed. The synchronous {@link cancel} cannot
   * await Postgres, so prefer this method when the result is needed.
   */
  async cancelAsync(runId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE flow_jobs
      SET status = 'cancelled', updated_at = now()
      WHERE run_id = ${runId} AND status = 'pending'
      RETURNING id
    `);
    return toRows(result).length > 0;
  }

  stats(): QueueStats {
    // Synchronous snapshot: the authoritative counts live in Postgres, so this
    // returns the in-flight count and zeros. Use {@link statsAsync} for durable
    // counts aggregated from `flow_jobs`.
    return {
      pending: 0,
      active: this.active.size,
      completed: 0,
      failed: 0,
      deadLetter: 0,
    };
  }

  /** Durable stats aggregated from `flow_jobs` grouped by status. */
  async statsAsync(): Promise<QueueStats> {
    const result = await this.db.execute(sql`
      SELECT status, count(*) AS count FROM flow_jobs GROUP BY status
    `);
    const counts: Record<string, number> = {};
    for (const row of toRows(result)) {
      const status = String((row as { status: unknown }).status);
      counts[status] = Number((row as { count: unknown }).count);
    }
    return {
      pending: counts["pending"] ?? 0,
      active: counts["claimed"] ?? 0,
      completed: counts["completed"] ?? 0,
      failed: counts["failed"] ?? 0,
      deadLetter: counts["failed"] ?? 0,
    };
  }

  getDeadLetter(): DeadLetterEntry[] {
    // Synchronous interface stub — durable dead-letter rows live in Postgres.
    // Use {@link getDeadLetterAsync} to read the `failed` rows.
    return [];
  }

  /** Durable dead-letter view — rows in the `failed` terminal state. */
  async getDeadLetterAsync(): Promise<DeadLetterEntry[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM flow_jobs WHERE status = 'failed' ORDER BY updated_at DESC
    `);
    return toRows(result).map((raw) => {
      const row = raw as unknown as FlowJobRow;
      return {
        job: rowToJob(row),
        error: row.error ?? "unknown error",
        failedAt: toDate(row.updated_at),
        attempts: Number(row.attempts),
      };
    });
  }

  clearDeadLetter(): void {
    void this.clearDeadLetterAsync();
  }

  /** Durable dead-letter clear — deletes `failed` rows. */
  async clearDeadLetterAsync(): Promise<void> {
    await this.db.execute(sql`DELETE FROM flow_jobs WHERE status = 'failed'`);
  }

  // -- internals -----------------------------------------------------------

  private async claimNext(): Promise<RunJob | null> {
    const staleBefore = new Date(Date.now() - this.claimTimeoutMs);
    // Shared worker with fair scheduling: pick the least-loaded pending tenant
    // first, then claim from it — so one tenant's flood can't starve others.
    if (this.fairScheduling) {
      const fairTenant = await this.selectFairTenant(staleBefore);
      if (fairTenant === null) return null;
      return this.claimScoped(staleBefore, fairTenant);
    }
    // Tenant-scoped worker (single-step, filtered) or shared worker with fair
    // scheduling disabled (single-step, unfiltered): plain priority ordering.
    const tenantFilter =
      this.tenantId !== undefined
        ? sql`AND tenant_id = ${this.tenantId}`
        : sql``;
    return this.claimWith(staleBefore, tenantFilter);
  }

  /**
   * Step 1 of fair scheduling: return the `tenant_id` with the fewest pending
   * (or stale-claimed) jobs, oldest-arrival tiebreak. Returns null when there
   * is no claimable work at all.
   */
  private async selectFairTenant(staleBefore: Date): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT tenant_id, COUNT(*) AS pending_count
      FROM flow_jobs
      WHERE (status = 'pending'
         OR (status = 'claimed' AND claimed_at < ${staleBefore}))
      GROUP BY tenant_id
      ORDER BY pending_count ASC, MIN(created_at) ASC
      LIMIT 1
    `);
    const row = toRows(result)[0] as { tenant_id: string | null } | undefined;
    if (!row) return null;
    return row.tenant_id ?? "default";
  }

  /** Step 2 of fair scheduling: claim one job scoped to the chosen tenant. */
  private claimScoped(
    staleBefore: Date,
    fairTenant: string
  ): Promise<RunJob | null> {
    return this.claimWith(staleBefore, sql`AND tenant_id = ${fairTenant}`);
  }

  /** Atomic claim of a single pending/stale row with an optional tenant filter. */
  private async claimWith(
    staleBefore: Date,
    tenantFilter: SQL
  ): Promise<RunJob | null> {
    const result = await this.db.execute(sql`
      UPDATE flow_jobs
      SET status = 'claimed', claimed_at = now(), claimed_by = ${this.workerId}, attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM flow_jobs
        WHERE (status = 'pending'
           OR (status = 'claimed' AND claimed_at < ${staleBefore}))
          ${tenantFilter}
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    const row = toRows(result)[0] as FlowJobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  private dispatch(job: RunJob): void {
    if (!this.processor) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.config.jobTimeoutMs);

    const promise = this.processor(job, abort.signal)
      .then(() => this.markCompleted(job))
      .catch((error: unknown) => this.handleFailure(job, error))
      .finally(() => {
        clearTimeout(timeout);
        this.active.delete(job.id);
      });

    this.active.set(job.id, { promise, abort });
  }

  private async markCompleted(job: RunJob): Promise<void> {
    await this.db.execute(sql`
      UPDATE flow_jobs SET status = 'completed', updated_at = now() WHERE id = ${job.id}
    `);
  }

  private async handleFailure(job: RunJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (job.attempts <= this.config.maxRetries) {
      // Return the job to the pending pool for another attempt.
      await this.db.execute(sql`
        UPDATE flow_jobs
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL, error = ${message}, updated_at = now()
        WHERE id = ${job.id}
      `);
    } else {
      await this.db.execute(sql`
        UPDATE flow_jobs SET status = 'failed', error = ${message}, updated_at = now() WHERE id = ${job.id}
      `);
    }
  }
}
