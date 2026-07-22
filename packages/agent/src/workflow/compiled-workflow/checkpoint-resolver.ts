/**
 * Checkpoint resolution for compiled-workflow resume paths.
 *
 * Extracted from `compiled-workflow.ts` (DZUPAGENT-ARCH-M-06). Normalises the
 * `PipelineCheckpoint | string` argument accepted by {@link CompiledWorkflow.resume}
 * into a concrete {@link PipelineCheckpoint}: a string is treated as a
 * `pipelineRunId` and loaded from the configured checkpoint store.
 *
 * Behaviour is byte-for-byte identical to the original in-class implementation.
 *
 * @module workflow/compiled-workflow/checkpoint-resolver
 */
import type {
  PipelineCheckpoint,
  PipelineCheckpointStore,
} from "@dzupagent/core/pipeline";

/**
 * Resolve `checkpointOrRunId` to a concrete {@link PipelineCheckpoint}.
 *
 * @throws if `checkpointOrRunId` is a string and no checkpoint store is
 *   configured, or if no checkpoint exists for the given runId.
 */
export async function loadCheckpoint(
  checkpointOrRunId: PipelineCheckpoint | string,
  checkpointStore: PipelineCheckpointStore | undefined
): Promise<PipelineCheckpoint> {
  if (typeof checkpointOrRunId !== "string") {
    return checkpointOrRunId;
  }
  if (!checkpointStore) {
    throw new Error(
      `Cannot resume by runId '${checkpointOrRunId}': no checkpoint store configured. Use withCheckpointStore() or pass a PipelineCheckpoint directly.`
    );
  }
  const checkpoint = await checkpointStore.load(checkpointOrRunId);
  if (!checkpoint) {
    throw new Error(
      `No checkpoint found for pipelineRunId '${checkpointOrRunId}'`
    );
  }
  return checkpoint;
}
