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
  eventLog: PipelineRuntimeEvent[];
  versionTracker: { version: number };
  /** Current cumulative recovery-attempt counter to persist. */
  recoveryAttemptsUsed: number;
  /** Node id the run is suspended at, when writing a suspend checkpoint. */
  suspendedAtNodeId?: string;
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
): Promise<void> {
  const {
    config,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    nodeIdempotencyKeys,
    loopState,
    forkState,
    eventLog,
    versionTracker,
    recoveryAttemptsUsed,
    suspendedAtNodeId,
    emit,
  } = input;

  const store = config.checkpointStore;
  if (!store) return;

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
    events: checkpointEvents(config, eventLog, savedEvent),
    executionLog,
    providerSessionRefs: checkpointProviderSessionRefs(config, nodeResults),
    state: runState,
    ...(suspendedAtNodeId !== undefined ? { suspendedAtNodeId } : {}),
    recoveryAttemptsUsed,
  });
  await store.save(checkpoint);
  await appendExecutionLogSnapshot(config, checkpoint);
  await applyCheckpointRetention(
    store,
    runId,
    config.definition.checkpoint?.retention
  );
  emit(savedEvent);
}
