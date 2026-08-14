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
import {
  digestPipelineDefinition,
  validatePipelineInteractionResumeV1,
  type PipelineInteractionResumeV1,
} from "@dzupagent/runtime-contracts";
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
import { generateRunId } from "./pipeline-runtime/run-id.js";
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
  restoreRunContextFromCheckpoint,
  type ResumeHost,
} from "./pipeline-runtime-lifecycle/resume-orchestrator.js";
import { writeCheckpoint } from "./pipeline-runtime/checkpoint-writer.js";
import {
  assertInteractionNotExpired,
  interactionSpecForNode,
  PipelineInteractionRuntimeError,
  validatePendingInteractionForDefinition,
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
        this.assertInteractionResumeCursorValid(checkpoint),
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
    // Validate first
    const validation = validatePipeline(this.config.definition);
    if (!validation.valid) {
      const messages = validation.errors.map((e) => e.message).join("; ");
      throw new Error(`Pipeline validation failed: ${messages}`);
    }
    this.assertRuntimeToolReadiness();

    const runId = resolveRunId(options.runId);
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
    const standalone = validatePipelineInteractionResumeV1(receipt);
    if (!standalone.valid) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        standalone.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
    }

    const store = this.config.checkpointStore;
    const loaded = await store?.load(checkpoint.pipelineRunId);
    if (store !== undefined && loaded === undefined) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The authoritative latest checkpoint is missing or corrupt.",
      );
    }
    const latest = loaded ?? checkpoint;
    if (
      latest.pipelineRunId !== checkpoint.pipelineRunId ||
      latest.pipelineId !== this.config.definition.id
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The latest checkpoint does not belong to this pipeline run.",
      );
    }

    const existing = latest.interactionReceipts?.[receipt.interactionId];
    if (existing !== undefined) {
      if (existing.receiptHash !== receipt.receiptHash) {
        throw new PipelineInteractionRuntimeError(
          "INTERACTION_RECEIPT_CONFLICT",
          `Interaction "${receipt.interactionId}" already has a different committed receipt.`,
        );
      }
      this.assertCommittedInteractionReceiptValid(latest, existing);
      if (latest.interactionResumeCursor !== undefined) {
        this.assertInteractionResumeCursorValid(latest);
        return resumeFromCheckpoint(this.resumeHost, latest);
      }
      if (latest.pendingInteraction !== undefined) {
        return resumeFromCheckpoint(this.resumeHost, latest);
      }
      if (existing.scope.kind === "pipeline") {
        return this.completedInteractionResult(
          latest.pipelineRunId,
          restoreRunContextFromCheckpoint(latest, undefined, {
            hydrateCompleted: true,
          }).nodeResults,
          Date.now(),
        );
      }
      return resumeFromCheckpoint(this.resumeHost, latest);
    }

    for (const committed of Object.values(latest.interactionReceipts ?? {})) {
      if (committed.receiptId === receipt.receiptId) {
        throw new PipelineInteractionRuntimeError(
          "INTERACTION_RECEIPT_CONFLICT",
          `Receipt ID "${receipt.receiptId}" is already bound to another interaction.`,
        );
      }
    }

    const { pending, spec } = validatePendingInteractionForDefinition(
      this.config.definition,
      latest,
    );
    assertInteractionNotExpired(
      pending,
      this.config.interaction?.now?.() ?? new Date(),
    );
    const validation = validatePipelineInteractionResumeV1(receipt, {
      pending,
      spec,
    });
    if (!validation.valid) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
    }

    const restored = restoreRunContextFromCheckpoint(latest, undefined, {
      hydrateCompleted: true,
    });
    const interactionNode = this.nodeMap.get(pending.nodeId);
    if (interactionNode === undefined) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        `Interaction node "${pending.nodeId}" is missing.`,
      );
    }

    const selectedNextNodeId =
      spec.kind === "approval" && receipt.response.kind === "approval"
        ? spec.outcomeToSuccessor[receipt.response.decision]
        : this.exactInteractionSuccessor(pending.nodeId, restored.runState);
    if (
      selectedNextNodeId !== undefined &&
      !this.nodeMap.has(selectedNextNodeId)
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_SUCCESSOR_INVALID",
        `Interaction successor "${selectedNextNodeId}" is missing.`,
      );
    }

    const responseOutput =
      receipt.response.kind === "clarification"
        ? receipt.response.value
        : receipt.response;
    if (spec.kind === "clarification" && receipt.response.kind === "clarification") {
      restored.runState[spec.outputKey] = receipt.response.value;
    }

    if (pending.scope.kind === "pipeline") {
      if (!restored.completedNodeIds.includes(pending.nodeId)) {
        restored.completedNodeIds.push(pending.nodeId);
      }
      restored.nodeResults.set(pending.nodeId, {
        nodeId: pending.nodeId,
        output: responseOutput,
        durationMs: 0,
      });
    } else {
      const loop = restored.loopState[pending.scope.loopNodeId];
      const graph = loop?.bodyGraphState;
      if (
        loop === undefined ||
        graph === undefined ||
        graph.outcome?.kind !== "suspended" ||
        graph.outcome.exitNodeId !== pending.nodeId
      ) {
        throw new PipelineInteractionRuntimeError(
          "INTERACTION_BINDING_MISMATCH",
          "The retained loop graph does not match the interaction receipt.",
        );
      }
      if (!graph.completedNodeIds.includes(pending.nodeId)) {
        graph.completedNodeIds.push(pending.nodeId);
      }
      graph.nodeResults[pending.nodeId] = {
        nodeId: pending.nodeId,
        output: responseOutput,
        durationMs: 0,
      };
      if (selectedNextNodeId === undefined) {
        graph.completed = true;
        delete graph.nextNodeId;
        graph.outcome = { kind: "normal", exitNodeId: pending.nodeId };
      } else {
        graph.completed = false;
        graph.nextNodeId = selectedNextNodeId;
        delete graph.outcome;
      }
    }

    restored.interactionReceipts[receipt.interactionId] = receipt;
    const cursor = {
      interactionId: receipt.interactionId,
      receiptHash: receipt.receiptHash,
      definitionDigest: receipt.definitionDigest,
      nodeId: receipt.nodeId,
      scope: receipt.scope,
      ...(selectedNextNodeId === undefined
        ? {}
        : { selectedSuccessorNodeId: selectedNextNodeId }),
      ...(pending.scope.kind === "pipeline"
        ? selectedNextNodeId === undefined
          ? {}
          : { nextNodeId: selectedNextNodeId }
        : { nextNodeId: pending.scope.loopNodeId }),
    } as const;
    delete restored.pendingInteraction;
    restored.interactionResumeCursor = cursor;
    const versionTracker = { version: latest.version };
    const committed = await writeCheckpoint({
      config: this.config,
      runId: restored.runId,
      runState: restored.runState,
      nodeResults: restored.nodeResults,
      completedNodeIds: restored.completedNodeIds,
      nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
      loopState: restored.loopState,
      forkState: restored.forkState,
      eventLog: this.eventLog,
      versionTracker,
      recoveryAttemptsUsed: latest.recoveryAttemptsUsed ?? 0,
      budgetTracker: restoreBudgetTrackerState(
        latest.budgetState?.costCents ?? 0,
        this.config.iterationBudget?.maxCostCents ?? 0,
      ),
      interactionReceipts: restored.interactionReceipts,
      interactionResumeCursor: cursor,
      emit: (event) => this.emit(event),
    });
    if (committed === undefined) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "Interaction receipt could not be committed without a checkpoint store.",
      );
    }
    this.state = "running";
    this.recoveryAttemptsUsed = committed.recoveryAttemptsUsed ?? 0;
    this.budgetTracker = restoreBudgetTrackerState(
      committed.budgetState?.costCents ?? 0,
      this.config.iterationBudget?.maxCostCents ?? 0,
    );
    this.emit(pipelineStartedEvent(this.config.definition.id, restored.runId));
    const startTime = Date.now();
    const result = cursor.nextNodeId === undefined
      ? this.completedInteractionResult(
          restored.runId,
          restored.nodeResults,
          startTime,
        )
      : await this.runFromNode({
          startNodeId: cursor.nextNodeId,
          runId: restored.runId,
          runState: restored.runState,
          nodeResults: restored.nodeResults,
          completedNodeIds: restored.completedNodeIds,
          nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
          loopState: restored.loopState,
          forkState: restored.forkState,
          eventLog: this.eventLog,
          versionTracker,
          interactionReceipts: restored.interactionReceipts,
          interactionResumeCursor: cursor,
          startTime,
        });
    if (result.state === "completed") {
      restored.interactionResumeCursor = undefined;
      await writeCheckpoint({
        config: this.config,
        runId: restored.runId,
        runState: restored.runState,
        nodeResults: restored.nodeResults,
        completedNodeIds: restored.completedNodeIds,
        nodeIdempotencyKeys: restored.nodeIdempotencyKeys,
        loopState: restored.loopState,
        forkState: restored.forkState,
        eventLog: this.eventLog,
        versionTracker,
        recoveryAttemptsUsed: this.recoveryAttemptsUsed,
        budgetTracker: this.budgetTracker,
        interactionReceipts: restored.interactionReceipts,
        emit: (event) => this.emit(event),
      });
    }
    return result;
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

  private exactInteractionSuccessor(
    nodeId: string,
    runState: Record<string, unknown>,
  ): string | undefined {
    const targets = this.getNextNodeIdsForResume(nodeId, runState);
    if (targets.length > 1) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_SUCCESSOR_INVALID",
        `Interaction node "${nodeId}" resolved ${targets.length} successors; at most one is allowed.`,
      );
    }
    return targets[0];
  }

  private assertCommittedInteractionReceiptValid(
    checkpoint: PipelineCheckpoint,
    receipt: PipelineInteractionResumeV1,
  ): void {
    const validation = validatePipelineInteractionResumeV1(receipt);
    const node = this.nodeMap.get(receipt.nodeId);
    const spec = interactionSpecForNode(node);
    if (
      !validation.valid ||
      receipt.pipelineId !== this.config.definition.id ||
      receipt.runId !== checkpoint.pipelineRunId ||
      receipt.definitionDigest !== digestPipelineDefinition(this.config.definition) ||
      spec === undefined ||
      spec.kind !== receipt.response.kind ||
      spec.requestDigest !== receipt.requestDigest
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The committed interaction receipt no longer matches the exact pipeline artifact.",
      );
    }
  }

  private assertInteractionResumeCursorValid(
    checkpoint: PipelineCheckpoint,
  ): void {
    const cursor = checkpoint.interactionResumeCursor;
    if (cursor === undefined) return;
    const receipt = checkpoint.interactionReceipts?.[cursor.interactionId];
    if (receipt === undefined) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The interaction resume cursor has no committed receipt.",
      );
    }
    this.assertCommittedInteractionReceiptValid(checkpoint, receipt);
    const spec = interactionSpecForNode(this.nodeMap.get(receipt.nodeId));
    if (spec === undefined) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The interaction resume cursor references a non-interaction node.",
      );
    }
    const selectedSuccessorNodeId =
      spec.kind === "approval" && receipt.response.kind === "approval"
        ? spec.outcomeToSuccessor[receipt.response.decision]
        : this.exactInteractionSuccessor(receipt.nodeId, checkpoint.state);
    const expectedNextNodeId = receipt.scope.kind === "pipeline"
      ? selectedSuccessorNodeId
      : receipt.scope.loopNodeId;
    let exactLoopCursor = true;
    if (receipt.scope.kind === "loop") {
      const loop = checkpoint.loopState?.[receipt.scope.loopNodeId];
      const graph = loop?.bodyGraphState;
      exactLoopCursor =
        loop?.iteration === receipt.scope.iteration &&
        graph !== undefined &&
        (selectedSuccessorNodeId === undefined
          ? graph.completed &&
            graph.outcome?.kind === "normal" &&
            graph.outcome.exitNodeId === receipt.nodeId
          : graph.completedNodeIds.includes(selectedSuccessorNodeId) ||
            (!graph.completed &&
              graph.outcome === undefined &&
              graph.nextNodeId === selectedSuccessorNodeId));
    }
    if (
      cursor.receiptHash !== receipt.receiptHash ||
      cursor.definitionDigest !== receipt.definitionDigest ||
      cursor.nodeId !== receipt.nodeId ||
      JSON.stringify(cursor.scope) !== JSON.stringify(receipt.scope) ||
      cursor.selectedSuccessorNodeId !== selectedSuccessorNodeId ||
      cursor.nextNodeId !== expectedNextNodeId ||
      !exactLoopCursor ||
      (selectedSuccessorNodeId !== undefined &&
        !this.nodeMap.has(selectedSuccessorNodeId)) ||
      (expectedNextNodeId !== undefined && !this.nodeMap.has(expectedNextNodeId))
    ) {
      throw new PipelineInteractionRuntimeError(
        "INTERACTION_BINDING_MISMATCH",
        "The interaction resume cursor does not match its receipt, artifact, and exact successor.",
      );
    }
  }

  private completedInteractionResult(
    runId: string,
    nodeResults: Map<string, NodeResult>,
    startTime: number,
  ): PipelineRunResult {
    this.state = "completed";
    const durationMs = Date.now() - startTime;
    this.emit(pipelineCompletedEvent(runId, durationMs));
    return {
      pipelineId: this.config.definition.id,
      runId,
      state: "completed",
      nodeResults,
      totalDurationMs: durationMs,
    };
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

function resolveRunId(injected: string | undefined): string {
  if (injected === undefined) return generateRunId();
  if (
    injected.length < 1 ||
    injected.length > 200 ||
    injected.trim() !== injected ||
    /[\u0000-\u001f\u007f]/.test(injected)
  ) {
    throw new TypeError(
      "Pipeline runId must be a non-empty, trimmed identifier of at most 200 characters without control characters.",
    );
  }
  return injected;
}
