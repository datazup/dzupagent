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
