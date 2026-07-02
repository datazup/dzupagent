/**
 * Pipeline checkpoint store — interfaces for persisting pipeline run state.
 *
 * All types are JSON-serializable (ISO strings instead of Date objects).
 *
 * @module pipeline/pipeline-checkpoint-store
 */

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

/**
 * Snapshot of a pipeline run's state at a point in time.
 *
 * Checkpoints are versioned — each save increments the version number
 * so callers can load any prior version or the latest.
 */
export interface PipelineCheckpoint {
  /** Unique run identifier (one pipeline definition can have many runs) */
  pipelineRunId: string;
  /** Pipeline definition ID this run belongs to */
  pipelineId: string;
  /** Monotonically increasing version number for this run */
  version: number;
  /** Schema version for forward compatibility */
  schemaVersion: "1.0.0";
  /** IDs of nodes that have completed execution */
  completedNodeIds: string[];
  /**
   * Stable idempotency key per completed node (`nodeId` → key).
   *
   * The key is deterministic for a given `(pipelineRunId, nodeId)`, so a node's
   * external effects can be deduplicated by a downstream store even if the
   * process crashed after the effect ran but before this checkpoint persisted.
   * Optional for backward compatibility with checkpoints written before this
   * field existed; absence is treated as "no recorded keys".
   */
  nodeIdempotencyKeys?: Record<string, string>;
  /**
   * Per-loop-node iteration cursor (W3 durable loop resume).
   *
   * Maps a loop node's ID to the number of fully-completed iterations. On
   * resume the loop restarts at `iteration` (skipping completed iterations)
   * rather than from zero, so a crash mid-loop does not re-run earlier
   * iterations. An entry is removed once its loop completes. Optional for
   * backward compatibility; absence means "no loop is mid-flight".
   */
  loopState?: Record<string, { iteration: number }>;
  /**
   * Per-fork branch progress for durable fork/branch resume (W4).
   *
   * Maps a fork node's `forkId` to the branches that have fully completed,
   * each with the state delta and node results it produced. On resume,
   * completed branches are restored from here (not re-run) and only
   * unfinished branches re-execute; the final merge combines restored +
   * freshly-run results in deterministic outgoing-edge order. An entry is
   * removed once the fork's join completes. Optional for backward
   * compatibility; absence means "no fork is mid-flight". `nodeResults` is
   * the JSON-serialized form of a `NodeResult` map (`nodeId` -> result);
   * this module intentionally avoids importing `NodeResult` to keep the
   * checkpoint store free of runtime-contracts coupling.
   */
  forkState?: Record<
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
  >;
  /** Arbitrary state accumulated during execution */
  state: Record<string, unknown>;
  /** If the pipeline is currently suspended, the node it suspended at */
  suspendedAtNodeId?: string;
  /** Budget tracking state */
  budgetState?: {
    tokensUsed: number;
    costCents: number;
  };
  /** Number of recovery attempts consumed in this run (persisted to enforce limits across restarts) */
  recoveryAttemptsUsed?: number;
  /** Runtime events embedded in this checkpoint when requested by policy. */
  events?: PipelineCheckpointEventRecord[];
  /** Execution-log snapshot embedded in this checkpoint when requested by policy. */
  executionLog?: PipelineCheckpointExecutionLog;
  /** ISO-8601 timestamp of when this checkpoint was created */
  createdAt: string;
}

export type PipelineCheckpointEventRecord = Record<string, unknown> & {
  type: string;
};

export interface PipelineCheckpointExecutionLog {
  storeRef?: string;
  eventHistory: "compact" | "full";
  events: PipelineCheckpointEventRecord[];
}

/**
 * Lightweight summary of a checkpoint version — returned by listVersions().
 */
export interface PipelineCheckpointSummary {
  /** Run ID */
  pipelineRunId: string;
  /** Checkpoint version number */
  version: number;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** Number of completed nodes at this version */
  completedNodeCount: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * Persistence interface for pipeline checkpoints.
 *
 * Implementations may store data in-memory, on disk, or in a database.
 * All methods are async to support any backend.
 */
export interface PipelineCheckpointStore {
  /** Save a checkpoint (creates or updates by pipelineRunId + version) */
  save(checkpoint: PipelineCheckpoint): Promise<void>;

  /** Load the latest checkpoint for a run (undefined if no checkpoint exists) */
  load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined>;

  /** Load a specific version of a checkpoint */
  loadVersion(
    pipelineRunId: string,
    version: number,
  ): Promise<PipelineCheckpoint | undefined>;

  /** List all checkpoint versions for a run, ordered by version ascending */
  listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]>;

  /** Delete all checkpoints for a run */
  delete(pipelineRunId: string): Promise<void>;

  /** Optional: prune old versions for one run, keeping the newest `keepLatest` versions */
  pruneVersions?(pipelineRunId: string, keepLatest: number): Promise<number>;

  /** Prune checkpoints older than maxAgeMs; returns the number of pruned checkpoints */
  prune(maxAgeMs: number): Promise<number>;
}
