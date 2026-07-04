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

export interface PostgresQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>;
}

export interface PostgresTaskStoreOptions {
  client: PostgresQueryClient;
  tableName?: string;
  logger?: SubagentLogger;
}

export interface PostgresSubagentSchemaSqlOptions {
  taskTableName?: string;
  queueTableName?: string;
}

export function createPostgresSubagentSchemaSql(
  options: PostgresSubagentSchemaSqlOptions = {},
): string[] {
  const taskTable = sanitizeIdentifier(
    options.taskTableName ?? "subagent_tasks",
  );
  const queueTable = sanitizeIdentifier(
    options.queueTableName ?? "subagent_task_queue",
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${taskTable} (
  id text PRIMARY KEY,
  task_json jsonb NOT NULL,
  status text NOT NULL,
  parent_run_id text NOT NULL,
  ended_at bigint,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE INDEX IF NOT EXISTS ${taskTable}_parent_status_idx
  ON ${taskTable} (parent_run_id, status)`,
    `CREATE INDEX IF NOT EXISTS ${taskTable}_ended_at_idx
  ON ${taskTable} (ended_at)
  WHERE ended_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${queueTable} (
  task_id text PRIMARY KEY,
  enqueued_at bigint NOT NULL,
  available_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  lease_until bigint,
  last_claimed_at bigint
)`,
    `CREATE INDEX IF NOT EXISTS ${queueTable}_claim_idx
  ON ${queueTable} (available_at, lease_until, enqueued_at)`,
  ];
}

export interface VersionedTask {
  task: BackgroundTask;
  version: number;
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
      ],
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
        [id],
      ),
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
        ],
      ),
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
    patch: Partial<BackgroundTask>,
  ): Promise<boolean> {
    return this.patchWhere(id, patch, expectedVersion, null);
  }

  async patchIfStatus(
    id: TaskId,
    expectedStatus: TaskStatus,
    patch: Partial<BackgroundTask>,
  ): Promise<boolean> {
    return this.patchWhere(id, patch, null, expectedStatus);
  }

  private async patchWhere(
    id: TaskId,
    patch: Partial<BackgroundTask>,
    expectedVersion: number | null,
    expectedStatus: TaskStatus | null,
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
        ],
      ),
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
}

interface QueueRow {
  task_id: string;
  leased_by: string | null;
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
  private handler: ((taskId: TaskId) => Promise<void>) | undefined;
  private draining = false;
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PostgresTaskQueueOptions) {
    this.client = options.client;
    this.tableName = sanitizeIdentifier(
      options.tableName ?? "subagent_task_queue",
    );
    this.workerId =
      options.workerId ??
      `pg-worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.clock = options.clock ?? Date.now;
    this.autoDrain = options.autoDrain ?? true;
    this.logger = options.logger ?? defaultSubagentLogger;
  }

  async enqueue(taskId: TaskId): Promise<void> {
    const now = this.clock();
    await this.client.query(
      `INSERT INTO ${this.tableName} (task_id, enqueued_at, available_at, attempts)
       VALUES ($1, $2, $2, 0)
       ON CONFLICT (task_id) DO NOTHING`,
      [taskId, now],
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
        [now, now + this.leaseMs, this.workerId],
      ),
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
    };
  }

  private async ack(taskId: TaskId): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.tableName}
       WHERE task_id = $1
         AND leased_by = $2`,
      [taskId, this.workerId],
    );
  }
}

export interface RecoverStaleRunningTasksOptions {
  store: TaskStore;
  now: number;
  runningTimeoutMs: number;
  action?: "fail" | "requeue";
  enqueue?: (taskId: TaskId) => Promise<void>;
  logger?: SubagentLogger;
}

export async function recoverStaleRunningTasks(
  options: RecoverStaleRunningTasksOptions,
): Promise<TaskId[]> {
  const action = options.action ?? "fail";
  const cutoff = options.now - options.runningTimeoutMs;
  const running = await options.store.list({ status: "running" });
  const recovered: TaskId[] = [];
  for (const task of running) {
    if (task.startedAt === undefined || task.startedAt > cutoff) continue;
    const patch: Partial<BackgroundTask> =
      action === "requeue"
        ? {
            status: "queued",
            startedAt: undefined,
            error: "stale_running_task_recovered",
          }
        : {
            status: "failed",
            error: "stale_running_task_recovered",
            endedAt: options.now,
          };
    const applied = options.store.patchIfStatus
      ? await options.store.patchIfStatus(task.id, "running", patch)
      : await patchIfStillRunning(options.store, task.id, patch);
    if (!applied) continue;
    if (action === "requeue") {
      await options.enqueue?.(task.id);
    }
    options.logger?.info({
      taskId: task.id,
      code: "STALE_RUNNING_TASK_RECOVERED",
      action,
      runningTimeoutMs: options.runningTimeoutMs,
    });
    recovered.push(task.id);
  }
  return recovered;
}

async function patchIfStillRunning(
  store: TaskStore,
  id: TaskId,
  patch: Partial<BackgroundTask>,
): Promise<boolean> {
  const current = await store.get(id);
  if (!current || current.status !== "running") return false;
  await store.patch(id, patch);
  return true;
}

function rowToVersionedTask(
  row: Record<string, unknown> | undefined,
): VersionedTask | null {
  if (!row) return null;
  const taskJson = row.task_json;
  if (!taskJson || typeof taskJson !== "object") return null;
  return {
    task: structuredClone(taskJson) as BackgroundTask,
    version: Number(row.version ?? 0),
  };
}

function toRows(
  result: { rows?: Record<string, unknown>[] } | Record<string, unknown>[],
): Record<string, unknown>[] {
  if (Array.isArray(result)) return result;
  return Array.isArray(result.rows) ? result.rows : [];
}

function normaliseStatuses(
  status: TaskStatus | TaskStatus[] | undefined,
): TaskStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

function sanitizeIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid Postgres identifier: ${identifier}`);
  }
  return identifier;
}
