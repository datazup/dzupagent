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
import { defaultLogger } from "@dzupagent/core/utils";
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
import {
  beginNodeUnderLedger,
  completeNodeUnderLedger,
  failNodeUnderLedger,
  startNodeHeartbeat,
  type BeginNodeOutcome,
  type HeartbeatHandle,
} from "./node-ledger-integration.js";
import type { NodeLeaseLike } from "../pipeline-runtime-types.js";

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

  let nodeSignal = config.signal;

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

  // P2 (opt-in): lease this node under the durable ledger. When no ledger is
  // configured, `ledgerLease` stays undefined and the path below is identical
  // to pre-P2 behavior.
  let ledgerLease: NodeLeaseLike | undefined;
  if (config.nodeLedger !== undefined && idempotencyKey !== undefined) {
    let begin: BeginNodeOutcome;
    try {
      begin = await beginNodeUnderLedger(
        config.nodeLedger,
        runId,
        node.id,
        idempotencyKey,
        runId,
        Date.now()
      );
    } catch (err) {
      // Ledger unavailability is non-fatal for liveness, but it disables the
      // exactly-once safety net for this node: a retried run can now
      // double-execute a side-effecting node (duplicate payment/email). Surface
      // the degradation loudly BEFORE falling through so it is diagnosable in
      // real time rather than only after the fact.
      defaultLogger.warn("[pipeline] node ledger begin failed — degrading", {
        operation: "node.ledger.begin",
        runId,
        nodeId: node.id,
        error: String(err),
        effect: "idempotency_disabled_for_node",
      });
      begin = { kind: "lease", lease: { owner: runId, fenceToken: 0 } };
    }
    if (begin.kind === "replay") {
      // A completed node replays its prior result instead of re-executing.
      const replayResult: NodeResult = {
        nodeId: node.id,
        output: begin.output,
        durationMs: 0,
      };
      if (span) config.tracer?.endSpanOk(span);
      emit(nodeCompletedEvent(node.id, 0));
      nodeResults.set(node.id, replayResult);
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
    }
    if (begin.kind === "busy") {
      // Held by a fresh lease elsewhere — abort this node's execution.
      return fail(`node "${node.id}" is leased by another worker`);
    }
    ledgerLease = begin.lease;
  }

  // P2 (opt-in): renew the lease while the node runs. The composite signal
  // aborts the node on lease loss (fenced out) or run cancellation.
  let heartbeat: HeartbeatHandle | undefined;
  if (
    config.nodeLedger !== undefined &&
    ledgerLease !== undefined &&
    idempotencyKey !== undefined
  ) {
    heartbeat = startNodeHeartbeat(
      config.nodeLedger,
      runId,
      node.id,
      ledgerLease.owner,
      ledgerLease.fenceToken,
      config.signal
    );
    nodeSignal = heartbeat.signal;
  }

  const context: NodeExecutionContext = omitUndefined({
    state: runState,
    previousResults: nodeResults,
    signal: nodeSignal,
    idempotencyKey,
  });

  try {
    const finalResult = await runNodeWithRetry(config, emit, node, context);

    if (finalResult.error) {
      if (
        config.nodeLedger !== undefined &&
        ledgerLease !== undefined &&
        idempotencyKey !== undefined
      ) {
        await failNodeUnderLedger(
          config.nodeLedger,
          runId,
          node.id,
          idempotencyKey,
          ledgerLease,
          finalResult.error,
          true
        );
      }
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

    // P2 (opt-in): record the completion fence-gated. A fenced-out write means
    // a newer lease superseded us mid-execution → abort without marking done.
    if (
      config.nodeLedger !== undefined &&
      ledgerLease !== undefined &&
      idempotencyKey !== undefined
    ) {
      const committed = await completeNodeUnderLedger(
        config.nodeLedger,
        runId,
        node.id,
        idempotencyKey,
        ledgerLease,
        finalResult.output,
        finalResult.durationMs
      );
      if (!committed) {
        return fail(
          `node "${node.id}" lease lost during execution (fenced out)`
        );
      }
    }

    emit(nodeCompletedEvent(node.id, finalResult.durationMs));
    nodeResults.set(node.id, finalResult);
    if (
      node.source?.nodeType === "action" &&
      node.source.nodeId !== undefined
    ) {
      context.state[node.source.nodeId] = finalResult.output;
    }

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
  } finally {
    // P2: always stop the lease-renewal interval, on every exit path.
    heartbeat?.stop();
  }
}
