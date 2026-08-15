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

import {
  PipelineCheckpointSchema,
  type PipelineNode,
  type PipelineEdge,
  type PipelineCheckpoint,
  type PipelineCheckpointProviderSessionRef,
} from "@dzupagent/core/pipeline";
import type { PipelineInteractionResumeV1 } from "@dzupagent/runtime-contracts";
import { validatePipeline } from "./pipeline-validator.js";
import type {
  PipelineState,
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  PipelineExecuteOptions,
  ForkRuntimeState,
  PipelineRunContext,
} from "./pipeline-runtime-types.js";
import { resolvePipelineRunId } from "./pipeline-runtime-lifecycle/run-id-resolution.js";
import {
  pipelineStartedEvent,
  pipelineCompletedEvent,
  pipelineFailedEvent,
} from "./pipeline-runtime/runtime-events.js";
import { getNextNodeIds } from "./pipeline-runtime/edge-resolution.js";
import {
  createBudgetTrackerState,
  restoreBudgetTrackerState,
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
import type { LoopState } from "./pipeline-runtime/executor-state-types.js";
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
import { writeCheckpoint } from "./pipeline-runtime/checkpoint-writer.js";
import {
  assertInteractionResumeCursorValid,
  resumePipelineInteraction,
  type InteractionResumeHost,
} from "./pipeline-runtime-lifecycle/interaction-resume.js";
import {
  PipelineInteractionRuntimeError,
} from "./pipeline-interaction-runtime.js";

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
  private readonly interactionResumeHost: InteractionResumeHost;

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
    this.interactionResumeHost = {
      config: this.config,
      nodeMap: this.nodeMap,
      eventLog: this.eventLog,
      assertDefinitionValid: () => this.assertDefinitionValid(),
      getNextNodeIds: (nodeId, runState) =>
        this.getNextNodeIdsForResume(nodeId, runState),
      runFromNode: (ctx) => this.runFromNode(ctx),
      resumeFromCheckpoint: (checkpoint) =>
        resumeFromCheckpoint(this.resumeHost, checkpoint),
      emit: (event) => this.emit(event),
      setState: (state) => { this.state = state; },
      setRecoveryAttemptsUsed: (count) => { this.recoveryAttemptsUsed = count; },
      setBudgetTracker: (state) => { this.budgetTracker = state; },
      getRecoveryAttemptsUsed: () => this.recoveryAttemptsUsed,
      getBudgetTracker: () => this.budgetTracker,
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
      setBudgetCostCents: (costCents) => {
        this.budgetTracker = restoreBudgetTrackerState(
          costCents,
          this.config.iterationBudget?.maxCostCents ?? 0
        );
      },
      emitStarted: (runId) =>
        this.emit(pipelineStartedEvent(this.config.definition.id, runId)),
      emitCompleted: (runId, durationMs) =>
        this.emit(pipelineCompletedEvent(runId, durationMs)),
      emitFailed: (runId, message) =>
        this.emit(pipelineFailedEvent(runId, message)),
      runFromNode: (ctx) => this.runFromNode(ctx),
      finalizeInteractionResume: async (ctx) => {
        await writeCheckpoint({
          config: this.config,
          runId: ctx.runId,
          runState: ctx.runState,
          nodeResults: ctx.nodeResults,
          completedNodeIds: ctx.completedNodeIds,
          nodeIdempotencyKeys: ctx.nodeIdempotencyKeys,
          loopState: ctx.loopState,
          forkState: ctx.forkState,
          eventLog: ctx.eventLog,
          versionTracker: ctx.versionTracker,
          recoveryAttemptsUsed: this.recoveryAttemptsUsed,
          budgetTracker: this.budgetTracker,
          interactionReceipts: ctx.interactionReceipts,
          emit: (event) => this.emit(event),
        });
      },
      assertInteractionResumeCursorValid: (checkpoint) =>
        assertInteractionResumeCursorValid(this.interactionResumeHost, checkpoint),
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
    initialState?: Record<string, unknown>,
    options: PipelineExecuteOptions = {},
  ): Promise<PipelineRunResult> {
    this.assertDefinitionValid();
    this.assertRuntimeToolReadiness();

    const runId = resolvePipelineRunId(options.runId);
    const runState: Record<string, unknown> = { ...initialState };
    const nodeResults = new Map<string, NodeResult>();
    const completedNodeIds: string[] = [];
    const nodeIdempotencyKeys: Record<string, string> = {};
    const loopState: LoopState = {};
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
      interactionReceipts: {},
      startTime,
    });
  }

  /** Resume execution from a checkpoint. */
  async resume(
    checkpoint: PipelineCheckpoint,
    additionalState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    this.assertDefinitionValid();
    const parsed = PipelineCheckpointSchema.safeParse(checkpoint);
    if (!parsed.success) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        `Invalid pipeline checkpoint: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return resumeFromCheckpoint(
      this.resumeHost,
      parsed.data as PipelineCheckpoint,
      additionalState,
    );
  }

  /** Consume one exact checkpoint-bound human interaction receipt. */
  async resumeInteraction(
    checkpoint: PipelineCheckpoint,
    receipt: PipelineInteractionResumeV1,
  ): Promise<PipelineRunResult> {
    return resumePipelineInteraction(this.interactionResumeHost, checkpoint, receipt);
  }

  async recoverAfterProcessRestart(
    pipelineRunId: string,
    additionalState?: Record<string, unknown>
  ): Promise<PipelineRunResult> {
    this.assertDefinitionValid();
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
    this.assertDefinitionValid();
    return redeliverFromCheckpointOrchestrator(
      this.resumeHost,
      checkpoint,
      additionalState
    );
  }

  private findMidFlightLoopNodeId(
    loopState: LoopState,
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

  private assertDefinitionValid(): void {
    const validation = validatePipeline(this.config.definition);
    if (!validation.valid) {
      const messages = validation.errors
        .map((error) => error.message)
        .join("; ");
      throw new Error(`Pipeline validation failed: ${messages}`);
    }
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
