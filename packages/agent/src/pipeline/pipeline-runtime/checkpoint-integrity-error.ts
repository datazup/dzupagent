/**
 * Integrity boundary for durable pipeline checkpoint writes.
 *
 * Checkpoint persistence is runtime transport, not authored workflow work. A
 * write failure must therefore bypass node recovery and workflow error edges.
 *
 * @module pipeline/pipeline-runtime/checkpoint-integrity-error
 */

export class PipelineCheckpointIntegrityError extends Error {
  override readonly name = "PipelineCheckpointIntegrityError";

  constructor(
    readonly nodeId: string,
    readonly boundary: PipelineCheckpointIntegrityBoundary,
    cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Pipeline checkpoint integrity failure while persisting ${boundary} for node "${nodeId}": ${detail}`,
      { cause }
    );
  }
}

export type PipelineCheckpointIntegrityBoundary =
  | "node_completion"
  | "error_edge_cursor"
  | "fork_branch_completion"
  | "fork_join_completion"
  | "loop_resume_cursor"
  | "loop_suspension"
  | "loop_terminal";

export function isPipelineCheckpointIntegrityError(
  error: unknown
): error is PipelineCheckpointIntegrityError {
  return error instanceof PipelineCheckpointIntegrityError;
}

/**
 * A durable commit was lost to a compare-and-set conflict (G2a).
 *
 * Distinct from {@link PipelineCheckpointIntegrityError}, which reports a
 * write that *threw*. Here the write completed cleanly and simply did not win:
 * another writer holds this run's version line. Nothing was persisted, so the
 * in-memory cursor is ahead of the durable record and continuing to execute
 * would compound the divergence.
 *
 * Extends `PipelineCheckpointIntegrityError`'s intent — checkpoint persistence
 * is runtime transport, not authored workflow work — so this must likewise
 * bypass node recovery and workflow error edges rather than route to an
 * authored error edge.
 */
export class PipelineCheckpointCommitConflictError extends Error {
  override readonly name = "PipelineCheckpointCommitConflictError";

  constructor(
    readonly nodeId: string,
    readonly detail: {
      /** Ordered-prefix cursor this writer tried to commit. */
      completedIterations: number;
      /** Version the store actually held instead. */
      observedVersion: number;
    }
  ) {
    super(
      `Pipeline checkpoint commit conflict at loop node "${nodeId}": another ` +
        `writer holds this run's version line (store is at version ` +
        `${detail.observedVersion}), so the ordered prefix of ` +
        `${detail.completedIterations} completed item(s) was not persisted. ` +
        `The run is not durable past the last winning commit; reload it and ` +
        `resume from the store's current checkpoint.`
    );
  }
}

export function isPipelineCheckpointCommitConflictError(
  error: unknown
): error is PipelineCheckpointCommitConflictError {
  return error instanceof PipelineCheckpointCommitConflictError;
}

export async function persistCheckpointWithIntegrityBoundary(input: {
  nodeId: string;
  boundary: PipelineCheckpointIntegrityBoundary;
  save: () => Promise<void>;
}): Promise<void> {
  try {
    await input.save();
  } catch (error) {
    if (isPipelineCheckpointIntegrityError(error)) throw error;
    throw new PipelineCheckpointIntegrityError(
      input.nodeId,
      input.boundary,
      error
    );
  }
}
