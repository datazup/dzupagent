/**
 * Row mapping for the PostgreSQL checkpoint store.
 *
 * Owns the SQL-facing shape of a checkpoint — the stored row type, the
 * positional insert column list and its placeholders, the checkpoint →
 * parameter projection, and the row → checkpoint coercion. The store in
 * `postgres-checkpoint-store.ts` keeps the connection handling and statement
 * flow and delegates every field-level mapping decision here.
 *
 * Keeping the mapping in one module matters because the projection is explicit
 * columns rather than wholesale serialization: a checkpoint field with no
 * column is silently dropped in Postgres while round-tripping green against the
 * in-memory and Redis stores.
 *
 * @module pipeline/postgres-checkpoint-row
 */

import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
import { PipelineCheckpointSchema } from "@dzupagent/core/pipeline";
import type { LoopState } from "./executor-internals/executor-state-types.js";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** A stored checkpoint row, as returned by `SELECT * FROM <table>`. */
export interface CheckpointRow {
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
  recursive_fork_completions:
    | PipelineCheckpoint["recursiveForkCompletions"]
    | null;
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
 * Adding a top-level checkpoint field means touching all five places: the
 * {@link CheckpointRow} type, the DDL and its `ADD COLUMN IF NOT EXISTS`
 * migration (both in `postgres-checkpoint-store.ts`), this list plus its
 * placeholders and the store's upsert SET, {@link checkpointInsertParams}, and
 * {@link rowToCheckpoint}. (`loop_state` is JSONB, so nested additions ride
 * free.)
 */
export const CHECKPOINT_INSERT_COLUMNS = [
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
export const CHECKPOINT_INSERT_PLACEHOLDERS =
  "$1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb";

/**
 * Positional parameters for {@link CHECKPOINT_INSERT_COLUMNS}, in order.
 * Shared by the store's `save` and `saveIfVersion` so the two writes can never
 * drift on which fields they persist.
 */
export function checkpointInsertParams(
  checkpoint: PipelineCheckpoint,
  expiresAt: string | null
): unknown[] {
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
    checkpoint.sourceBinding ? JSON.stringify(checkpoint.sourceBinding) : null,
    checkpoint.recursiveForkCompletions
      ? JSON.stringify(checkpoint.recursiveForkCompletions)
      : null,
  ];
}

// ---------------------------------------------------------------------------
// Row -> Checkpoint coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a stored row back into a validated {@link PipelineCheckpoint}.
 *
 * Optional fields are attached only when present so an absent column stays
 * absent on the checkpoint rather than becoming an explicit `undefined`, and
 * the result is schema-validated before it is handed back to the runtime.
 */
export function rowToCheckpoint(row: CheckpointRow): PipelineCheckpoint {
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
      cp.interactionResumeCursor =
        row.interaction_state.interactionResumeCursor;
    }
  }
  const parsed = PipelineCheckpointSchema.safeParse(cp);
  if (!parsed.success) {
    throw new Error(
      `Invalid pipeline checkpoint row: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }
  return parsed.data as PipelineCheckpoint;
}

/** Normalize a Postgres timestamp (driver-dependent `Date` or string) to ISO-8601. */
export function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return new Date().toISOString();
}
