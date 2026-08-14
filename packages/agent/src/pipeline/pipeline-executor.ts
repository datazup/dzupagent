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
 * dispatch flow. Checkpoint writing (the version-bump → build → save →
 * snapshot → retention → emit sequence) lives in
 * `pipeline-runtime/checkpoint-writer.ts`; the pure event/state serialization
 * helpers it uses live in `pipeline-runtime/checkpoint-serialization.ts`.
 *
 * @module pipeline/pipeline-executor
 */

import type {
  PipelineNode,
  PipelineEdge,
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
  pipelineSuspendedEvent,
} from "./pipeline-runtime/runtime-events.js";
import {
  getNextNodeIds,
  getErrorTarget,
  findJoinNode,
} from "./pipeline-runtime/edge-resolution.js";
import { extractErrorCode } from "./pipeline-runtime/error-classification.js";
import { writeCheckpoint } from "./pipeline-runtime/checkpoint-writer.js";
import {
  dispatchForkStage,
  dispatchLoopStage,
  type StageContext,
  type RunFrame,
} from "./pipeline-runtime/stage-dispatch.js";
import {
  nodeIdempotencyKey,
  nodeIdempotencyContext,
} from "./pipeline-runtime/idempotency.js";
import { type BudgetTrackerState } from "./pipeline-runtime/iteration-budget-tracker.js";
import { type RecoveryCounter } from "./pipeline-runtime/node-side-effects.js";
import {
  dispatchStandardNode,
  type StandardNodeOutcome,
} from "./pipeline-runtime/standard-node-dispatch.js";
import type {
  LoopBodyGraphScheduleInput,
  LoopBodyGraphScheduleResult,
} from "./loop-executor/types.js";
import { validateLoopBodyGraphCheckpointState } from "./loop-body-graph-checkpoint-validator.js";
import { isPipelineCheckpointIntegrityError } from "./pipeline-runtime/checkpoint-integrity-error.js";

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
 * `executeFromNode`. Extends the per-run {@link RunFrame} with the entry
 * node id.
 */
export interface ExecuteFromNodeInput extends RunFrame {
  startNodeId: string;
}

export class PipelineExecutor {
  private readonly recoveryCounter: RecoveryCounter;

  constructor(
    private readonly config: PipelineRuntimeConfig,
    private readonly nodeMap: Map<string, PipelineNode>,
    private readonly outgoingEdges: Map<string, PipelineEdge[]>,
    private readonly errorEdges: Map<string, PipelineEdge[]>,
    private readonly coordinator: PipelineExecutorCoordinator,
    private readonly checkpointOverride?: (
      frame: RunFrame,
      selectedNextNodeId?: string
    ) => Promise<void>
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
    input: ExecuteFromNodeInput
  ): Promise<PipelineRunResult> {
    // `ExecuteFromNodeInput extends RunFrame`, so the input already carries
    // the per-run frame (all fields are references, as before).
    const frame: RunFrame = input;
    const { runId, runState, nodeResults, forkState, startTime } = frame;
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
          Date.now() - startTime
        );
      }

      const node = this.nodeMap.get(currentNodeId);
      if (!node)
        throw new Error(`Node "${currentNodeId}" not found in pipeline`);

      // Skip already-completed nodes (for resume) — EXCEPT a fork node that is
      // still mid-flight (its forkState entry survives). Such a fork was pushed
      // to completedNodeIds when it first started, but on resume it must re-enter
      // dispatchForkStage to restore completed branches and re-run unfinished
      // ones. dispatchForkStage clears forkState[forkId] once the fork+join
      // complete, so later passes over the fork node skip normally.
      const isMidFlightFork =
        node.type === "fork" && forkState[node.forkId] !== undefined;
      if (frame.completedNodeIds.includes(currentNodeId) && !isMidFlightFork) {
        currentNodeId = this.next(currentNodeId, runState);
        continue;
      }

      // Suspend / approval-gate: yield control with a checkpoint
      if (
        node.type === "suspend" ||
        (node.type === "gate" && node.gateType === "approval")
      ) {
        return this.handleSuspend(node.id, frame);
      }

      // Fork: execute branches in parallel, then continue from join
      if (node.type === "fork") {
        const forkOutcome = await dispatchForkStage(
          this.stageContext(),
          node as ForkNode,
          frame
        );
        currentNodeId = forkOutcome.nextNodeId;
        continue;
      }

      // Loop: delegate to loop handler, then route success/error
      if (node.type === "loop") {
        const loopOutcome = await dispatchLoopStage(
          this.stageContext(),
          node as LoopNode,
          frame
        );
        if (loopOutcome.kind === "return") return loopOutcome.value;
        currentNodeId = loopOutcome.nextNodeId;
        continue;
      }

      // Standard node — full retry/recovery/side-effect dispatch
      const outcome = await this.dispatchNode(node, frame);
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

  /**
   * Build the dependency bag that the extracted fork/loop stage executors use
   * to reach back into this executor's private helpers.
   */
  private stageContext(): StageContext {
    return {
      config: this.config,
      nodeMap: this.nodeMap,
      saveCheckpoint: (frame) => this.saveCheckpoint(frame),
      next: (nodeId, runState) => this.next(nodeId, runState),
      recordIdempotencyKey: (keys, runId, node) =>
        this.recordIdempotencyKey(keys, runId, node),
      errorEdgeFor: (nodeId, error) => this.errorEdgeFor(nodeId, error),
      forkDeps: (runId) => this.forkDeps(runId),
      budgetTracker: this.coordinator.getBudgetTracker(),
      emit: this.emit.bind(this),
      setState: (next) => this.coordinator.setState(next),
      runResult: (runId, state, nodeResults, totalDurationMs) =>
        this.runResult(runId, state, nodeResults, totalDurationMs),
      scheduleLoopBodyGraph: (loopNode, frame, input) =>
        this.scheduleLoopBodyGraph(loopNode, frame, input),
    };
  }

  /**
   * Execute one compiler-bounded loop-body graph through the canonical
   * pipeline executor. The scoped definition contains only body nodes and
   * internal edges, so traversal cannot escape into the outer pipeline.
   */
  private async scheduleLoopBodyGraph(
    loopNode: LoopNode,
    outerFrame: RunFrame,
    input: LoopBodyGraphScheduleInput
  ): Promise<LoopBodyGraphScheduleResult> {
    const boundary = loopNode.bodyGraph;
    if (boundary === undefined) {
      throw new Error(
        `Loop node "${loopNode.id}": cannot schedule a graph body without bodyGraph metadata`
      );
    }

    const bodyIds = new Set(loopNode.bodyNodeIds);
    const nodes = this.config.definition.nodes.filter((node) =>
      bodyIds.has(node.id)
    );
    if (nodes.length !== bodyIds.size) {
      throw new Error(
        `Loop node "${loopNode.id}": graph body references a missing node`
      );
    }
    const edges = this.config.definition.edges.filter(
      (edge) =>
        bodyIds.has(edge.sourceNodeId) &&
        edgeTargets(edge).every((targetId) => bodyIds.has(targetId))
    );
    const definition = {
      ...this.config.definition,
      id: `${this.config.definition.id}::loop-body:${loopNode.id}`,
      entryNodeId: boundary.entryNodeId,
      nodes,
      edges,
      checkpointStrategy: "after_each_node" as const,
    };

    // Suppress scoped lifecycle events; node/fork/loop events remain visible
    // on the owning run, while the outer loop emits the one authoritative
    // pipeline-level terminal event.
    const onEvent = this.config.onEvent;
    const config: PipelineRuntimeConfig = {
      ...this.config,
      definition,
      ...(input.context.signal === undefined
        ? {}
        : {
            // The loop handler originates this context from the runtime's
            // AbortSignal and the iteration-deadline helper preserves that
            // concrete signal. The public node context intentionally exposes
            // only the smaller CancellationSignal structural contract.
            signal: input.context.signal as AbortSignal,
          }),
      onEvent: (event) => {
        if (
          event.type !== "pipeline:completed" &&
          event.type !== "pipeline:failed" &&
          event.type !== "pipeline:suspended"
        ) {
          onEvent?.(event);
        }
      },
    };

    let state: PipelineState = "running";
    const scopedCoordinator: PipelineExecutorCoordinator = {
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      getRecoveryAttemptsUsed: () =>
        this.coordinator.getRecoveryAttemptsUsed(),
      incrementRecoveryAttempts: () =>
        this.coordinator.incrementRecoveryAttempts(),
      getBudgetTracker: () => this.coordinator.getBudgetTracker(),
    };
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const outgoingEdges = new Map<string, PipelineEdge[]>();
    const errorEdges = new Map<string, PipelineEdge[]>();
    for (const node of nodes) {
      outgoingEdges.set(node.id, []);
      errorEdges.set(node.id, []);
    }
    for (const edge of edges) {
      const index = edge.type === "error" ? errorEdges : outgoingEdges;
      index.get(edge.sourceNodeId)?.push(edge);
    }

    const nodeResults = new Map(input.context.previousResults);
    const priorBodyResults = new Map<string, NodeResult>();
    for (const nodeId of bodyIds) {
      const prior = nodeResults.get(nodeId);
      if (prior !== undefined) priorBodyResults.set(nodeId, prior);
    }
    const restored = input.resumeState;
    if (restored !== undefined) {
      validateLoopBodyGraphCheckpointState(
        { loopNode, nodes, outgoingEdges, errorEdges },
        restored
      );
    }
    if (restored !== undefined) {
      for (const [nodeId, result] of Object.entries(restored.nodeResults)) {
        nodeResults.set(nodeId, result);
      }
    }
    const completedNodeIds = [...(restored?.completedNodeIds ?? [])];
    const nodeIdempotencyKeys = {
      ...(restored?.nodeIdempotencyKeys ?? {}),
    };
    const forkState = structuredClone(restored?.forkState ?? {});
    const scopedRunId = `${outerFrame.runId}::loop:${loopNode.id}:iteration:${input.iteration}`;

    if (restored?.completed === true) {
      const bodyResults = bodyResultsFor(
        completedNodeIds,
        nodeResults,
        bodyIds,
        priorBodyResults
      );
      const lastResult = lastCompletedResult(completedNodeIds, nodeResults);
      return {
        state: "completed",
        bodyResults,
        ...(lastResult === undefined ? {} : { lastResult }),
      };
    }

    const startNodeId = restored?.nextNodeId ?? boundary.entryNodeId;

    const scopedExecutor = new PipelineExecutor(
      config,
      nodeMap,
      outgoingEdges,
      errorEdges,
      scopedCoordinator,
      async (scopedFrame, selectedNextNodeId) => {
        if (input.onCheckpoint === undefined) return;
        const nextNodeId =
          selectedNextNodeId ??
          nextScopedNodeId(
            scopedFrame,
            nodes,
            outgoingEdges,
            config.predicates,
            boundary.entryNodeId
          );
        const checkpointResults = bodyResultsFor(
          scopedFrame.completedNodeIds,
          scopedFrame.nodeResults,
          bodyIds,
          priorBodyResults
        );
        await input.onCheckpoint({
          completed: nextNodeId === undefined,
          ...(nextNodeId === undefined ? {} : { nextNodeId }),
          completedNodeIds: [...scopedFrame.completedNodeIds],
          nodeResults: checkpointBodyResults(
            checkpointResults,
            config.definition.checkpoint?.includeProviderSessionRefs === true
          ),
          nodeIdempotencyKeys: { ...scopedFrame.nodeIdempotencyKeys },
          ...(Object.keys(scopedFrame.forkState).length === 0
            ? {}
            : { forkState: structuredClone(scopedFrame.forkState) }),
        });
      }
    );

    let runResult: PipelineRunResult;
    try {
      runResult = await scopedExecutor.executeFromNode({
        startNodeId,
        runId: scopedRunId,
        runState: input.context.state,
        nodeResults,
        completedNodeIds,
        nodeIdempotencyKeys,
        loopState: {},
        forkState,
        eventLog: [],
        versionTracker: { version: 0 },
        startTime: Date.now(),
      });
    } catch (error) {
      if (isPipelineCheckpointIntegrityError(error)) throw error;
      return {
        state: "failed",
        bodyResults: bodyResultsFor(
          completedNodeIds,
          nodeResults,
          bodyIds,
          priorBodyResults
        ),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const bodyResults = bodyResultsFor(
      completedNodeIds,
      runResult.nodeResults,
      bodyIds,
      priorBodyResults
    );
    const completedResult = lastCompletedResult(
      completedNodeIds,
      runResult.nodeResults
    );
    const failedResult = [...bodyResults.values()]
      .reverse()
      .find((result) => result.error !== undefined);
    const lastResult = completedResult ?? failedResult;

    return {
      state: runResult.state,
      bodyResults,
      ...(lastResult === undefined ? {} : { lastResult }),
      ...(runResult.state === "completed"
        ? {}
        : {
            error:
              failedResult?.error ??
              `scoped loop body ended in state "${runResult.state}"`,
          }),
    };
  }

  private dispatchNode(
    node: PipelineNode,
    frame: RunFrame
  ): Promise<StandardNodeOutcome> {
    const { runId, runState, nodeResults, completedNodeIds } = frame;
    // Compute the canonical key ONCE per dispatch (N3b): the same value is
    // exposed to the node via context and recorded on completion. Recomputing
    // at record time would risk drift if the node mutated state, so the
    // precomputed key is threaded into `onCompleted`.
    const idempotencyKey = this.keyFor(runId, node);
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
      idempotencyKey,
      onCompleted: () => {
        frame.nodeIdempotencyKeys[node.id] = idempotencyKey;
      },
      startTime: frame.startTime,
      saveCheckpoint: () => this.saveCheckpoint(frame),
      ...(this.checkpointOverride === undefined
        ? {}
        : {
            saveErrorEdgeCheckpoint: (nextNodeId: string) =>
              this.checkpointOverride!(frame, nextNodeId),
          }),
    });
  }

  // ---------------------------------------------------------------------------
  // Suspend handling
  // ---------------------------------------------------------------------------

  async handleSuspend(
    nodeId: string,
    frame: RunFrame
  ): Promise<PipelineRunResult> {
    this.coordinator.setState("suspended");
    this.emit(pipelineSuspendedEvent(nodeId));

    if (this.config.checkpointStore) {
      await writeCheckpoint({
        config: this.config,
        runId: frame.runId,
        runState: frame.runState,
        nodeResults: frame.nodeResults,
        completedNodeIds: frame.completedNodeIds,
        nodeIdempotencyKeys: frame.nodeIdempotencyKeys,
        loopState: frame.loopState,
        forkState: frame.forkState,
        eventLog: frame.eventLog,
        versionTracker: frame.versionTracker,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
        budgetTracker: this.coordinator.getBudgetTracker(),
        suspendedAtNodeId: nodeId,
        emit: this.emit.bind(this),
      });
    }

    return this.runResult(
      frame.runId,
      "suspended",
      frame.nodeResults,
      Date.now() - frame.startTime
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
    runState: Record<string, unknown>
  ): string | undefined {
    return getNextNodeIds(
      nodeId,
      this.outgoingEdges,
      this.config.predicates,
      runState
    )[0];
  }

  private errorEdgeFor(nodeId: string, error: unknown): string | undefined {
    return getErrorTarget(nodeId, this.errorEdges, extractErrorCode(error));
  }

  private runResult(
    runId: string,
    state: PipelineState,
    nodeResults: Map<string, NodeResult>,
    totalDurationMs: number
  ): PipelineRunResult {
    return {
      pipelineId: this.config.definition.id,
      runId,
      state,
      nodeResults,
      totalDurationMs,
    };
  }

  private async saveCheckpoint(frame: RunFrame): Promise<void> {
    if (this.checkpointOverride !== undefined) {
      await this.checkpointOverride(frame);
      return;
    }
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
      await writeCheckpoint({
        config: this.config,
        runId: frame.runId,
        runState: frame.runState,
        nodeResults: frame.nodeResults,
        completedNodeIds: frame.completedNodeIds,
        nodeIdempotencyKeys: frame.nodeIdempotencyKeys,
        loopState: frame.loopState,
        forkState: frame.forkState,
        eventLog: frame.eventLog,
        versionTracker: frame.versionTracker,
        recoveryAttemptsUsed: this.coordinator.getRecoveryAttemptsUsed(),
        budgetTracker: this.coordinator.getBudgetTracker(),
        emit: this.emit.bind(this),
      });
    }
  }

  /**
   * Record the stable idempotency key for a completed node. Idempotent itself:
   * the key is deterministic for `(runId, node)`, so re-recording is a no-op.
   */
  private recordIdempotencyKey(
    keys: Record<string, string>,
    runId: string,
    node: PipelineNode
  ): void {
    keys[node.id] = this.keyFor(runId, node);
  }

  /**
   * Build the canonical idempotency key for a node in this run (N3b). Threads
   * the real flow fingerprint (`sourceHash` = canonical digest of the compiled
   * flow definition), the node's attempt policy, and the node's static input so
   * keys change across flow versions and distinct node inputs — not just per
   * `(runId, nodeId)`. Deterministic, so it is safe to call at both dispatch
   * and record time for the same node.
   */
  private keyFor(runId: string, node: PipelineNode): string {
    return nodeIdempotencyKey(runId, node.id, {
      flowDefinition: this.config.definition,
      ...nodeIdempotencyContext(node),
    });
  }

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event);
  }
}

function edgeTargets(edge: PipelineEdge): string[] {
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}

function nextScopedNodeId(
  frame: RunFrame,
  nodes: readonly PipelineNode[],
  outgoingEdges: Map<string, PipelineEdge[]>,
  predicates: PipelineRuntimeConfig["predicates"],
  entryNodeId: string
): string | undefined {
  const midFlightForkId = Object.keys(frame.forkState)[0];
  if (midFlightForkId !== undefined) {
    return nodes.find(
      (node) => node.type === "fork" && node.forkId === midFlightForkId
    )?.id;
  }
  const lastCompletedNodeId = frame.completedNodeIds.at(-1);
  if (lastCompletedNodeId === undefined) return entryNodeId;
  return getNextNodeIds(
    lastCompletedNodeId,
    outgoingEdges,
    predicates,
    frame.runState
  )[0];
}

function bodyResultsFor(
  completedNodeIds: readonly string[],
  nodeResults: ReadonlyMap<string, NodeResult>,
  bodyIds: ReadonlySet<string>,
  priorBodyResults: ReadonlyMap<string, NodeResult>
): Map<string, NodeResult> {
  const results = new Map<string, NodeResult>();
  const completed = new Set(completedNodeIds);
  for (const nodeId of bodyIds) {
    const result = nodeResults.get(nodeId);
    if (
      result !== undefined &&
      (completed.has(nodeId) || result !== priorBodyResults.get(nodeId))
    ) {
      results.set(nodeId, result);
    }
  }
  return results;
}

function lastCompletedResult(
  completedNodeIds: readonly string[],
  nodeResults: ReadonlyMap<string, NodeResult>
): NodeResult | undefined {
  for (let index = completedNodeIds.length - 1; index >= 0; index -= 1) {
    const nodeId = completedNodeIds[index];
    if (nodeId === undefined) continue;
    const result = nodeResults.get(nodeId);
    if (result !== undefined) return result;
  }
  return undefined;
}

function checkpointBodyResults(
  results: ReadonlyMap<string, NodeResult>,
  includeProviderSessionRefs: boolean
): Record<string, NodeResult> {
  return Object.fromEntries(
    [...results].map(([nodeId, result]) => [
      nodeId,
      {
        nodeId: result.nodeId,
        output: result.output,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.errorMetadata === undefined
          ? {}
          : { errorMetadata: result.errorMetadata }),
        ...(includeProviderSessionRefs &&
        result.providerSessionRefs !== undefined
          ? { providerSessionRefs: result.providerSessionRefs }
          : {}),
      },
    ])
  );
}
