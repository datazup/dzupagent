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
} from "../pipeline-runtime-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import {
  nodeStartedEvent,
  nodeCompletedEvent,
  nodeFailedEvent,
} from "./runtime-events.js";

export interface LoopNodeHandlerDeps {
  config: PipelineRuntimeConfig;
  nodeMap: Map<string, PipelineNode>;
  emit: (event: PipelineRuntimeEvent) => void;
}

export async function handleLoop(
  deps: LoopNodeHandlerDeps,
  loopNode: LoopNode,
  runState: Record<string, unknown>,
  nodeResults: Map<string, NodeResult>,
  resume?: LoopResumeOptions
): Promise<NodeResult> {
  const { config, nodeMap, emit } = deps;

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

  const { result, metrics } = await executeLoop(
    loopNode,
    bodyNodes,
    config.nodeExecutor,
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
