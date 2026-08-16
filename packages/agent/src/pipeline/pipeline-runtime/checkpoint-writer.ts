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
 * Why a write produced no checkpoint. `writeCheckpoint` returns `undefined` in
 * three operationally distinct situations, and callers that cannot tell them
 * apart are forced to guess:
 *
 * - `no_store` — checkpointing is not configured for this run. Nothing was
 *   durable before and nothing is expected to be; proceeding is correct.
 * - `unpersisted_run` — a store is configured but holds no checkpoint for this
 *   run, so the compare-and-set matched nothing. This is the supported
 *   `resume(checkpoint)` pattern, where the caller supplies a checkpoint
 *   object the store never held. No rival exists; proceeding is correct.
 * - `conflict` — a store IS configured, this writer lost a compare-and-set
 *   race to another writer, and **the work this checkpoint represented was not
 *   persisted**. Proceeding as though it had been is the G2a defect: the
 *   caller advances a committed prefix that no durable record backs.
 *
 * Recorded via {@link lastWriteOutcome} rather than by widening the return
 * type, so the existing `PipelineCheckpoint | undefined` contract — which
 * several call sites already branch on — stays byte-compatible.
 */
export type CheckpointWriteOutcome =
  | { kind: "committed"; checkpoint: PipelineCheckpoint }
  | { kind: "no_store" }
  | { kind: "unpersisted_run"; observedVersion: number }
  | { kind: "conflict"; observedVersion: number };

/**
 * Version a store reports for a run it holds no checkpoints for.
 *
 * Mirrors `NO_CHECKPOINT_VERSION` in the store implementations: writers
 * pre-increment from 0, so a first checkpoint carries version 1 and 0 is never
 * a stored version. A failed compare-and-set reporting 0 therefore means "this
 * run is not in the store at all", not "another writer got here first".
 *
 * The distinction matters because callers may legitimately resume from a
 * checkpoint *object* that was never persisted (`PipelineRuntime.resume` takes
 * a checkpoint, not a run id, and does not require the store to hold it).
 * Treating that as a rival writer would fail every such resume closed.
 */
const NO_CHECKPOINT_VERSION = 0;

/**
 * The outcome of the most recent {@link writeCheckpoint} call made with this
 * `versionTracker`. Keyed by the tracker object identity because that is what
 * a run frame threads through every write for its own run: two concurrent runs
 * hold distinct trackers and therefore never observe each other's outcome.
 *
 * A `WeakMap` so a finished run's entry is collected with its frame.
 */
const writeOutcomes = new WeakMap<
  CheckpointWriteInput["versionTracker"],
  CheckpointWriteOutcome
>();

/**
 * Read why the last write against `versionTracker` produced no checkpoint.
 * Returns `undefined` when no write has been attempted for that tracker yet.
 */
export function lastWriteOutcome(
  versionTracker: CheckpointWriteInput["versionTracker"]
): CheckpointWriteOutcome | undefined {
  return writeOutcomes.get(versionTracker);
}

/**
 * True when the last write against `versionTracker` lost a compare-and-set
 * race to **another writer**, meaning its checkpoint was not persisted and a
 * rival owns this run's version line.
 *
 * Deliberately narrower than "the write did not commit". Two other outcomes
 * also produce no checkpoint and must NOT be treated as a lost race:
 * `no_store` (checkpointing is not configured) and `unpersisted_run` (the
 * caller is running against a checkpoint the store never held — a supported
 * `resume(checkpoint)` pattern). Only a rival writer means the durable record
 * has moved on without us.
 */
export function lastWriteLostCommit(
  versionTracker: CheckpointWriteInput["versionTracker"]
): boolean {
  return writeOutcomes.get(versionTracker)?.kind === "conflict";
}

/**
 * Bump the checkpoint version, build the checkpoint record, persist it to the
 * configured store, append the execution-log snapshot, apply retention, and
 * emit the `checkpoint_saved` event. Requires `config.checkpointStore` to be
 * set — callers guard on strategy/store before invoking.
 *
 * Returns the committed checkpoint, or `undefined` when nothing was committed.
 * Use {@link lastWriteLostCommit} to tell a lost CAS race apart from an
 * unconfigured store.
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
  if (!store) {
    writeOutcomes.set(versionTracker, { kind: "no_store" });
    return undefined;
  }

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
      //
      // G2a: record the loss so callers can distinguish it from an
      // unconfigured store. This checkpoint did NOT persist; a caller that
      // treats the `undefined` below as "nothing to do" would advance a
      // committed prefix no durable record backs.
      versionTracker.version = receipt.observedVersion;
      writeOutcomes.set(versionTracker, {
        // A store that holds nothing for this run reports the sentinel rather
        // than a real version: the caller is writing against a checkpoint the
        // store never had, which is not a rival writer and must not fail the
        // run closed.
        kind:
          receipt.observedVersion === NO_CHECKPOINT_VERSION
            ? "unpersisted_run"
            : "conflict",
        observedVersion: receipt.observedVersion,
      });
      return undefined;
    }
  } else {
    await store.save(checkpoint);
  }
  writeOutcomes.set(versionTracker, { kind: "committed", checkpoint });
  await appendExecutionLogSnapshot(config, checkpoint);
  await applyCheckpointRetention(
    store,
    runId,
    config.definition.checkpoint?.retention
  );
  emit(savedEvent);
  return checkpoint;
}
