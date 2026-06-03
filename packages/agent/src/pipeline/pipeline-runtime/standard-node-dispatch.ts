/**
 * Dispatch a single non-special pipeline node: execute it (with retry),
 * route success/failure through the configured stuck detector,
 * trajectory calibrator, iteration budget, error edges, and recovery
 * copilot. Returns a control-flow outcome the executor can act on
 * without knowing the inner side-effect details.
 *
 * @module pipeline/pipeline-runtime/standard-node-dispatch
 */

import type { PipelineNode, PipelineEdge } from "@dzupagent/core/pipeline";
import type {
  NodeResult,
  PipelineRunResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  PipelineState,
} from "../pipeline-runtime-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  pipelineFailedEvent,
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
} from "./runtime-events.js";
import { getNextNodeIds, getErrorTarget } from "./edge-resolution.js";
import { extractErrorCode } from "./error-classification.js";
import { runNodeWithRetry } from "./node-retry.js";
import {
  recordFailureInStuckDetector,
  recordSuccessInStuckDetector,
  recordCalibration,
  recordIterationBudget,
  attemptRecovery,
  type RecoveryCounter,
} from "./node-side-effects.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";

export type StandardNodeOutcome =
  | { kind: "continue"; nextNodeId: string | undefined }
  | { kind: "return"; value: PipelineRunResult }
  | { kind: "rethrow"; error: unknown };

export interface StandardNodeDispatchInput {
  config: PipelineRuntimeConfig;
  outgoingEdges: Map<string, PipelineEdge[]>;
  errorEdges: Map<string, PipelineEdge[]>;
  emit: (event: PipelineRuntimeEvent) => void;
  recoveryCounter: RecoveryCounter;
  budgetTracker: BudgetTrackerState;
  setState: (next: PipelineState) => void;
  pipelineId: string;
  node: PipelineNode;
  runId: string;
  runState: Record<string, unknown>;
  nodeResults: Map<string, NodeResult>;
  completedNodeIds: string[];
  /** Stable idempotency key for this node, exposed to the node via context (W5). */
  idempotencyKey?: string;
  /** Invoked once the node has completed successfully, before checkpointing. */
  onCompleted?: () => void;
  startTime: number;
  saveCheckpoint: () => Promise<void>;
}

export async function dispatchStandardNode(
  input: StandardNodeDispatchInput
): Promise<StandardNodeOutcome> {
  const {
    config,
    outgoingEdges,
    errorEdges,
    emit,
    recoveryCounter,
    budgetTracker,
    setState,
    pipelineId,
    node,
    runId,
    runState,
    nodeResults,
    completedNodeIds,
    idempotencyKey,
    onCompleted,
    startTime,
    saveCheckpoint,
  } = input;

  emit(nodeStartedEvent(node.id, node.type));

  const span = config.tracer?.startPhaseSpan(node.id, {
    attributes: {
      "forge.pipeline.node_type": node.type,
      "forge.pipeline.phase": node.id,
    },
  });

  const context: NodeExecutionContext = omitUndefined({
    state: runState,
    previousResults: nodeResults,
    signal: config.signal,
    idempotencyKey,
  });

  const fail = (error: string): StandardNodeOutcome => {
    setState("failed");
    emit(pipelineFailedEvent(runId, error));
    return {
      kind: "return",
      value: {
        pipelineId,
        runId,
        state: "failed",
        nodeResults,
        totalDurationMs: Date.now() - startTime,
      },
    };
  };

  try {
    const finalResult = await runNodeWithRetry(config, emit, node, context);

    if (finalResult.error) {
      if (span) config.tracer?.endSpanWithError(span, finalResult.error);
      emit(nodeFailedEvent(node.id, finalResult.error));
      nodeResults.set(node.id, finalResult);

      const stuckAbort = recordFailureInStuckDetector(
        config,
        emit,
        node.id,
        finalResult.error,
        context
      );
      if (stuckAbort) return fail(stuckAbort);

      const errorNext = getErrorTarget(
        node.id,
        errorEdges,
        extractErrorCode(finalResult.error)
      );
      if (errorNext) return { kind: "continue", nextNodeId: errorNext };

      const recovered = await attemptRecovery(
        config,
        emit,
        recoveryCounter,
        node.id,
        node.type,
        finalResult.error,
        runId
      );
      if (recovered) {
        nodeResults.delete(node.id);
        return { kind: "continue", nextNodeId: node.id };
      }

      return fail(finalResult.error);
    }

    if (span) config.tracer?.endSpanOk(span);

    emit(nodeCompletedEvent(node.id, finalResult.durationMs));
    nodeResults.set(node.id, finalResult);

    const stuckAbort = recordSuccessInStuckDetector(
      config,
      emit,
      node.id,
      finalResult,
      context
    );
    if (stuckAbort) return fail(stuckAbort);

    await recordCalibration(config, emit, node.id, finalResult, runId);
    recordIterationBudget(
      config,
      emit,
      budgetTracker,
      node.id,
      finalResult,
      completedNodeIds.length
    );

    completedNodeIds.push(node.id);
    onCompleted?.();
    await saveCheckpoint();

    const nextIds = getNextNodeIds(
      node.id,
      outgoingEdges,
      config.predicates,
      runState
    );
    return { kind: "continue", nextNodeId: nextIds[0] };
  } catch (err) {
    if (span) config.tracer?.endSpanWithError(span, err);

    const errorMessage = err instanceof Error ? err.message : String(err);
    emit(nodeFailedEvent(node.id, errorMessage));
    nodeResults.set(node.id, {
      nodeId: node.id,
      output: null,
      durationMs: 0,
      error: errorMessage,
    });

    const errorNext = getErrorTarget(
      node.id,
      errorEdges,
      extractErrorCode(err)
    );
    if (errorNext) return { kind: "continue", nextNodeId: errorNext };

    const recovered = await attemptRecovery(
      config,
      emit,
      recoveryCounter,
      node.id,
      node.type,
      errorMessage,
      runId
    );
    if (recovered) {
      nodeResults.delete(node.id);
      return { kind: "continue", nextNodeId: node.id };
    }

    return { kind: "rethrow", error: err };
  }
}
