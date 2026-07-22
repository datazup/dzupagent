import type {
  BackgroundTask,
  TaskId,
  TaskStatus,
} from "../contracts/background-task.js";
import type { TaskFilter, TaskStore } from "../contracts/task-store.js";
import { SubagentErrorCode } from "../contracts/error-codes.js";
import type { SubagentLogger } from "../contracts/logger.js";
import { defaultSubagentLogger } from "../contracts/logger.js";
import type { TaskQueue } from "../runner/durable-queue-runner.js";
import {
  normaliseStatuses,
  rowToVersionedTask,
  sanitizeIdentifier,
  toRows,
} from "./postgres-task-store/sql-helpers.js";
import type {
  PostgresQueryClient,
  VersionedTask,
} from "./postgres-task-store/sql-helpers.js";

export type {
  PostgresQueryClient,
  VersionedTask,
} from "./postgres-task-store/sql-helpers.js";
export {
  createPostgresSubagentSchemaSql,
  type PostgresSubagentSchemaSqlOptions,
} from "./postgres-task-store/schema-sql.js";
export {
  recoverStaleRunningTasks,
  type RecoverStaleRunningTasksOptions,
} from "./postgres-task-store/recover-stale-tasks.js";

export interface PostgresTaskStoreOptions {
  client: PostgresQueryClient;
  tableName?: string;
  logger?: SubagentLogger;
}

export class PostgresTaskStore implements TaskStore {
  private readonly client: PostgresQueryClient;
  private readonly tableName: string;
  private readonly logger: SubagentLogger;

  constructor(options: PostgresTaskStoreOptions) {
    this.client = options.client;
    this.tableName = sanitizeIdentifier(options.tableName ?? "subagent_tasks");
    this.logger = options.logger ?? defaultSubagentLogger;
  }

  async put(task: BackgroundTask): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.tableName} (id, task_json, status, parent_run_id, ended_at, version)
       VALUES ($1, $2::jsonb, $3, $4, $5, 1)
       ON CONFLICT (id) DO UPDATE
       SET task_json = EXCLUDED.task_json,
           status = EXCLUDED.status,
           parent_run_id = EXCLUDED.parent_run_id,
           ended_at = EXCLUDED.ended_at,
           version = ${this.tableName}.version + 1`,
      [
        task.id,
        structuredClone(task),
        task.status,
        task.parentRunId,
        task.endedAt ?? null,
      ]
    );
  }

  async get(id: TaskId): Promise<BackgroundTask | null> {
    const found = await this.getWithVersion(id);
    return found?.task ?? null;
  }

  async getWithVersion(id: TaskId): Promise<VersionedTask | null> {
    const rows = toRows(
      await this.client.query(
        `SELECT task_json, version FROM ${this.tableName} WHERE id = $1`,
        [id]
      )
    );
    return rowToVersionedTask(rows[0]);
  }

  async list(filter: TaskFilter): Promise<BackgroundTask[]> {
    const statuses = normaliseStatuses(filter.status);
    const rows = toRows(
      await this.client.query(
        `SELECT task_json, version FROM ${this.tableName}
         WHERE ($1::jsonb->>'parentRunId' IS NULL OR parent_run_id = $1::jsonb->>'parentRunId')
           AND ($1::jsonb->'statuses' IS NULL OR status = ANY(SELECT jsonb_array_elements_text($1::jsonb->'statuses')))
           AND ($1::jsonb->>'endedBefore' IS NULL OR ended_at < (($1::jsonb->>'endedBefore')::bigint))
         ORDER BY id ASC`,
        [
          {
            parentRunId: filter.parentRunId,
            statuses,
            endedBefore: filter.endedBefore,
          },
        ]
      )
    );
    return rows
      .map(rowToVersionedTask)
      .filter((entry): entry is VersionedTask => entry !== null)
      .map((entry) => entry.task);
  }

  async patch(id: TaskId, patch: Partial<BackgroundTask>): Promise<void> {
    await this.patchWhere(id, patch, null, null);
  }

  async patchIfVersion(
    id: TaskId,
    expectedVersion: number,
    patch: Partial<BackgroundTask>
  ): Promise<boolean> {
    return this.patchWhere(id, patch, expectedVersion, null);
  }

  async patchIfStatus(
    id: TaskId,
    expectedStatus: TaskStatus,
    patch: Partial<BackgroundTask>
  ): Promise<boolean> {
    return this.patchWhere(id, patch, null, expectedStatus);
  }

  private async patchWhere(
    id: TaskId,
    patch: Partial<BackgroundTask>,
    expectedVersion: number | null,
    expectedStatus: TaskStatus | null
  ): Promise<boolean> {
    const rows = toRows(
      await this.client.query(
        `UPDATE ${this.tableName}
         SET task_json = task_json || $2::jsonb,
             status = COALESCE($5, status),
             ended_at = COALESCE($6, ended_at),
             version = version + 1
         WHERE id = $1
           AND ($3::integer IS NULL OR version = $3)
           AND ($4::text IS NULL OR status = $4)
         RETURNING task_json, version`,
        [
          id,
          structuredClone(patch),
          expectedVersion,
          expectedStatus,
          patch.status ?? null,
          patch.endedAt ?? null,
        ]
      )
    );
    const applied = rows.length > 0;
    if (!applied && (expectedVersion !== null || expectedStatus !== null)) {
      this.logger.warn({
        taskId: id,
        code: "TASK_STORE_CAS_MISS",
        ...(expectedVersion !== null ? { expectedVersion } : {}),
        ...(expectedStatus !== null ? { expectedStatus } : {}),
      });
    }
    return applied;
  }
}

export interface PostgresTaskQueueOptions {
  client: PostgresQueryClient;
  tableName?: string;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  clock?: () => number;
  autoDrain?: boolean;
  logger?: SubagentLogger;
  /**
   * Maximum number of delivery attempts before a repeatedly-failing (poisoned)
   * task is dead-lettered instead of being re-claimed. Each `claimNext`
   * increments the row's `attempts`; once it reaches this cap and the handler
   * throws again, the queue row is removed (stopping the infinite
   * claim→throw→re-claim loop) and — when a {@link store} is supplied — the
   * backing task is moved to a `failed` terminal state. Defaults to `5`.
   */
  maxAttempts?: number;
  /**
   * Optional backing task store. When provided, a dead-lettered task is also
   * transitioned to `status: "failed"` with `error: "max_attempts_exceeded"`
   * so callers observe a terminal outcome rather than a silently-dropped task.
   */
  store?: TaskStore;
}

interface QueueRow {
  task_id: string;
  leased_by: string | null;
  attempts: number;
}

export class PostgresTaskQueue implements TaskQueue {
  private readonly client: PostgresQueryClient;
  private readonly tableName: string;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly autoDrain: boolean;
  private readonly logger: SubagentLogger;
  private readonly maxAttempts: number;
  private readonly store: TaskStore | undefined;
  private handler: ((taskId: TaskId) => Promise<void>) | undefined;
  private draining = false;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PostgresTaskQueueOptions) {
    this.client = options.client;
    this.tableName = sanitizeIdentifier(
      options.tableName ?? "subagent_task_queue"
    );
    this.workerId =
      options.workerId ??
      `pg-worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.clock = options.clock ?? Date.now;
    this.autoDrain = options.autoDrain ?? true;
    this.logger = options.logger ?? defaultSubagentLogger;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.store = options.store;
  }

  async enqueue(taskId: TaskId): Promise<void> {
    const now = this.clock();
    await this.client.query(
      `INSERT INTO ${this.tableName} (task_id, enqueued_at, available_at, attempts)
       VALUES ($1, $2, $2, 0)
       ON CONFLICT (task_id) DO NOTHING`,
      [taskId, now]
    );
    this.kick();
  }

  consume(handler: (taskId: TaskId) => Promise<void>): () => void {
    this.handler = handler;
    this.stopped = false;
    this.kick();
    return () => {
      this.stopped = true;
      this.handler = undefined;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  async drainAvailable(): Promise<void> {
    if (this.draining || !this.handler || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        const row = await this.claimNext();
        if (!row || !this.handler || this.stopped) return;
        const stopHeartbeat = this.startLeaseHeartbeat(row.task_id);
        try {
          await this.handler(row.task_id);
          await this.ack(row.task_id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error({
            taskId: row.task_id,
            code: SubagentErrorCode.TASK_EXECUTION_FAILED,
            message,
            detail: "postgres_queue_handler_threw",
          });
          // Cap re-delivery: `claimNext` incremented `attempts` for this
          // delivery, so once it reaches `maxAttempts` a permanently-failing
          // (poisoned) task must be dead-lettered instead of being left for
          // its lease to lapse and re-claimed forever, which would pin a
          // worker in an infinite claim→throw→re-claim loop.
          if (row.attempts >= this.maxAttempts) {
            await this.deadLetter(row.task_id, row.attempts, message);
          }
        } finally {
          stopHeartbeat();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private kick(): void {
    if (!this.autoDrain) return;
    void this.drainAvailable().finally(() => {
      if (this.stopped || !this.handler) return;
      if (this.pollTimer) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.kick();
      }, this.pollIntervalMs);
      this.pollTimer.unref?.();
    });
  }

  /**
   * Keeps the lease alive while the handler runs so a task that legitimately
   * outlives the fixed lease window is not re-claimed and double-executed by a
   * second worker. The renewal UPDATE is scoped to this worker's ownership
   * (`leased_by = workerId`) so a lease that was legitimately lost is never
   * "renewed" back. Returns a function that stops the heartbeat.
   */
  private startLeaseHeartbeat(taskId: TaskId): () => void {
    const intervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
    let renewing = false;
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.renewLease(taskId).finally(() => {
        renewing = false;
      });
    }, intervalMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
    };
  }

  private async renewLease(taskId: TaskId): Promise<void> {
    const now = this.clock();
    try {
      await this.client.query(
        `UPDATE ${this.tableName}
         SET lease_until = $2
         WHERE task_id = $1
           AND leased_by = $3`,
        [taskId, now + this.leaseMs, this.workerId]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({
        taskId,
        code: "TASK_QUEUE_LEASE_RENEW_FAILED",
        workerId: this.workerId,
        message,
      });
    }
  }

  private async claimNext(): Promise<QueueRow | null> {
    const now = this.clock();
    const rows = toRows(
      await this.client.query(
        `WITH next_task AS (
           SELECT task_id
           FROM ${this.tableName}
           WHERE available_at <= $1
             AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY enqueued_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${this.tableName} q
         SET leased_by = $3,
             lease_until = $2,
             attempts = attempts + 1,
             last_claimed_at = $1
         FROM next_task
         WHERE q.task_id = next_task.task_id
         RETURNING q.task_id, q.leased_by, q.attempts`,
        [now, now + this.leaseMs, this.workerId]
      )
    );
    const row = rows[0];
    if (!row || typeof row.task_id !== "string") return null;
    this.logger.info({
      taskId: row.task_id,
      code: "TASK_QUEUE_CLAIMED",
      workerId: this.workerId,
      ...(row.attempts !== undefined ? { attempts: Number(row.attempts) } : {}),
    });
    return {
      task_id: row.task_id,
      leased_by: typeof row.leased_by === "string" ? row.leased_by : null,
      attempts: row.attempts !== undefined ? Number(row.attempts) : 0,
    };
  }

  private async ack(taskId: TaskId): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.tableName}
       WHERE task_id = $1
         AND leased_by = $2`,
      [taskId, this.workerId]
    );
  }

  /**
   * Moves a poisoned task to a terminal state after it has exhausted its
   * delivery budget. Removes the queue row (scoped to this worker's lease so a
   * legitimately-lost lease is never dead-lettered) so it is never re-claimed,
   * marks the backing task `failed` when a store is available, and emits a
   * governance event for operator visibility.
   */
  private async deadLetter(
    taskId: TaskId,
    attempts: number,
    lastMessage: string
  ): Promise<void> {
    await this.ack(taskId);
    if (this.store) {
      try {
        await this.store.patch(taskId, {
          status: "failed",
          error: "max_attempts_exceeded",
          endedAt: this.clock(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({
          taskId,
          code: "TASK_QUEUE_DEAD_LETTER_STORE_FAILED",
          workerId: this.workerId,
          message,
        });
      }
    }
    this.logger.error({
      taskId,
      code: SubagentErrorCode.MAX_ATTEMPTS_EXCEEDED,
      workerId: this.workerId,
      attempts,
      maxAttempts: this.maxAttempts,
      message: lastMessage,
      detail: "postgres_queue_task_dead_lettered",
    });
  }
}
