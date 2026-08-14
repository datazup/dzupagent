/**
 * Loop node handler for the pipeline executor.
 *
 * Wraps `executeLoop` with the runtime-specific concerns: span
 * creation, body-node lookup, event emission, and metrics attachment.
 *
 * @module pipeline/pipeline-runtime/loop-node-handler
 */

import type { PipelineNode, LoopNode } from "@dzupagent/core/pipeline";
import { executeLoop, type LoopResumeOptions } from "../loop-executor.js";
import type {
  NodeResult,
  NodeExecutionContext,
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
  NodeExecutor,
} from "../pipeline-runtime-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
} from "./runtime-events.js";
import { recordIterationBudget } from "./node-side-effects.js";
import type { BudgetTrackerState } from "./iteration-budget-tracker.js";

export interface LoopNodeHandlerDeps {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  emit: (event: PipelineRuntimeEvent) => void;
  budgetTracker: BudgetTrackerState;
}

export async function handleLoop(
  deps: LoopNodeHandlerDeps,
  loopNode: LoopNode,
  runState: Record<string, unknown>,
  nodeResults: Map<string, NodeResult>,
  resume?: LoopResumeOptions
): Promise<NodeResult> {
  const { config, nodeMap, emit, budgetTracker } = deps;

  emit(nodeStartedEvent(loopNode.id, "loop"));

  // Start OTel span for the loop node
  const loopSpan = config.tracer?.startPhaseSpan(loopNode.id, {
    attributes: {
      "forge.pipeline.node_type": "loop",
      "forge.pipeline.phase": loopNode.id,
    },
  });

  const bodyNodes: PipelineNode[] = [];
  for (const bodyId of loopNode.bodyNodeIds) {
    const bodyNode = nodeMap.get(bodyId);
    if (!bodyNode) {
      const errorResult: NodeResult = {
        nodeId: loopNode.id,
        output: null,
        durationMs: 0,
        error: `Loop body node "${bodyId}" not found`,
      };
      if (loopSpan)
        config.tracer?.endSpanWithError(loopSpan, errorResult.error);
      return errorResult;
    }
    bodyNodes.push(bodyNode);
  }

  const context: NodeExecutionContext = omitUndefined({
    state: runState,
    previousResults: nodeResults,
    signal: config.signal,
  });

  const predicates = config.predicates ?? {};

  // Sequential predicate loops dispatch body nodes outside the executor's
  // standard-node path, so account their successful paid work here. A body
  // result is charged before its body-progress checkpoint hook runs; retained
  // results skipped during resume never pass through this wrapper and are not
  // charged twice. Concurrent for_each needs per-item reservations/durable
  // receipts and intentionally remains on the unwrapped executor for now.
  const bodyExecutor: NodeExecutor =
    loopNode.forEach === undefined
      ? async (nodeId, node, bodyContext) => {
          const bodyResult = await config.nodeExecutor(
            nodeId,
            node,
            bodyContext
          );
          if (bodyResult.error !== undefined) return bodyResult;

          const budgetAbort = recordIterationBudget(
            config,
            emit,
            budgetTracker,
            nodeId,
            bodyResult,
            loopIteration(bodyContext.state)
          );
          return budgetAbort === undefined
            ? bodyResult
            : { ...bodyResult, error: budgetAbort };
        }
      : config.nodeExecutor;

  const { result, metrics } = await executeLoop(
    loopNode,
    bodyNodes,
    bodyExecutor,
    context,
    predicates,
    config.onEvent,
    resume
  );

  if (result.error) {
    if (loopSpan) config.tracer?.endSpanWithError(loopSpan, result.error);
    emit(nodeFailedEvent(loopNode.id, result.error));
  } else {
    if (loopSpan) config.tracer?.endSpanOk(loopSpan);
    emit(nodeCompletedEvent(loopNode.id, result.durationMs));
  }

  // Attach metrics to output
  const output = { loopOutput: result.output, metrics };

  return { ...result, output };
}

function loopIteration(state: Record<string, unknown>): number {
  const binding = state["loop"];
  if (typeof binding !== "object" || binding === null) return 0;
  const iteration = (binding as Record<string, unknown>)["iteration"];
  return typeof iteration === "number" && Number.isFinite(iteration)
    ? iteration
    : 0;
}
