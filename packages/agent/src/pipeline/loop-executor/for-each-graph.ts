import type { PipelineForEachItemFrame } from "@dzupagent/core/pipeline";
import type { LoopNode, PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";
import { canonicalInputDigest, digestPipelineDefinition } from "@dzupagent/runtime-contracts";
import { validateRetainedLoopBodyGraphCheckpointState } from "../loop-body-graph-checkpoint-validator.js";
import type { LoopBodyGraphCheckpointState, LoopResumeOptions } from "./types.js";

/**
 * One item graph owns a shared outer checkpoint version line. Serialize the
 * complete callback (frame mutation through CAS verdict), poison that line on
 * failure, and fence new host operations until a new run reloads durable state.
 */
export function fenceForEachGraphOperations(original: LoopResumeOptions) {
  let failure: { error: unknown } | undefined;
  let checkpointQueue = Promise.resolve();
  const check = (): void => { if (failure) throw failure.error; };
  const fail = (error: unknown): void => { failure ??= { error }; };
  const guard = <A extends unknown[], R>(callback: (...args: A) => R) =>
    (...args: A): R => { check(); return callback(...args); };
  const serialize = <A extends unknown[]>(callback: (...args: A) => Promise<void>) =>
    (...args: A): Promise<void> => {
      const pending = checkpointQueue.then(async () => {
        check();
        try { await callback(...args); } catch (error) { fail(error); throw error; }
      });
      checkpointQueue = pending.catch(() => {});
      return pending;
    };
  const options: LoopResumeOptions = {
    ...original,
    ...(original.onItemBodyNodeComplete && { onItemBodyNodeComplete: serialize(original.onItemBodyNodeComplete) }),
    ...(original.onItemTerminalOutcome && { onItemTerminalOutcome: serialize(original.onItemTerminalOutcome) }),
    ...(original.onIterationComplete && { onIterationComplete: guard(original.onIterationComplete) }),
    ...(original.reserveIterationBudget && { reserveIterationBudget: guard(original.reserveIterationBudget) }),
    ...(original.settleIterationBudget && { settleIterationBudget: guard(original.settleIterationBudget) }),
    ...(original.releaseIterationBudget && { releaseIterationBudget: guard(original.releaseIterationBudget) }),
    ...(original.reconcileIterationBudget && { reconcileIterationBudget: guard(original.reconcileIterationBudget) }),
    ...(original.measureItemCost && { measureItemCost: guard(original.measureItemCost) }),
  };
  return { options, check, fail, serialize, get failed() { return failure !== undefined; } };
}

/** Preflight every item before concurrent dispatch can reach an economics host. */
export function validateForEachItemGraphs(
  definition: PipelineDefinition,
  loop: LoopNode,
  items: readonly unknown[],
  itemFrames: Readonly<Record<string, PipelineForEachItemFrame>> | undefined
): void {
  for (const item of Object.values(itemFrames ?? {})) {
    const graph = item.graph;
    const fail = (reason: string): never => {
      throw new Error(`Loop "${loop.id}" item ${item.itemIndex}: corrupt retained item graph: ${reason}`);
    };
    if (loop.bodyGraph === undefined) {
      if (graph !== undefined) fail("graph receipt on a flat body");
      continue;
    }
    if (graph === undefined) {
      // An initial reservation can predate the first graph dispatch. Every
      // recorded successful node, however, requires its exact graph receipt.
      if (item.nextBodyNodeIndex !== 0 || Object.keys(item.bodyResults ?? {}).length > 0 || item.outcome === "completed") {
        fail("durable work has no graph receipt");
      }
      continue;
    }
    if (graph.schema !== "dzupagent/for-each-item-graph/v1" ||
        graph.loopNodeId !== loop.id || graph.itemIndex !== item.itemIndex ||
        graph.definitionDigest !== digestPipelineDefinition(definition) ||
        graph.itemValueDigest !== `sha256:${canonicalInputDigest(items[item.itemIndex])}`) fail("version or item identity mismatch");
    if (graph.frame.outcome !== undefined && graph.frame.outcome.kind !== "normal") fail("non-normal outcome");
    if (item.nextBodyNodeIndex !== 0 && item.nextBodyNodeIndex !== loop.bodyNodeIds.length) fail("graph cursor interpreted as flat progress");
    if (item.nextBodyNodeIndex === loop.bodyNodeIds.length && !graph.frame.completed) fail("body completion precedes graph completion");
    if (item.outcome === "completed" && item.nextBodyNodeIndex !== loop.bodyNodeIds.length) fail("settled item lacks body completion");
    const frame = graph.frame as LoopBodyGraphCheckpointState;
    validateRetainedLoopBodyGraphCheckpointState(definition, loop.id, frame);
    // The generic frame validator checks the last boundary. This one-branch
    // adapter also requires the full recorded history to be one actual path.
    let previous: string | undefined;
    for (const id of frame.completedNodeIds) {
      const allowed = previous === undefined ? [loop.bodyGraph.entryNodeId] :
        definition.edges.filter((edge) => edge.sourceNodeId === previous).flatMap((edge) =>
          edge.type === "conditional" ? Object.values(edge.branches) : [edge.targetNodeId]);
      if (!allowed.includes(id)) fail("completed history is not an item path");
      previous = id;
    }
    const body = Object.fromEntries(Object.entries(item.bodyResults ?? {}).filter(([id]) => id !== loop.id));
    if (canonicalInputDigest(body) !== canonicalInputDigest(frame.nodeResults)) fail("body and graph results disagree");
  }
}
