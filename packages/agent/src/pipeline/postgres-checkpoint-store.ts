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
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import type { LoopState } from "./pipeline-runtime/executor-state-types.js";

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
// Row shape
// ---------------------------------------------------------------------------

interface CheckpointRow {
  pipeline_run_id: string;
  pipeline_id: string;
  version: number;
  schema_version: string;
  completed_node_ids: string[];
  node_idempotency_keys: Record<string, string> | null;
  loop_state: LoopState | null;
  fork_state: Record<
    string,
    {
      branches: Record<
        string,
        {
          stateDelta: Record<string, unknown>;
          nodeResults: Record<string, unknown>;
        }
      >;
    }
  > | null;
  state: Record<string, unknown>;
  suspended_at_node_id: string | null;
  budget_state: { tokensUsed: number; costCents: number } | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  recovery_attempts_used: number | null;
  provider_session_refs: PipelineCheckpoint["providerSessionRefs"] | null;
  source_binding: PipelineCheckpoint["sourceBinding"] | null;
  recursive_fork_completions: PipelineCheckpoint["recursiveForkCompletions"] | null;
  interaction_state: {
    pendingInteraction?: PipelineCheckpoint["pendingInteraction"];
    interactionReceipts?: PipelineCheckpoint["interactionReceipts"];
    interactionResumeCursor?: PipelineCheckpoint["interactionResumeCursor"];
  } | null;
}

// ---------------------------------------------------------------------------
// Insert shape (shared by save + saveIfVersion)
// ---------------------------------------------------------------------------

/**
 * Columns written by every checkpoint insert, in positional-parameter order.
 *
 * The row mapping here is explicit columns, not wholesale serialization, so a
 * checkpoint field with no column is silently dropped in Postgres while
 * round-tripping green against the in-memory and Redis stores. Adding a
 * top-level field means touching all five places: the row type, the DDL, an
 * `ADD COLUMN IF NOT EXISTS` migration, this list plus its placeholders and the
 * upsert SET, and `rowToCheckpoint`. (`loop_state` is JSONB, so nested
 * additions ride free.)
 */
const CHECKPOINT_INSERT_COLUMNS = [
  "pipeline_run_id",
  "pipeline_id",
  "version",
  "schema_version",
  "completed_node_ids",
  "state",
  "suspended_at_node_id",
  "budget_state",
  "created_at",
  "expires_at",
  "node_idempotency_keys",
  "loop_state",
  "fork_state",
  "recovery_attempts_used",
  "provider_session_refs",
  "interaction_state",
  "source_binding",
  "recursive_fork_completions",
].join(", ");

/** JSONB-cast positional placeholders matching {@link CHECKPOINT_INSERT_COLUMNS}. */
const CHECKPOINT_INSERT_PLACEHOLDERS =
  "$1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb";

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

    await this.client.query(sql, this.insertParams(checkpoint));
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
   * issued here, sharing `insertParams` so the two writes cannot drift on which
   * columns they persist.
   */
  async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number,
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
      await this.client.query(sql, this.insertParams(checkpoint));

    const affected =
      typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
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

  /**
   * Positional parameters for {@link CHECKPOINT_INSERT_COLUMNS}, in order.
   * Shared by `save` and `saveIfVersion` so the two writes can never drift on
   * which fields they persist.
   */
  private insertParams(checkpoint: PipelineCheckpoint): unknown[] {
    const expiresAt = this.defaultTtlMs
      ? new Date(Date.now() + this.defaultTtlMs).toISOString()
      : null;

    return [
      checkpoint.pipelineRunId,
      checkpoint.pipelineId,
      checkpoint.version,
      checkpoint.schemaVersion,
      JSON.stringify(checkpoint.completedNodeIds),
      JSON.stringify(checkpoint.state),
      checkpoint.suspendedAtNodeId ?? null,
      checkpoint.budgetState ? JSON.stringify(checkpoint.budgetState) : null,
      checkpoint.createdAt,
      expiresAt,
      checkpoint.nodeIdempotencyKeys
        ? JSON.stringify(checkpoint.nodeIdempotencyKeys)
        : null,
      checkpoint.loopState ? JSON.stringify(checkpoint.loopState) : null,
      checkpoint.forkState ? JSON.stringify(checkpoint.forkState) : null,
      checkpoint.recoveryAttemptsUsed ?? 0,
      checkpoint.providerSessionRefs
        ? JSON.stringify(checkpoint.providerSessionRefs)
        : null,
      checkpoint.pendingInteraction !== undefined ||
      checkpoint.interactionReceipts !== undefined ||
      checkpoint.interactionResumeCursor !== undefined
        ? JSON.stringify({
            pendingInteraction: checkpoint.pendingInteraction,
            interactionReceipts: checkpoint.interactionReceipts,
            interactionResumeCursor: checkpoint.interactionResumeCursor,
          })
        : null,
      checkpoint.sourceBinding
        ? JSON.stringify(checkpoint.sourceBinding)
        : null,
      checkpoint.recursiveForkCompletions
        ? JSON.stringify(checkpoint.recursiveForkCompletions)
        : null,
    ];
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

// ---------------------------------------------------------------------------
// Row -> Checkpoint coercion
// ---------------------------------------------------------------------------

function rowToCheckpoint(row: CheckpointRow): PipelineCheckpoint {
  const cp: PipelineCheckpoint = {
    pipelineRunId: row.pipeline_run_id,
    pipelineId: row.pipeline_id,
    version: row.version,
    schemaVersion: row.schema_version as PipelineCheckpoint["schemaVersion"],
    completedNodeIds: Array.isArray(row.completed_node_ids)
      ? row.completed_node_ids
      : [],
    state: (row.state ?? {}) as Record<string, unknown>,
    createdAt: toIsoString(row.created_at),
  };
  if (row.suspended_at_node_id) cp.suspendedAtNodeId = row.suspended_at_node_id;
  if (row.budget_state) cp.budgetState = row.budget_state;
  if (
    row.node_idempotency_keys &&
    typeof row.node_idempotency_keys === "object"
  ) {
    cp.nodeIdempotencyKeys = row.node_idempotency_keys;
  }
  if (row.loop_state && typeof row.loop_state === "object") {
    cp.loopState = row.loop_state;
  }
  if (row.fork_state && typeof row.fork_state === "object") {
    cp.forkState = row.fork_state;
  }
  if (
    typeof row.recovery_attempts_used === "number" &&
    row.recovery_attempts_used > 0
  ) {
    cp.recoveryAttemptsUsed = row.recovery_attempts_used;
  }
  if (Array.isArray(row.provider_session_refs)) {
    cp.providerSessionRefs = row.provider_session_refs;
  }
  if (row.source_binding && typeof row.source_binding === "object") {
    cp.sourceBinding = row.source_binding;
  }
  if (
    row.recursive_fork_completions &&
    typeof row.recursive_fork_completions === "object"
  ) {
    cp.recursiveForkCompletions = row.recursive_fork_completions;
  }
  if (row.interaction_state && typeof row.interaction_state === "object") {
    if (row.interaction_state.pendingInteraction !== undefined) {
      cp.pendingInteraction = row.interaction_state.pendingInteraction;
    }
    if (row.interaction_state.interactionReceipts !== undefined) {
      cp.interactionReceipts = row.interaction_state.interactionReceipts;
    }
    if (row.interaction_state.interactionResumeCursor !== undefined) {
      cp.interactionResumeCursor = row.interaction_state.interactionResumeCursor;
    }
  }
  const parsed = PipelineCheckpointSchema.safeParse(cp);
  if (!parsed.success) {
    throw new Error(
      `Invalid pipeline checkpoint row: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data as PipelineCheckpoint;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return new Date().toISOString();
}
