/**
 * Pipeline executor — executes nodes and walks the graph.
 *
 * Owns the per-node execution mechanics extracted out of
 * `PipelineRuntime`: standard node dispatch with retry/recovery,
 * fork/branch fan-out, loop expansion, suspend handling, error edges,
 * stuck-detector / calibrator / iteration-budget instrumentation, and
 * checkpointing after each node. The runtime keeps lifecycle/coordination
 * state and delegates the actual graph walk to this class.
 *
 * The heavier sub-routines (retry/backoff, fork/branch fan-out, loop
 * handling, side-effect bookkeeping, standard-node dispatch) live in the
 * `pipeline-runtime/` subdirectory so this file stays focused on the
 * dispatch flow.
 *
 * @module pipeline/pipeline-executor
 */

import type {
  PipelineNode,
  PipelineEdge,
  PipelineCheckpoint,
  ForkNode,
  JoinNode,
  LoopNode,
} from "@dzupagent/core/pipeline";
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "./pipeline-runtime-types.js";
import {
  pipelineCompletedEvent,
  pipelineFailedEvent,
  pipelineSuspendedEvent,
  checkpointSavedEvent,
} from "./pipeline-runtime/runtime-events.js";
import {
  getNextNodeIds,
  getErrorTarget,
  findJoinNode,
} from "./pipeline-runtime/edge-resolution.js";
import { extractErrorCode } from "./pipeline-runtime/error-classification.js";
import { createPipelineCheckpoint } from "./pipeline-runtime/checkpoint-helpers.js";
import { nodeIdempotencyKey } from "./pipeline-runtime/idempotency.js";
import { type BudgetTrackerState } from "./pipeline-runtime/iteration-budget-tracker.js";
import { handleFork as handleForkNode } from "./pipeline-runtime/fork-branch-executor.js";
import type { BranchExecutionResult } from "./pipeline-runtime/branch-merge.js";
import { handleLoop as handleLoopNode } from "./pipeline-runtime/loop-node-handler.js";
import type { LoopResumeOptions } from "./loop-executor.js";
import { type RecoveryCounter } from "./pipeline-runtime/node-side-effects.js";
import {
  dispatchStandardNode,
  type StandardNodeOutcome,
} from "./pipeline-runtime/standard-node-dispatch.js";

/**
 * Coordinator hooks the executor uses to read/update lifecycle state on
 * the owning runtime. Keeping these behind an interface lets the runtime
 * own canonical state (`state`, `recoveryAttemptsUsed`, `budgetTracker`)
 * while the executor focuses on graph traversal mechanics.
 */
export interface PipelineExecutorCoordinator {
  /** Get current pipeline lifecycle state. */
  getState(): PipelineState;
  /** Mutate current pipeline lifecycle state. */
  setState(next: PipelineState): void;
  /** Read current cumulative recovery-attempt counter. */
  getRecoveryAttemptsUsed(): number;
  /** Increment and return the new recovery-attempt counter value. */
  incrementRecoveryAttempts(): number;
  /** Mutable accounting state for the global iteration budget. */
  getBudgetTracker(): BudgetTrackerState;
}

/**
 * Inputs threaded through the executor for a single run. Mirrors the
 * private state previously held inline on `PipelineRuntime`'s
 * `executeFromNode`.
 */
export interface ExecuteFromNodeInput {
  startNodeId: string;
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  /** Stable `nodeId` → idempotency key map for completed nodes (W5). */
  nodeIdempotencyKeys: Record<string, string>;
  /** Per-loop-node iteration cursor for durable loop resume (W3). */
  loopState: Record<string, { iteration: number }>;
  /** Per-fork branch progress for durable fork/branch resume (W4). */
  forkState: Record<
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
  versionTracker: { version: number };
  startTime: number;
}

export class PipelineExecutor {
  private readonly recoveryCounter: RecoveryCounter;

  constructor(
    private readonly config: PipelineRuntimeConfig,
    private readonly nodeMap: Map<string, PipelineNode>,
    private readonly outgoingEdges: Map<string, PipelineEdge[]>,
    private readonly errorEdges: Map<string, PipelineEdge[]>,
    private readonly coordinator: PipelineExecutorCoordinator,
  ) {
    this.recoveryCounter = {
      get: () => this.coordinator.getRecoveryAttemptsUsed(),
      increment: () => this.coordinator.incrementRecoveryAttempts(),
    };
  }

  // ---------------------------------------------------------------------------
  // Core execution loop
  // ---------------------------------------------------------------------------

  async executeFromNode(
    input: ExecuteFromNodeInput,
  ): Promise<PipelineRunResult> {
    const {
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      nodeIdempotencyKeys,
      loopState,
      forkState,
      versionTracker,
      startTime,
    } = input;
    let currentNodeId: string | undefined = input.startNodeId;

    while (currentNodeId) {
      // Check cancellation
      if (
        this.coordinator.getState() === "cancelled" ||
        this.config.signal?.aborted
      ) {
        this.coordinator.setState("cancelled");
        return this.runResult(
          runId,
          "cancelled",
          nodeResults,
          Date.now() - startTime,
        );
      }

      const node = this.nodeMap.get(currentNodeId);
      if (!node)
        throw new Error(`Node "${currentNodeId}" not found in pipeline`);

      // Skip already-completed nodes (for resume)
      if (completedNodeIds.includes(currentNodeId)) {
        currentNodeId = this.next(currentNodeId, runState);
        continue;
      }

      // Suspend / approval-gate: yield control with a checkpoint
      if (
        node.type === "suspend" ||
        (node.type === "gate" && node.gateType === "approval")
      ) {
        return this.handleSuspend(
          node.id,
          runId,
          runState,
          nodeResults,
          completedNodeIds,
          nodeIdempotencyKeys,
          loopState,
          forkState,
          versionTracker,
          startTime,
        );
      }

      // Fork: execute branches in parallel, then continue from join
      if (node.type === "fork") {
        const forkOutcome = await this.dispatchFork(
          node as ForkNode,
          runId,
          runState,
          nodeResults,
          completedNodeIds,
          nodeIdempotencyKeys,
          loopState,
          forkState,
          versionTracker,
        );
        currentNodeId = forkOutcome.nextNodeId;
        continue;
      }

      // Loop: delegate to loop handler, then route success/error
      if (node.type === "loop") {
        const loopOutcome = await this.dispatchLoop(
          node as LoopNode,
          runId,
          runState,
          nodeResults,
          completedNodeIds,
          nodeIdempotencyKeys,
          loopState,
          forkState,
          versionTracker,
          startTime,
        );
        if (loopOutcome.kind === "return") return loopOutcome.value;
        currentNodeId = loopOutcome.nextNodeId;
        continue;
      }

      // Standard node — full retry/recovery/side-effect dispatch
      const outcome = await this.dispatchNode(
        node,
        runId,
        runState,
        nodeResults,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        versionTracker,
        startTime,
      );
      if (outcome.kind === "return") return outcome.value;
      if (outcome.kind === "rethrow") throw outcome.error;
      currentNodeId = outcome.nextNodeId;
    }

    // No more nodes — pipeline completed
    const totalMs = Date.now() - startTime;
    this.coordinator.setState("completed");
    this.emit(pipelineCompletedEvent(runId, totalMs));
    return this.runResult(runId, "completed", nodeResults, totalMs);
  }

  // ---------------------------------------------------------------------------
  // Per-node-type dispatch
  // ---------------------------------------------------------------------------

  private dispatchNode(
    node: PipelineNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
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
    >,
    versionTracker: { version: number },
    startTime: number,
  ): Promise<StandardNodeOutcome> {
    return dispatchStandardNode({
      config: this.config,
      outgoingEdges: this.outgoingEdges,
      errorEdges: this.errorEdges,
      emit: this.emit.bind(this),
      recoveryCounter: this.recoveryCounter,
      budgetTracker: this.coordinator.getBudgetTracker(),
      setState: (next) => this.coordinator.setState(next),
      pipelineId: this.config.definition.id,
      node,
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      // Stable idempotency key exposed to the node + recorded on completion.
      idempotencyKey: nodeIdempotencyKey(runId, node.id),
      onCompleted: () =>
        this.recordIdempotencyKey(nodeIdempotencyKeys, runId, node.id),
      startTime,
      saveCheckpoint: () =>
        this.saveCheckpoint(
          runId,
          runState,
          completedNodeIds,
          nodeIdempotencyKeys,
          loopState,
          forkState,
          versionTracker,
        ),
    });
  }

  private async dispatchFork(
    forkNode: ForkNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
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
    >,
    versionTracker: { version: number },
  ): Promise<{ nextNodeId: string | undefined }> {
    const forkId = forkNode.forkId;

    // Restore branches that completed before a crash (W4): rehydrate each saved
    // nodeResults object back into a Map for the merge.
    const saved = forkState[forkId]?.branches ?? {};
    const completedBranches: Record<string, BranchExecutionResult> = {};
    for (const [branchStartId, entry] of Object.entries(saved)) {
      completedBranches[branchStartId] = {
        state: "completed",
        stateDelta: entry.stateDelta,
        nodeResults: new Map(
          Object.entries(entry.nodeResults) as [string, NodeResult][],
        ),
        completedNodeIds: [],
      };
    }

    await handleForkNode(
      this.forkDeps(runId),
      forkNode,
      runState,
      nodeResults,
      completedNodeIds,
      {
        completedBranches,
        onBranchComplete: async (branchStartId, result) => {
          const bucket = (forkState[forkId] ??= { branches: {} });
          bucket.branches[branchStartId] = {
            stateDelta: result.stateDelta,
            nodeResults: Object.fromEntries(result.nodeResults),
          };
          await this.saveCheckpoint(
            runId,
            runState,
            completedNodeIds,
            nodeIdempotencyKeys,
            loopState,
            forkState,
            versionTracker,
          );
        },
      },
    );

    delete forkState[forkId];
    const joinNode = findJoinNode(forkId, this.config.definition.nodes);
    if (joinNode) {
      completedNodeIds.push(joinNode.id);
      this.recordIdempotencyKey(nodeIdempotencyKeys, runId, joinNode.id);
      await this.saveCheckpoint(
        runId,
        runState,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        versionTracker,
      );
      return { nextNodeId: this.next(joinNode.id, runState) };
    }
    return { nextNodeId: undefined };
  }

  private async dispatchLoop(
    loopNode: LoopNode,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
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
    >,
    versionTracker: { version: number },
    startTime: number,
  ): Promise<
    | { kind: "continue"; nextNodeId: string | undefined }
    | { kind: "return"; value: PipelineRunResult }
  > {
    // Durable loop resume (W3): start from the persisted cursor (if any) and
    // checkpoint the cursor + accumulated state after every iteration so a
    // crash resumes mid-loop instead of restarting at iteration 0.
    const resumeFrom = loopState[loopNode.id]?.iteration ?? 0;
    const loopResume: LoopResumeOptions = {
      startIteration: resumeFrom,
      onIterationComplete: async (completedIterations) => {
        loopState[loopNode.id] = { iteration: completedIterations };
        await this.saveCheckpoint(
          runId,
          runState,
          completedNodeIds,
          nodeIdempotencyKeys,
          loopState,
          forkState,
          versionTracker,
        );
      },
    };

    const loopResult = await handleLoopNode(
      {
        config: this.config,
        nodeMap: this.nodeMap,
        emit: this.emit.bind(this),
      },
      loopNode,
      runState,
      nodeResults,
      loopResume,
    );

    if (loopResult.error) {
      const errorNext = this.errorEdgeFor(loopNode.id, loopResult.error);
      if (errorNext) {
        nodeResults.set(loopNode.id, loopResult);
        return { kind: "continue", nextNodeId: errorNext };
      }
      this.coordinator.setState("failed");
      nodeResults.set(loopNode.id, loopResult);
      this.emit(pipelineFailedEvent(runId, loopResult.error));
      return {
        kind: "return",
        value: this.runResult(
          runId,
          "failed",
          nodeResults,
          Date.now() - startTime,
        ),
      };
    }
    // Loop finished — clear its cursor so resume does not treat it as mid-flight.
    delete loopState[loopNode.id];
    nodeResults.set(loopNode.id, loopResult);
    completedNodeIds.push(loopNode.id);
    this.recordIdempotencyKey(nodeIdempotencyKeys, runId, loopNode.id);
    await this.saveCheckpoint(
      runId,
      runState,
      completedNodeIds,
      nodeIdempotencyKeys,
      loopState,
      forkState,
      versionTracker,
    );
    return { kind: "continue", nextNodeId: this.next(loopNode.id, runState) };
  }

  // ---------------------------------------------------------------------------
  // Suspend handling
  // ---------------------------------------------------------------------------

  async handleSuspend(
    nodeId: string,
    runId: string,
    runState: Record<string, unknown>,
    nodeResults: Map<string, NodeResult>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
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
    >,
    versionTracker: { version: number },
    startTime: number,
  ): Promise<PipelineRunResult> {
    this.coordinator.setState("suspended");
    this.emit(pipelineSuspendedEvent(nodeId));

    if (this.config.checkpointStore) {
      versionTracker.version++;
      const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        state: runState,
        suspendedAtNodeId: nodeId,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
      });
      await this.config.checkpointStore.save(checkpoint);
      this.emit(checkpointSavedEvent(runId, versionTracker.version));
    }

    return this.runResult(
      runId,
      "suspended",
      nodeResults,
      Date.now() - startTime,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Build the dependency bag for fork/branch fan-out. */
  private forkDeps(runId: string) {
    return {
      config: this.config,
      nodeMap: this.nodeMap,
      outgoingEdges: this.outgoingEdges,
      emit: this.emit.bind(this),
      runId,
      findJoinNode: (forkId: string): JoinNode | undefined =>
        findJoinNode(forkId, this.config.definition.nodes),
    };
  }

  /** First next-node id for `nodeId`, evaluated against current state. */
  private next(
    nodeId: string,
    runState: Record<string, unknown>,
  ): string | undefined {
    return getNextNodeIds(
      nodeId,
      this.outgoingEdges,
      this.config.predicates,
      runState,
    )[0];
  }

  private errorEdgeFor(nodeId: string, error: unknown): string | undefined {
    return getErrorTarget(nodeId, this.errorEdges, extractErrorCode(error));
  }

  private runResult(
    runId: string,
    state: PipelineState,
    nodeResults: Map<string, NodeResult>,
    totalDurationMs: number,
  ): PipelineRunResult {
    return {
      pipelineId: this.config.definition.id,
      runId,
      state,
      nodeResults,
      totalDurationMs,
    };
  }

  private async saveCheckpoint(
    runId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[],
    nodeIdempotencyKeys: Record<string, string>,
    loopState: Record<string, { iteration: number }>,
    forkState: Record<
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
    >,
    versionTracker: { version: number },
  ): Promise<void> {
    const strategy = this.config.definition.checkpointStrategy;
    if (
      !this.config.checkpointStore ||
      !strategy ||
      strategy === "none" ||
      strategy === "manual"
    ) {
      return;
    }

    if (strategy === "after_each_node") {
      versionTracker.version++;
      const checkpoint: PipelineCheckpoint = createPipelineCheckpoint({
        pipelineRunId: runId,
        pipelineId: this.config.definition.id,
        version: versionTracker.version,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState,
        forkState,
        state: runState,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
      });
      await this.config.checkpointStore.save(checkpoint);
      this.emit(checkpointSavedEvent(runId, versionTracker.version));
    }
  }

  /**
   * Record the stable idempotency key for a completed node. Idempotent itself:
   * the key is deterministic for `(runId, nodeId)`, so re-recording is a no-op.
   */
  private recordIdempotencyKey(
    keys: Record<string, string>,
    runId: string,
    nodeId: string,
  ): void {
    keys[nodeId] = nodeIdempotencyKey(runId, nodeId);
  }

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event);
  }
}
