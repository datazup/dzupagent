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
  PipelineCheckpointStore,
  PipelineCheckpointSummary,
} from '@dzupagent/core'

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
  query<T = unknown>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface CheckpointRow {
  pipeline_run_id: string
  pipeline_id: string
  version: number
  schema_version: string
  completed_node_ids: string[]
  state: Record<string, unknown>
  suspended_at_node_id: string | null
  budget_state: { tokensUsed: number; costCents: number } | null
  created_at: Date | string
  expires_at: Date | string | null
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PostgresPipelineCheckpointStoreOptions {
  /** Pre-connected client. */
  client: PostgresClientLike
  /** Override the table name (default: `pipeline_checkpoints`). */
  tableName?: string
  /**
   * Default TTL (in milliseconds) applied to `expires_at` on each save.
   * Leave unset for non-expiring checkpoints — `prune()` will still work.
   */
  defaultTtlMs?: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PostgresPipelineCheckpointStore implements PipelineCheckpointStore {
  private readonly client: PostgresClientLike
  private readonly tableName: string
  private readonly defaultTtlMs: number | undefined

  constructor(options: PostgresPipelineCheckpointStoreOptions) {
    this.client = options.client
    // Validate the table name to guard against injection (identifier is
    // interpolated directly because Postgres does not bind identifiers).
    const name = options.tableName ?? 'pipeline_checkpoints'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid tableName "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`)
    }
    this.tableName = name
    this.defaultTtlMs = options.defaultTtlMs
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
        state JSONB NOT NULL,
        suspended_at_node_id TEXT,
        budget_state JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE (pipeline_run_id, version)
      )
    `
    const createRunIdx = `CREATE INDEX IF NOT EXISTS ${this.tableName}_run_idx ON ${this.tableName} (pipeline_run_id)`
    const createExpiryIdx = `CREATE INDEX IF NOT EXISTS ${this.tableName}_expiry_idx ON ${this.tableName} (expires_at)`

    await this.client.query(createTable)
    await this.client.query(createRunIdx)
    await this.client.query(createExpiryIdx)
  }

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const expiresAt = this.defaultTtlMs
      ? new Date(Date.now() + this.defaultTtlMs).toISOString()
      : null

    const sql = `
      INSERT INTO ${this.tableName} (
        pipeline_run_id, pipeline_id, version, schema_version,
        completed_node_ids, state, suspended_at_node_id, budget_state,
        created_at, expires_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)
      ON CONFLICT (pipeline_run_id, version) DO UPDATE SET
        pipeline_id = EXCLUDED.pipeline_id,
        schema_version = EXCLUDED.schema_version,
        completed_node_ids = EXCLUDED.completed_node_ids,
        state = EXCLUDED.state,
        suspended_at_node_id = EXCLUDED.suspended_at_node_id,
        budget_state = EXCLUDED.budget_state,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
    `

    await this.client.query(sql, [
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
    ])
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined> {
    const sql = `
      SELECT * FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY version DESC
      LIMIT 1
    `
    const result = await this.client.query<CheckpointRow>(sql, [pipelineRunId])
    const row = result.rows[0]
    return row ? rowToCheckpoint(row) : undefined
  }

  async loadVersion(
    pipelineRunId: string,
    version: number,
  ): Promise<PipelineCheckpoint | undefined> {
    const sql = `
      SELECT * FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND version = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `
    const result = await this.client.query<CheckpointRow>(sql, [pipelineRunId, version])
    const row = result.rows[0]
    return row ? rowToCheckpoint(row) : undefined
  }

  async listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]> {
    const sql = `
      SELECT pipeline_run_id, version, created_at, completed_node_ids
      FROM ${this.tableName}
      WHERE pipeline_run_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY version ASC
    `
    const result = await this.client.query<{
      pipeline_run_id: string
      version: number
      created_at: Date | string
      completed_node_ids: string[]
    }>(sql, [pipelineRunId])

    return result.rows.map(row => ({
      pipelineRunId: row.pipeline_run_id,
      version: row.version,
      createdAt: toIsoString(row.created_at),
      completedNodeCount: Array.isArray(row.completed_node_ids)
        ? row.completed_node_ids.length
        : 0,
    }))
  }

  async delete(pipelineRunId: string): Promise<void> {
    const sql = `DELETE FROM ${this.tableName} WHERE pipeline_run_id = $1`
    await this.client.query(sql, [pipelineRunId])
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    // Prune both explicit-TTL expirations and rows older than the cutoff.
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE created_at < $1
         OR (expires_at IS NOT NULL AND expires_at < NOW())
    `
    const result = await this.client.query<{ count?: number }>(sql, [cutoff])
    // pg.Pool / postgres-js return different shapes for DELETE; most expose
    // a `rowCount` on the result envelope. We mirror rows length as a
    // fallback for adapters that surface rows or use RETURNING.
    const maybeRowCount = (result as unknown as { rowCount?: number }).rowCount
    if (typeof maybeRowCount === 'number') return maybeRowCount
    return result.rows.length
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
    schemaVersion: row.schema_version as '1.0.0',
    completedNodeIds: Array.isArray(row.completed_node_ids) ? row.completed_node_ids : [],
    state: (row.state ?? {}) as Record<string, unknown>,
    createdAt: toIsoString(row.created_at),
  }
  if (row.suspended_at_node_id) cp.suspendedAtNodeId = row.suspended_at_node_id
  if (row.budget_state) cp.budgetState = row.budget_state
  return cp
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString()
  }
  return new Date().toISOString()
}
