import type { PipelineEdge } from "@dzupagent/core/pipeline";

import { isPipelineCheckpointIntegrityError } from "../pipeline-runtime/checkpoint-integrity-error.js";
import { getNextNodeIds } from "../pipeline-runtime/edge-resolution.js";
import type { RunFrame } from "../pipeline-runtime/stage-dispatch.js";
import type {
  NodeResult,
  PipelineRunResult,
  PipelineRuntimeConfig,
  PipelineState,
} from "../pipeline-runtime-types.js";
import type {
  ScopedGraphBoundary,
  ScopedGraphCheckpointFrame,
  ScopedGraphExecutionInput,
  ScopedGraphExecutionOutcome,
  ScopedGraphExecutionResult,
  ScopedGraphExecutorCoordinator,
  ScopedGraphExecutorDeps,
  ScopedGraphFrameCodec,
} from "./contract.js";
import {
  bodyResultsFor,
  checkpointBodyResults,
  lastCompletedResult,
  nextScopedNodeId,
} from "./execution-state.js";
import { validateScopedGraphCheckpointFrame } from "./validate-scoped-graph-frame.js";

export async function executeScopedGraph<
  TFrame extends ScopedGraphCheckpointFrame,
>(
  deps: ScopedGraphExecutorDeps,
  boundary: ScopedGraphBoundary,
  outerFrame: RunFrame,
  input: ScopedGraphExecutionInput<TFrame>,
  codec: ScopedGraphFrameCodec<TFrame>
): Promise<ScopedGraphExecutionResult<TFrame>> {
  if (deps.config.definition.id !== boundary.sourceDefinitionId) {
    throw new Error(
      `${boundary.displayName}: scoped graph definition binding mismatch`
    );
  }

  const bodyIds = new Set(boundary.nodeIds);
  const nodes = deps.config.definition.nodes.filter((node) =>
    bodyIds.has(node.id)
  );
  if (nodes.length !== bodyIds.size) {
    throw new Error(
      `${boundary.displayName}: graph body references a missing node`
    );
  }
  const edges = deps.config.definition.edges.filter(
    (edge) =>
      bodyIds.has(edge.sourceNodeId) &&
      scopedEdgeTargets(edge).every((targetId) => bodyIds.has(targetId))
  );
  const definition = {
    ...deps.config.definition,
    id: boundary.scopedDefinitionId,
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
  const scopedCoordinator: ScopedGraphExecutorCoordinator = {
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
  const restored =
    input.resumeFrame === undefined ? undefined : codec.decode(input.resumeFrame);
  if (restored !== undefined) {
    validateScopedGraphCheckpointFrame(
      { boundary, nodes, outgoingEdges, errorEdges },
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
  const scopedRunId = input.scopedRunId;

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
          outcome: NonNullable<ScopedGraphCheckpointFrame["outcome"]>;
        }
      | { completed: true }
  ): ScopedGraphCheckpointFrame => {
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
        nodeResults: bodyResults,
        checkpointFrame: codec.encode(restored),
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
      nodeResults: bodyResults,
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
        `${boundary.displayName}: scoped suspension at "${restored.outcome.exitNodeId}" ` +
        `resolved ${resumeTargets.length} resume targets; exactly one is required`;
      return {
        outcome: {
          kind: "error",
          error: detail,
          exitNodeId: restored.outcome.exitNodeId,
        },
        state: "failed",
        nodeResults: bodyResultsFor(
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
        codec.encode(
          checkpointStateFor(
            {
              completedNodeIds,
              nodeResults,
              nodeIdempotencyKeys,
              forkState,
            },
            { nextNodeId: startNodeId }
          )
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
      const checkpointFrame =
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
            : checkpointStateFor(scopedFrame, { nextNodeId });
      await input.onCheckpoint(codec.encode(checkpointFrame));
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
      recursiveForkCompletions: {},
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
      nodeResults: bodyResultsFor(
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

  let outcome: ScopedGraphExecutionOutcome;
  let outcomeState = runResult.state;
  let outcomeError: string | undefined;
  let controlCheckpointState: ScopedGraphCheckpointFrame | undefined;
  if (runResult.state === "completed") {
    const exitNodeId = completedNodeIds.at(-1);
    if (
      exitNodeId !== undefined &&
      boundary.normalExitNodeIds.includes(exitNodeId)
    ) {
      outcome = { kind: "normal", exitNodeId };
    } else {
      outcomeError = `${boundary.displayName}: scoped graph completed outside a declared normal exit${
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
      `${boundary.displayName}: scoped graph ended in state \"${runResult.state}\"`;
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
    nodeResults: bodyResults,
    ...(lastResult === undefined ? {} : { lastResult }),
    ...(outcomeError === undefined ? {} : { error: outcomeError }),
    ...(controlCheckpointState === undefined
      ? {}
      : { checkpointFrame: codec.encode(controlCheckpointState) }),
  };
}

function scopedEdgeTargets(edge: PipelineEdge): string[] {
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}
