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
  pipelineRunId: string
  /** Pipeline definition ID this run belongs to */
  pipelineId: string
  /** Monotonically increasing version number for this run */
  version: number
  /** Schema version for forward compatibility */
  schemaVersion: '1.0.0'
  /** IDs of nodes that have completed execution */
  completedNodeIds: string[]
  /** Arbitrary state accumulated during execution */
  state: Record<string, unknown>
  /** If the pipeline is currently suspended, the node it suspended at */
  suspendedAtNodeId?: string
  /** Budget tracking state */
  budgetState?: {
    tokensUsed: number
    costCents: number
  }
  /** ISO-8601 timestamp of when this checkpoint was created */
  createdAt: string
}

/**
 * Lightweight summary of a checkpoint version — returned by listVersions().
 */
export interface PipelineCheckpointSummary {
  /** Run ID */
  pipelineRunId: string
  /** Checkpoint version number */
  version: number
  /** ISO-8601 creation timestamp */
  createdAt: string
  /** Number of completed nodes at this version */
  completedNodeCount: number
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
  save(checkpoint: PipelineCheckpoint): Promise<void>

  /** Load the latest checkpoint for a run (undefined if no checkpoint exists) */
  load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined>

  /** Load a specific version of a checkpoint */
  loadVersion(pipelineRunId: string, version: number): Promise<PipelineCheckpoint | undefined>

  /** List all checkpoint versions for a run, ordered by version ascending */
  listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]>

  /** Delete all checkpoints for a run */
  delete(pipelineRunId: string): Promise<void>

  /** Prune checkpoints older than maxAgeMs; returns the number of pruned checkpoints */
  prune(maxAgeMs: number): Promise<number>
}
