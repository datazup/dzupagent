/**
 * Checkpoint writer — the "bump version → build → save → append snapshot →
 * apply retention → emit" sequence shared by the executor's suspend handling
 * and its after-each-node checkpointing.
 *
 * Extracted from `pipeline-executor.ts` so that both call sites (suspend and
 * `saveCheckpoint`) delegate to one place instead of duplicating the write
 * pipeline. Pure delegation — no behavior change: the version bump, event
 * construction, store `save`, execution-log snapshot, retention pruning, and
 * `emit` all happen in the same order as before.
 *
 * @module pipeline/pipeline-runtime/checkpoint-writer
 */

import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";
import type { PipelineSha256Digest } from "@dzupagent/runtime-contracts";
import { digestPipelineDefinition } from "@dzupagent/runtime-contracts";
import type {
  NodeResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import { checkpointSavedEvent } from "./runtime-events.js";
import { createPipelineCheckpoint } from "./checkpoint-helpers.js";
import {
  checkpointEvents,
  checkpointExecutionLog,
  checkpointProviderSessionRefs,
  appendExecutionLogSnapshot,
  applyCheckpointRetention,
} from "./checkpoint-serialization.js";
import type { ForkState, LoopState } from "./executor-state-types.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";

/**
 * State bag threaded into a checkpoint write. Mirrors the arguments the
 * executor previously passed inline to its `handleSuspend`/`saveCheckpoint`
 * methods.
 */
export interface CheckpointWriteInput {
  config: PipelineRuntimeConfig;
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  nodeIdempotencyKeys: Record<string, string>;
  loopState: LoopState;
  forkState: ForkState;
  /**
   * Per-loop digests of resolved `for_each` item sources (E3). Optional: a run
   * that has not reached a loop has none, and their absence keeps the binding
   * to the definition digest alone.
   */
  loopSourceDigests?: Record<string, PipelineSha256Digest>;
  eventLog: PipelineRuntimeEvent[];
  versionTracker: { version: number };
  /** Current cumulative recovery-attempt counter to persist. */
  recoveryAttemptsUsed: number;
  /** Current cumulative iteration-budget accounting state. */
  budgetTracker: BudgetTrackerState;
  /** Node id the run is suspended at, when writing a suspend checkpoint. */
  suspendedAtNodeId?: string;
  pendingInteraction?: PipelineCheckpoint["pendingInteraction"];
  interactionReceipts?: PipelineCheckpoint["interactionReceipts"];
  interactionResumeCursor?: PipelineCheckpoint["interactionResumeCursor"];
  /** Emit a runtime event (typically `config.onEvent`). */
  emit: (event: PipelineRuntimeEvent) => void;
}

/**
 * Bump the checkpoint version, build the checkpoint record, persist it to the
 * configured store, append the execution-log snapshot, apply retention, and
 * emit the `checkpoint_saved` event. Requires `config.checkpointStore` to be
 * set — callers guard on strategy/store before invoking.
 */
export async function writeCheckpoint(
  input: CheckpointWriteInput
): Promise<PipelineCheckpoint | undefined> {
  const {
    config,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    loopSourceDigests,
    eventLog,
    versionTracker,
    recoveryAttemptsUsed,
    budgetTracker,
    suspendedAtNodeId,
    pendingInteraction,
    interactionReceipts,
    interactionResumeCursor,
    emit,
  } = input;

  const store = config.checkpointStore;
  if (!store) return undefined;

  versionTracker.version++;
  const savedEvent = checkpointSavedEvent(runId, versionTracker.version);
  const executionLog = checkpointExecutionLog(config, eventLog, savedEvent);
  const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
    pipelineRunId: runId,
    pipelineId: config.definition.id,
    version: versionTracker.version,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    // E3: bind the checkpoint to the exact artifact it was produced from, so
    // resume can prove it belongs to this compiled pipeline (and, per loop, to
    // the same item source) instead of trusting `pipelineId` alone.
    sourceBinding: {
      definitionDigest: digestPipelineDefinition(config.definition),
      ...(loopSourceDigests !== undefined &&
      Object.keys(loopSourceDigests).length > 0
        ? { loopSourceDigests }
        : {}),
    },
    events: checkpointEvents(config, eventLog, savedEvent),
    executionLog,
    providerSessionRefs: checkpointProviderSessionRefs(config, nodeResults),
    state: runState,
    ...(config.iterationBudget !== undefined
      ? {
          budgetState: {
            tokensUsed: 0,
            costCents: budgetTracker.cumulativeCostCents,
          },
        }
      : {}),
    ...(suspendedAtNodeId !== undefined ? { suspendedAtNodeId } : {}),
    ...(pendingInteraction !== undefined ? { pendingInteraction } : {}),
    ...(interactionReceipts !== undefined ? { interactionReceipts } : {}),
    ...(interactionResumeCursor !== undefined
      ? { interactionResumeCursor }
      : {}),
    recoveryAttemptsUsed,
  });
  // Prefer the compare-and-set path when the store implements it. `save` alone
  // cannot detect that another writer already claimed this version — the local
  // `versionTracker` bump above is unsynchronized — so two writers for one run
  // silently clobber each other. `expectedVersion` is the version *before* this
  // bump: committing takes the run from there to `versionTracker.version`.
  if (store.saveIfVersion) {
    const receipt = await store.saveIfVersion(
      checkpoint,
      versionTracker.version - 1
    );
    if (!receipt.committed) {
      // A conflict is not an error. Resynchronize the local counter to what the
      // store actually holds so the next write builds on the winner instead of
      // retrying the same lost version forever, and report the loss upward.
      versionTracker.version = receipt.observedVersion;
      return undefined;
    }
  } else {
    await store.save(checkpoint);
  }
  await appendExecutionLogSnapshot(config, checkpoint);
  await applyCheckpointRetention(
    store,
    runId,
    config.definition.checkpoint?.retention
  );
  emit(savedEvent);
  return checkpoint;
}
