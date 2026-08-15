import type { LoopNode, PipelineEdge, PipelineNode } from "@dzupagent/core/pipeline";

import { isPipelineCheckpointIntegrityError } from "../../pipeline-runtime/checkpoint-integrity-error.js";
import { getNextNodeIds } from "../../pipeline-runtime/edge-resolution.js";
import type { BudgetTrackerState } from "../../pipeline-runtime/iteration-budget-tracker.js";
import type { RunFrame } from "../../pipeline-runtime/stage-dispatch.js";
import type { NodeResult, PipelineRunResult, PipelineRuntimeConfig, PipelineState } from "../../pipeline-runtime-types.js";
import { validateLoopBodyGraphCheckpointState } from "../../loop-body-graph-checkpoint-validator.js";
import type { LoopBodyGraphCheckpointState, LoopBodyGraphScheduleInput, LoopBodyGraphScheduleOutcome, LoopBodyGraphScheduleResult } from "../types.js";
import { projectLoopBodyContainmentTargets } from "../edge-target-projections.js";
import { bodyResultsFor, checkpointBodyResults, lastCompletedResult, nextScopedNodeId } from "./schedule-state.js";

export interface LoopBodyGraphSchedulerDeps {
  readonly config: PipelineRuntimeConfig;
  readonly coordinator: ScopedPipelineExecutorCoordinator;
  readonly Executor: ScopedPipelineExecutorConstructor;
}

interface ScopedPipelineExecutorCoordinator {
  getState(): PipelineState;
  setState(next: PipelineState): void;
  getRecoveryAttemptsUsed(): number;
  incrementRecoveryAttempts(): number;
  getBudgetTracker(): BudgetTrackerState;
}

interface ScopedPipelineExecutorConstructor {
  new (
    config: PipelineRuntimeConfig,
    nodeMap: Map<string, PipelineNode>,
    outgoingEdges: Map<string, PipelineEdge[]>,
    errorEdges: Map<string, PipelineEdge[]>,
    coordinator: ScopedPipelineExecutorCoordinator,
    checkpointOverride?: (
      frame: RunFrame,
      selectedNextNodeId?: string,
    ) => Promise<void>,
  ): {
    executeFromNode(
      input: RunFrame & { startNodeId: string },
    ): Promise<PipelineRunResult>;
  };
}

export async function scheduleLoopBodyGraph(
deps: LoopBodyGraphSchedulerDeps,
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
  const nodes = deps.config.definition.nodes.filter((node) =>
    bodyIds.has(node.id)
  );
  if (nodes.length !== bodyIds.size) {
    throw new Error(
      `Loop node "${loopNode.id}": graph body references a missing node`
    );
  }
  const edges = deps.config.definition.edges.filter(
    (edge) =>
      bodyIds.has(edge.sourceNodeId) &&
      projectLoopBodyContainmentTargets(edge).every((targetId) => bodyIds.has(targetId))
  );
  const definition = {
    ...deps.config.definition,
    id: `${deps.config.definition.id}::loop-body:${loopNode.id}`,
    entryNodeId: boundary.entryNodeId,
    nodes,
    edges,
    checkpointStrategy: "after_each_node" as const,
  };

  // Suppress scoped lifecycle events; node/fork/loop events remain visible
  // on the owning run, while the outer loop emits the one authoritative
  // pipeline-level terminal event.
  const onEvent = deps.config.onEvent;
  let suspendedAtNodeId: string | undefined;
  const config: PipelineRuntimeConfig = {
    ...deps.config,
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
      if (event.type === "pipeline:suspended") {
        suspendedAtNodeId = event.nodeId;
      }
      if (
        event.type !== "pipeline:completed" &&
        event.type !== "pipeline:failed" &&
        event.type !== "pipeline:suspended"
      ) {
        onEvent?.(event);
      }
    },
  };
  // A scoped body must never write a private pipeline checkpoint. Standard
  // node/fork progress is projected through `checkpointOverride`; control
  // outcomes are returned to the owning loop and written atomically with its
  // outer suspension/terminal marker.
  delete config.checkpointStore;

  let state: PipelineState = "running";
  const scopedCoordinator: ScopedPipelineExecutorCoordinator = {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    getRecoveryAttemptsUsed: () =>
      deps.coordinator.getRecoveryAttemptsUsed(),
    incrementRecoveryAttempts: () =>
      deps.coordinator.incrementRecoveryAttempts(),
    getBudgetTracker: () => deps.coordinator.getBudgetTracker(),
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

  const checkpointStateFor = (
    scopedFrame: Pick<
      RunFrame,
      | "completedNodeIds"
      | "nodeResults"
      | "nodeIdempotencyKeys"
      | "forkState"
    >,
    options:
      | { nextNodeId: string }
      | {
          outcome: NonNullable<LoopBodyGraphCheckpointState["outcome"]>;
        }
      | { completed: true }
  ): LoopBodyGraphCheckpointState => {
    const checkpointResults = bodyResultsFor(
      scopedFrame.completedNodeIds,
      scopedFrame.nodeResults,
      bodyIds,
      priorBodyResults
    );
    const outcome = "outcome" in options ? options.outcome : undefined;
    const completed =
      "completed" in options ||
      outcome?.kind === "normal" ||
      outcome?.kind === "terminal";
    return {
      completed,
      ...(outcome === undefined ? {} : { outcome }),
      ...(outcome === undefined && "nextNodeId" in options
        ? { nextNodeId: options.nextNodeId }
        : {}),
      completedNodeIds: [...scopedFrame.completedNodeIds],
      nodeResults: checkpointBodyResults(
        checkpointResults,
        config.definition.checkpoint?.includeProviderSessionRefs === true
      ),
      nodeIdempotencyKeys: { ...scopedFrame.nodeIdempotencyKeys },
      ...(Object.keys(scopedFrame.forkState).length === 0
        ? {}
        : { forkState: structuredClone(scopedFrame.forkState) }),
    };
  };

  if (restored?.completed === true) {
    const bodyResults = bodyResultsFor(
      completedNodeIds,
      nodeResults,
      bodyIds,
      priorBodyResults
    );
    const lastResult = lastCompletedResult(completedNodeIds, nodeResults);
    const retainedOutcome = restored.outcome;
    if (retainedOutcome?.kind === "terminal") {
      const terminalNode = nodeMap.get(retainedOutcome.exitNodeId);
      return {
        outcome: retainedOutcome,
        state: "suspended",
        bodyResults,
        checkpointState: restored,
        lastResult: {
          nodeId: retainedOutcome.exitNodeId,
          output: terminalNode?.description ?? null,
          durationMs: 0,
        },
      };
    }
    const exitNodeId =
      retainedOutcome?.kind === "normal"
        ? retainedOutcome.exitNodeId
        : completedNodeIds.at(-1)!;
    return {
      outcome: { kind: "normal", exitNodeId },
      state: "completed",
      bodyResults,
      ...(lastResult === undefined ? {} : { lastResult }),
    };
  }

  let startNodeId: string;
  if (restored?.outcome?.kind === "suspended") {
    const resumeTargets = getNextNodeIds(
      restored.outcome.exitNodeId,
      outgoingEdges,
      config.predicates,
      input.context.state
    );
    if (resumeTargets.length !== 1) {
      const detail =
        `scoped loop suspension at "${restored.outcome.exitNodeId}" ` +
        `resolved ${resumeTargets.length} resume targets; exactly one is required`;
      return {
        outcome: {
          kind: "error",
          error: detail,
          exitNodeId: restored.outcome.exitNodeId,
        },
        state: "failed",
        bodyResults: bodyResultsFor(
          completedNodeIds,
          nodeResults,
          bodyIds,
          priorBodyResults
        ),
        error: detail,
      };
    }
    startNodeId = resumeTargets[0]!;
    // Consuming the outer resume signal completes the scoped control node.
    // Retain that transition before dispatching its successor so an
    // acknowledgement-lost checkpoint still has a definition-valid cursor.
    completedNodeIds.push(restored.outcome.exitNodeId);
    nodeResults.set(restored.outcome.exitNodeId, {
      nodeId: restored.outcome.exitNodeId,
      output: null,
      durationMs: 0,
    });
    if (input.onCheckpoint !== undefined) {
      await input.onCheckpoint(
        checkpointStateFor(
          {
            completedNodeIds,
            nodeResults,
            nodeIdempotencyKeys,
            forkState,
          },
          { nextNodeId: startNodeId }
        ),
        { mandatory: true }
      );
    }
  } else {
    startNodeId = restored?.nextNodeId ?? boundary.entryNodeId;
  }

  const scopedExecutor = new deps.Executor(
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
      const completedExitNodeId = scopedFrame.completedNodeIds.at(-1);
      await input.onCheckpoint(
        nextNodeId === undefined &&
          completedExitNodeId !== undefined &&
          boundary.normalExitNodeIds.includes(completedExitNodeId)
          ? checkpointStateFor(scopedFrame, {
              outcome: {
                kind: "normal",
                exitNodeId: completedExitNodeId,
              },
            })
          : nextNodeId === undefined
            ? checkpointStateFor(scopedFrame, { completed: true })
            : checkpointStateFor(scopedFrame, { nextNodeId })
      );
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
      interactionReceipts: outerFrame.interactionReceipts,
      startTime: Date.now(),
    });
  } catch (error) {
    if (isPipelineCheckpointIntegrityError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      outcome: { kind: "error", error: detail },
      state: "failed",
      bodyResults: bodyResultsFor(
        completedNodeIds,
        nodeResults,
        bodyIds,
        priorBodyResults
      ),
      error: detail,
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
  let lastResult = completedResult ?? failedResult;

  let outcome: LoopBodyGraphScheduleOutcome;
  let outcomeState = runResult.state;
  let outcomeError: string | undefined;
  let controlCheckpointState: LoopBodyGraphCheckpointState | undefined;
  if (runResult.state === "completed") {
    const exitNodeId = completedNodeIds.at(-1);
    if (
      exitNodeId !== undefined &&
      boundary.normalExitNodeIds.includes(exitNodeId)
    ) {
      outcome = { kind: "normal", exitNodeId };
    } else {
      outcomeError = `scoped loop body completed outside a declared normal exit${
        exitNodeId === undefined ? "" : `: \"${exitNodeId}\"`
      }`;
      outcome = { kind: "error", error: outcomeError };
      outcomeState = "failed";
    }
  } else if (runResult.state === "cancelled") {
    outcome = { kind: "cancelled" };
  } else if (
    runResult.state === "suspended" &&
    suspendedAtNodeId !== undefined &&
    boundary.terminalExitNodeIds.includes(suspendedAtNodeId)
  ) {
    outcome = { kind: "terminal", exitNodeId: suspendedAtNodeId };
    controlCheckpointState = checkpointStateFor(
      {
        completedNodeIds,
        nodeResults: runResult.nodeResults,
        nodeIdempotencyKeys,
        forkState,
      },
      { outcome }
    );
    const terminalNode = nodeMap.get(suspendedAtNodeId);
    lastResult = {
      nodeId: suspendedAtNodeId,
      output: terminalNode?.description ?? null,
      durationMs: 0,
    };
  } else if (
    runResult.state === "suspended" &&
    suspendedAtNodeId !== undefined &&
    (
      boundary.suspendedExitNodeIds.includes(suspendedAtNodeId) ||
      boundary.suspensionSiteNodeIds?.includes(suspendedAtNodeId) === true
    )
  ) {
    outcome = { kind: "suspended", exitNodeId: suspendedAtNodeId };
    controlCheckpointState = checkpointStateFor(
      {
        completedNodeIds,
        nodeResults: runResult.nodeResults,
        nodeIdempotencyKeys,
        forkState,
      },
      { outcome }
    );
  } else {
    outcomeError =
      failedResult?.error ??
      `scoped loop body ended in state \"${runResult.state}\"`;
    outcome = {
      kind: "error",
      error: outcomeError,
      ...(failedResult === undefined
        ? {}
        : { exitNodeId: failedResult.nodeId }),
    };
  }

  return {
    outcome,
    state: outcomeState,
    bodyResults,
    ...(lastResult === undefined ? {} : { lastResult }),
    ...(outcomeError === undefined ? {} : { error: outcomeError }),
    ...(controlCheckpointState === undefined
      ? {}
      : { checkpointState: controlCheckpointState }),
  };
}
