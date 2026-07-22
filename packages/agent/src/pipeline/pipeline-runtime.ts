/**
 * Pipeline runtime — lifecycle coordinator for pipeline execution.
 *
 * Owns the public surface (`execute`, `resume`, `cancel`, `getRunState`),
 * maintains per-run lifecycle state (`state`, recovery counter,
 * iteration-budget tracker), validates the definition once on entry,
 * and auto-wires the checkpoint store. Per-node mechanics — graph walk,
 * fork/branch, loops, retries, recovery, stuck-detector — live in
 * `PipelineExecutor` to keep this file focused on lifecycle concerns.
 *
 * @module pipeline/pipeline-runtime
 */

import type {
  PipelineNode,
  PipelineEdge,
  PipelineCheckpoint,
  PipelineCheckpointProviderSessionRef,
} from "@dzupagent/core/pipeline";
import { validatePipeline } from "./pipeline-validator.js";
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  ForkRuntimeState,
  PipelineRunContext,
} from "./pipeline-runtime-types.js";
import { generateRunId } from "./pipeline-runtime/run-id.js";
import {
  pipelineStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
} from "./pipeline-runtime/runtime-events.js";
import { getNextNodeIds } from "./pipeline-runtime/edge-resolution.js";
import {
  createBudgetTrackerState,
  type BudgetTrackerState,
} from "./pipeline-runtime/iteration-budget-tracker.js";
import {
  PipelineExecutor,
  type PipelineExecutorCoordinator,
} from "./pipeline-executor.js";
import {
  formatRuntimeToolReadinessError,
  getRuntimeToolReadiness,
} from "./runtime-tool-handlers.js";
import {
  normalizeRuntimeConfig,
  buildNodeIndex,
} from "./pipeline-runtime-lifecycle/runtime-init.js";
import {
  countReplayNodesFrom,
  findMidFlightForkNodeId,
  findMidFlightLoopNodeId,
  findRestartNodeId,
  type ResumePlannerCtx,
} from "./pipeline-runtime-lifecycle/resume-planner.js";
import {
  resumeFromCheckpoint,
  redeliverFromCheckpoint as redeliverFromCheckpointOrchestrator,
  type ResumeHost,
} from "./pipeline-runtime-lifecycle/resume-orchestrator.js";

// ---------------------------------------------------------------------------
// Pipeline Runtime
// ---------------------------------------------------------------------------

export class PipelineRuntime {
  private readonly config: PipelineRuntimeConfig;
  private readonly nodeMap: Map<string, PipelineNode>;
  private readonly outgoingEdges: Map<string, PipelineEdge[]>;
  private readonly errorEdges: Map<string, PipelineEdge[]>;
  private state: PipelineState = "idle";
  /** Tracks recovery attempts across the entire pipeline run */
  private recoveryAttemptsUsed = 0;
  /**
   * Iteration budget accounting state. Cumulative cost and warning flags
   * are kept on a single object so the standalone tracker helper can
   * mutate them in place, preserving the existing field semantics while
   * making the threshold rules independently testable.
   */
  private budgetTracker: BudgetTrackerState = createBudgetTrackerState();
  private readonly executor: PipelineExecutor;
  private readonly eventLog: PipelineRuntimeEvent[];
  /**
   * Read-only view handed to the resume/recovery graph planners. Built once
   * in the constructor; its `getNextNodeIds` closure delegates back to the
   * runtime's own edge resolution so resume walks stay identical to traversal.
   */
  private readonly resumePlannerCtx: ResumePlannerCtx;
  /**
   * Facade handed to the resume/redeliver orchestrator. Bound once in the
   * constructor to this runtime's state mutations, event emission, executor
   * hand-off, and resume-planner helpers.
   */
  private readonly resumeHost: ResumeHost;

  constructor(config: PipelineRuntimeConfig) {
    const { config: normalized, eventLog } = normalizeRuntimeConfig(config);
    this.config = normalized;
    this.eventLog = eventLog;

    const { nodeMap, outgoingEdges, errorEdges } = buildNodeIndex(
      normalized.definition
    );
    this.nodeMap = nodeMap;
    this.outgoingEdges = outgoingEdges;
    this.errorEdges = errorEdges;

    const coordinator: PipelineExecutorCoordinator = {
      getState: () => this.state,
      setState: (next) => {
        this.state = next;
      },
      getRecoveryAttemptsUsed: () => this.recoveryAttemptsUsed,
      incrementRecoveryAttempts: () => ++this.recoveryAttemptsUsed,
      getBudgetTracker: () => this.budgetTracker,
    };
    this.executor = new PipelineExecutor(
      this.config,
      this.nodeMap,
      this.outgoingEdges,
      this.errorEdges,
      coordinator
    );
    this.resumePlannerCtx = {
      nodeMap: this.nodeMap,
      definition: this.config.definition,
      getNextNodeIds: (nodeId, runState) =>
        this.getNextNodeIdsForResume(nodeId, runState),
    };
    this.resumeHost = {
      config: this.config,
      eventLog: this.eventLog,
      assertRuntimeToolReadiness: () => this.assertRuntimeToolReadiness(),
      setState: (next) => {
        this.state = next;
      },
      setRecoveryAttemptsUsed: (count) => {
        this.recoveryAttemptsUsed = count;
      },
      emitStarted: (runId) =>
        this.emit(pipelineStartedEvent(this.config.definition.id, runId)),
      emitCompleted: (runId, durationMs) =>
        this.emit(pipelineCompletedEvent(runId, durationMs)),
      emitFailed: (runId, message) =>
        this.emit(pipelineFailedEvent(runId, message)),
      runFromNode: (ctx) => this.runFromNode(ctx),
      hasNode: (nodeId) => this.nodeMap.has(nodeId),
      getNextNodeIds: (nodeId, runState) =>
        this.getNextNodeIdsForResume(nodeId, runState),
      findMidFlightLoopNodeId: (loopState, completedNodeIds) =>
        this.findMidFlightLoopNodeId(loopState, completedNodeIds),
      findMidFlightForkNodeId: (forkState) =>
        this.findMidFlightForkNodeId(forkState),
      findRestartNodeId: (completedNodeIds, runState) =>
        this.findRestartNodeId(completedNodeIds, runState),
      countReplayNodesFrom: (startNodeId, runState, completedNodeIds) =>
        this.countReplayNodesFrom(startNodeId, runState, completedNodeIds),
    };
  }

  /** Execute the pipeline from the entry node. */
  async execute(
    initialState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    // Validate first
    const validation = validatePipeline(this.config.definition);
    if (!validation.valid) {
      const messages = validation.errors.map((e) => e.message).join("; ");
      throw new Error(`Pipeline validation failed: ${messages}`);
    }
    this.assertRuntimeToolReadiness();

    const runId = generateRunId();
    const runState: Record<string, unknown> = { ...initialState };
    const nodeResults = new Map<string, NodeResult>();
    const completedNodeIds: string[] = [];
    const nodeIdempotencyKeys: Record<string, string> = {};
    const loopState: Record<string, { iteration: number }> = {};
    const forkState: ForkRuntimeState = {};
    const versionTracker = { version: 0 };

    this.state = "running";
    this.recoveryAttemptsUsed = 0;
    this.budgetTracker = createBudgetTrackerState();
    this.emit(pipelineStartedEvent(this.config.definition.id, runId));

    const startTime = Date.now();

    return this.runFromNode({
      startNodeId: this.config.definition.entryNodeId,
      runId,
      runState,
      nodeResults,
      completedNodeIds,
      nodeIdempotencyKeys,
      loopState,
      forkState,
      eventLog: this.eventLog,
      versionTracker,
      startTime,
    });
  }

  /** Resume execution from a checkpoint. */
  async resume(
    checkpoint: PipelineCheckpoint,
    additionalState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    return resumeFromCheckpoint(this.resumeHost, checkpoint, additionalState);
  }

  async recoverAfterProcessRestart(
    pipelineRunId: string,
    additionalState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    const policy =
      this.config.definition.resume?.onProcessRestart ??
      "resume_from_checkpoint";
    const store = this.config.checkpointStore;
    if (!store) {
      throw new Error(
        `Cannot recover run '${pipelineRunId}': no checkpoint store configured.`
      );
    }

    const checkpoint = await store.load(pipelineRunId);
    if (!checkpoint) {
      throw new Error(
        `Cannot recover run '${pipelineRunId}': no checkpoint found.`
      );
    }

    if (policy === "fail_running") {
      this.state = "failed";
      this.emit(
        pipelineFailedEvent(
          pipelineRunId,
          "Run marked failed after process restart by resume.onProcessRestart=fail_running"
        )
      );
      return {
        pipelineId: this.config.definition.id,
        runId: pipelineRunId,
        state: "failed",
        nodeResults: new Map(),
        totalDurationMs: 0,
      };
    }

    if (policy === "redeliver_running") {
      return this.redeliverFromCheckpoint(checkpoint, additionalState);
    }

    return this.resume(checkpoint, additionalState);
  }

  private async redeliverFromCheckpoint(
    checkpoint: PipelineCheckpoint,
    additionalState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    return redeliverFromCheckpointOrchestrator(
      this.resumeHost,
      checkpoint,
      additionalState
    );
  }

  private findMidFlightLoopNodeId(
    loopState: Record<string, { iteration: number }>,
    completedNodeIds: string[]
  ): string | undefined {
    return findMidFlightLoopNodeId(
      this.resumePlannerCtx,
      loopState,
      completedNodeIds
    );
  }

  private findMidFlightForkNodeId(
    forkState: Record<string, { branches: Record<string, unknown> }>
  ): string | undefined {
    return findMidFlightForkNodeId(this.resumePlannerCtx, forkState);
  }

  private findRestartNodeId(
    completedNodeIds: string[],
    runState: Record<string, unknown>
  ): string | undefined {
    return findRestartNodeId(this.resumePlannerCtx, completedNodeIds, runState);
  }

  private countReplayNodesFrom(
    startNodeId: string,
    runState: Record<string, unknown>,
    completedNodeIds: string[]
  ): number {
    return countReplayNodesFrom(
      this.resumePlannerCtx,
      startNodeId,
      runState,
      completedNodeIds
    );
  }

  /** Cancel execution. */
  cancel(_reason?: string): void {
    this.state = "cancelled";
  }

  /** Get current run state. */
  getRunState(): PipelineState {
    return this.state;
  }

  /**
   * Return provider session handles captured in the latest checkpoint for a run.
   *
   * This gives handoff/resume consumers a stable query surface without requiring
   * them to load or parse raw checkpoint records.
   */
  async getProviderSessionRefs(
    pipelineRunId: string
  ): Promise<PipelineCheckpointProviderSessionRef[]> {
    const checkpoint = await this.config.checkpointStore?.load(pipelineRunId);
    return structuredClone(checkpoint?.providerSessionRefs ?? []);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Shared tail for `execute()` and `resume()`: delegate the graph walk to
   * the executor and translate any thrown error into a failed run result.
   * Centralising this preserves identical lifecycle semantics across both
   * entry points (state transition to `failed`, `pipeline:failed` event,
   * structured `PipelineRunResult`) without duplicating the catch block.
   */
  private async runFromNode(
    args: PipelineRunContext
  ): Promise<PipelineRunResult> {
    try {
      return await this.executor.executeFromNode(args);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.state = "failed";
      this.emit(pipelineFailedEvent(args.runId, errorMessage));
      return {
        pipelineId: this.config.definition.id,
        runId: args.runId,
        state: "failed",
        nodeResults: args.nodeResults,
        totalDurationMs: Date.now() - args.startTime,
      };
    }
  }

  /**
   * Resolve the node(s) immediately after a suspension point. Used by
   * `resume()` to determine where execution should continue without
   * re-running the executor's full traversal loop. Mirrors the
   * traversal-time edge resolution exactly so resume behaviour is
   * indistinguishable from a fresh `execute()` call.
   */
  private getNextNodeIdsForResume(
    nodeId: string,
    runState: Record<string, unknown>
  ): string[] {
    return getNextNodeIds(
      nodeId,
      this.outgoingEdges,
      this.config.predicates,
      runState
    );
  }

  private emit(event: PipelineRuntimeEvent): void {
    this.config.onEvent?.(event);
  }

  private assertRuntimeToolReadiness(): void {
    if (this.config.runtimeToolReadiness !== "fail_fast") return;

    const readiness = getRuntimeToolReadiness(
      this.config.definition,
      this.config.runtimeToolHandlers
    );
    if (!readiness.ready) {
      throw new Error(formatRuntimeToolReadinessError(readiness));
    }
  }
}
