/**
 * PostgreSQL implementation of {@link PipelineCheckpointStore}.
 *
 * Uses a minimal `PostgresClientLike` adapter interface rather than taking a
 * hard dependency on `pg`, `postgres`, or `drizzle-orm`. Any client that
 * exposes a `query(text, params)` method returning `{ rows }` will work —
 * this includes `pg.Pool`, `pg.Client`, and adapters built on top of
 * `postgres-js` or `drizzle` (see docs for a thin wrapper).
 *
 * @module pipeline/postgres-checkpoint-store
 */

import type {
  PipelineCheckpoint,
  PipelineCheckpointCommitReceipt,
  PipelineCheckpointStore,
  PipelineCheckpointSummary,
} from "@dzupagent/core/pipeline";
import {
  CHECKPOINT_INSERT_COLUMNS,
  CHECKPOINT_INSERT_PLACEHOLDERS,
  checkpointInsertParams,
  rowToCheckpoint,
  toIsoString,
  type CheckpointRow,
} from "./postgres-checkpoint-row.js";

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Minimal query interface compatible with `pg.Pool`, `pg.Client`,
 * `@vercel/postgres`, and similar libraries.
 *
 * Implementations MUST support positional parameters using `$1`, `$2`, ...
 * placeholders (standard PostgreSQL protocol).
 */
export interface PostgresClientLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PostgresPipelineCheckpointStoreOptions {
  /** Pre-connected client. */
  client: PostgresClientLike;
  /** Override the table name (default: `pipeline_checkpoints`). */
  tableName?: string;
  /**
   * Default TTL (in milliseconds) applied to `expires_at` on each save.
   * Leave unset for non-expiring checkpoints — `prune()` will still work.
   */
  defaultTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PostgresPipelineCheckpointStore
  implements PipelineCheckpointStore
{
  private readonly client: PostgresClientLike;
  private readonly tableName: string;
  private readonly defaultTtlMs: number | undefined;

  constructor(options: PostgresPipelineCheckpointStoreOptions) {
    this.client = options.client;
    // Validate the table name to guard against injection (identifier is
    // interpolated directly because Postgres does not bind identifiers).
    const name = options.tableName ?? "pipeline_checkpoints";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `Invalid tableName "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`
      );
    }
    this.tableName = name;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  /**
   * Create the checkpoints table + required indexes if they do not yet exist.
   * Idempotent — safe to call on every process start.
   */
  async setup(): Promise<void> {
    const createTable = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_run_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        completed_node_ids JSONB NOT NULL,
        node_idempotency_keys JSONB,
        loop_state JSONB,
        fork_state JSONB,
        recovery_attempts_used INTEGER DEFAULT 0,
        provider_session_refs JSONB,
        interaction_state JSONB,
        source_binding JSONB,
        recursive_fork_completions JSONB,
        state JSONB NOT NULL,
        suspended_at_node_id TEXT,
        budget_state JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE (pipeline_run_id, version)
      )
    `;
    const createRunIdx = `CREATE INDEX IF NOT EXISTS ${this.tableName}_run_idx ON ${this.tableName} (pipeline_run_id)`;
    const createExpiryIdx = `CREATE INDEX IF NOT EXISTS ${this.tableName}_expiry_idx ON ${this.tableName} (expires_at)`;
    // Backward-compatible migrations for tables created before W5 / W3.
    const addIdempotencyCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS node_idempotency_keys JSONB`;
    const addLoopStateCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS loop_state JSONB`;
    const addForkStateCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS fork_state JSONB`;
    // W5-gap: persist recovery attempt counter so maxRecoveryAttempts is
    // enforced across process restarts, not just within a single run.
    const addRecoveryAttemptsCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS recovery_attempts_used INTEGER DEFAULT 0`;
    const addProviderSessionRefsCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS provider_session_refs JSONB`;
    const addInteractionStateCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS interaction_state JSONB`;
    // E0: run-level binding to the exact compiled artifact / for-each source.
    const addSourceBindingCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS source_binding JSONB`;
    const addRecursiveForkCompletionsCol = `ALTER TABLE ${this.tableName} ADD COLUMN IF NOT EXISTS recursive_fork_completions JSONB`;

    await this.client.query(createTable);
    await this.client.query(addIdempotencyCol);
    await this.client.query(addLoopStateCol);
    await this.client.query(addForkStateCol);
    await this.client.query(addRecoveryAttemptsCol);
    await this.client.query(addProviderSessionRefsCol);
    await this.client.query(addInteractionStateCol);
    await this.client.query(addSourceBindingCol);
    await this.client.query(addRecursiveForkCompletionsCol);
    await this.client.query(createRunIdx);
    await this.client.query(createExpiryIdx);
  }

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const sql = `
      INSERT INTO ${this.tableName} (${CHECKPOINT_INSERT_COLUMNS})
      VALUES (${CHECKPOINT_INSERT_PLACEHOLDERS})
      ON CONFLICT (pipeline_run_id, version) DO UPDATE SET
        pipeline_id = EXCLUDED.pipeline_id,
        schema_version = EXCLUDED.schema_version,
        completed_node_ids = EXCLUDED.completed_node_ids,
        state = EXCLUDED.state,
        suspended_at_node_id = EXCLUDED.suspended_at_node_id,
        budget_state = EXCLUDED.budget_state,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at,
        node_idempotency_keys = EXCLUDED.node_idempotency_keys,
        loop_state = EXCLUDED.loop_state,
        fork_state = EXCLUDED.fork_state,
        recovery_attempts_used = EXCLUDED.recovery_attempts_used,
        provider_session_refs = EXCLUDED.provider_session_refs,
        interaction_state = EXCLUDED.interaction_state,
        source_binding = EXCLUDED.source_binding,
        recursive_fork_completions = EXCLUDED.recursive_fork_completions
    `;

    await this.client.query(
      sql,
      checkpointInsertParams(checkpoint, this.expiresAt())
    );
  }

  /**
   * Compare-and-set write.
   *
   * Relies on the table's `UNIQUE (pipeline_run_id, version)` constraint rather
   * than a read-then-write, which would race between processes. `ON CONFLICT
   * DO NOTHING` turns a losing write into zero affected rows instead of a
   * thrown constraint error, so a conflict is an ordinary reported outcome —
   * note this deliberately does NOT reuse `save`'s `DO UPDATE`, which would
   * overwrite the winner and reintroduce the clobber this closes.
   *
   * The guard is the version's uniqueness, so `expectedVersion` is only used to
   * reject an obviously stale write early and to report the observed version.
   *
   * Unlike the in-memory and Redis stores, this does NOT delegate to `save`:
   * `save` is an upsert whose `DO UPDATE` would overwrite the winning row,
   * which is the clobber this method exists to prevent. The insert is therefore
   * issued here, sharing `checkpointInsertParams` so the two writes cannot drift
   * on which columns they persist.
   */
  async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number
  ): Promise<PipelineCheckpointCommitReceipt> {
    const observed = await this.newestVersion(checkpoint.pipelineRunId);
    if (observed !== expectedVersion) {
      return { committed: false, observedVersion: observed };
    }

    const sql = `
      INSERT INTO ${this.tableName} (${CHECKPOINT_INSERT_COLUMNS})
      VALUES (${CHECKPOINT_INSERT_PLACEHOLDERS})
      ON CONFLICT (pipeline_run_id, version) DO NOTHING
    `;
    const result: { rows: unknown[]; rowCount?: number } =
      await this.client.query(
      sql,
      checkpointInsertParams(checkpoint, this.expiresAt())
    );

    const affected =
      typeof result.rowCount === "number"
        ? result.rowCount
        : result.rows.length;
    if (affected === 0) {
      return {
        committed: false,
        observedVersion: await this.newestVersion(checkpoint.pipelineRunId),
      };
    }
    return { committed: true, observedVersion: checkpoint.version };
  }

  /**
   * Highest stored version for a run, or 0 when nothing is stored — matching
   * the in-memory store's convention that a first write (version 1) expects 0.
   * Expired rows are excluded so a TTL'd-out run reads as empty, consistent
   * with `load`.
   */
  private async newestVersion(pipelineRunId: string): Promise<number> {
    const sql = `
      SELECT MAX(version) AS version FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const result = await this.client.query<{ version: number | null }>(sql, [
      pipelineRunId,
    ]);
    const newest = result.rows[0]?.version;
    return typeof newest === "number" ? newest : 0;
  }

  /** TTL-derived `expires_at` for a new row, or null when non-expiring. */
  private expiresAt(): string | null {
    return this.defaultTtlMs
      ? new Date(Date.now() + this.defaultTtlMs).toISOString()
      : null;
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined> {
    const sql = `
      SELECT * FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY version DESC
      LIMIT 1
    `;
    const result = await this.client.query<CheckpointRow>(sql, [pipelineRunId]);
    const row = result.rows[0];
    return row ? rowToCheckpoint(row) : undefined;
  }

  async loadVersion(
    pipelineRunId: string,
    version: number
  ): Promise<PipelineCheckpoint | undefined> {
    const sql = `
      SELECT * FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND version = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;
    const result = await this.client.query<CheckpointRow>(sql, [
      pipelineRunId,
      version,
    ]);
    const row = result.rows[0];
    return row ? rowToCheckpoint(row) : undefined;
  }

  async listVersions(
    pipelineRunId: string
  ): Promise<PipelineCheckpointSummary[]> {
    const sql = `
      SELECT pipeline_run_id, version, created_at, completed_node_ids
      FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY version ASC
    `;
    const result = await this.client.query<{
      pipeline_run_id: string;
      version: number;
      created_at: Date | string;
      completed_node_ids: string[];
    }>(sql, [pipelineRunId]);

    return result.rows.map((row) => ({
      pipelineRunId: row.pipeline_run_id,
      version: row.version,
      createdAt: toIsoString(row.created_at),
      completedNodeCount: Array.isArray(row.completed_node_ids)
        ? row.completed_node_ids.length
        : 0,
    }));
  }

  async delete(pipelineRunId: string): Promise<void> {
    const sql = `DELETE FROM ${this.tableName} WHERE pipeline_run_id = $1`;
    await this.client.query(sql, [pipelineRunId]);
  }

  async pruneVersions(
    pipelineRunId: string,
    keepLatest: number
  ): Promise<number> {
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND version NOT IN (
          SELECT version
          FROM ${this.tableName}
          WHERE pipeline_run_id = $1
          ORDER BY version DESC
          LIMIT $2
        )
    `;
    const result: { rows: unknown[]; rowCount?: number } =
      await this.client.query(sql, [pipelineRunId, keepLatest]);
    if (typeof result.rowCount === "number") return result.rowCount;
    return result.rows.length;
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    // Prune both explicit-TTL expirations and rows older than the cutoff.
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE created_at < $1
         OR (expires_at IS NOT NULL AND expires_at < NOW())
    `;
    const result: { rows: unknown[]; rowCount?: number } =
      await this.client.query<{ count?: number }>(sql, [cutoff]);
    // pg.Pool / postgres-js return different shapes for DELETE; most expose
    // a `rowCount` on the result envelope. We mirror rows length as a
    // fallback for adapters that surface rows or use RETURNING. Typing the
    // local `result` with the optional `rowCount` field keeps the access
    // safe without a wide cast.
    if (typeof result.rowCount === "number") return result.rowCount;
    return result.rows.length;
  }
}
