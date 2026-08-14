/** Definition-bound validation for restored structured loop-body frames. */

import type {
  ForkNode,
  LoopNode,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type { NodeResult } from "./pipeline-runtime-types.js";
import type { LoopBodyGraphCheckpointState } from "./loop-executor/types.js";
import {
  getErrorTarget,
  getForkBranchStartIds,
} from "./pipeline-runtime/edge-resolution.js";
import { extractErrorCode } from "./pipeline-runtime/error-classification.js";

export interface LoopBodyGraphCheckpointDefinition {
  loopNode: LoopNode;
  nodes: readonly PipelineNode[];
  outgoingEdges: ReadonlyMap<string, PipelineEdge[]>;
  errorEdges: ReadonlyMap<string, PipelineEdge[]>;
}

/**
 * Reject a structurally valid but definition-incompatible retained graph frame.
 * The checkpoint schema cannot know which body/fork/branch IDs belong to the
 * currently loaded definition, so that custody check lives at restore time.
 */
export function validateLoopBodyGraphCheckpointState(
  definition: LoopBodyGraphCheckpointDefinition,
  state: LoopBodyGraphCheckpointState
): void {
  const { loopNode, nodes, outgoingEdges, errorEdges } = definition;
  const bodyIds = new Set(nodes.map(({ id }) => id));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  if (typeof state.completed !== "boolean") {
    corrupt(loopNode.id, "completed must be a boolean");
  }
  if (!Array.isArray(state.completedNodeIds)) {
    corrupt(loopNode.id, "completedNodeIds must be an array");
  }
  if (!isRecord(state.nodeResults)) {
    corrupt(loopNode.id, "nodeResults must be an object");
  }
  if (!isRecord(state.nodeIdempotencyKeys)) {
    corrupt(loopNode.id, "nodeIdempotencyKeys must be an object");
  }

  if (state.completed) {
    if (state.nextNodeId !== undefined) {
      corrupt(loopNode.id, "completed cursor must omit nextNodeId");
    }
  } else if (
    typeof state.nextNodeId !== "string" ||
    state.nextNodeId.length === 0
  ) {
    corrupt(loopNode.id, "incomplete cursor requires nextNodeId");
  }

  if (state.nextNodeId !== undefined && !bodyIds.has(state.nextNodeId)) {
    corrupt(
      loopNode.id,
      `next node "${state.nextNodeId}" is outside bodyNodeIds`
    );
  }

  const completed = new Set<string>();
  for (const completedNodeId of state.completedNodeIds) {
    if (typeof completedNodeId !== "string" || !bodyIds.has(completedNodeId)) {
      corrupt(
        loopNode.id,
        `completed node "${String(completedNodeId)}" is outside bodyNodeIds`
      );
    }
    if (completed.has(completedNodeId)) {
      corrupt(
        loopNode.id,
        `completedNodeIds contains duplicate "${completedNodeId}"`
      );
    }
    completed.add(completedNodeId);
  }

  const results = validateResultRecord(
    loopNode.id,
    "result",
    state.nodeResults,
    bodyIds
  );

  for (const [nodeId, key] of Object.entries(state.nodeIdempotencyKeys)) {
    if (!bodyIds.has(nodeId)) {
      corrupt(
        loopNode.id,
        `idempotency node "${nodeId}" is outside bodyNodeIds`
      );
    }
    if (typeof key !== "string" || key.length === 0) {
      corrupt(loopNode.id, `idempotency key for "${nodeId}" is invalid`);
    }
    if (!completed.has(nodeId)) {
      corrupt(
        loopNode.id,
        `idempotency node "${nodeId}" is not completed`
      );
    }
  }

  for (const completedNodeId of completed) {
    const node = nodeMap.get(completedNodeId)!;
    if (
      node.type !== "fork" &&
      node.type !== "join" &&
      !results.has(completedNodeId)
    ) {
      corrupt(
        loopNode.id,
        `completed node "${completedNodeId}" is missing its result`
      );
    }
  }

  const handledErrorTargets = new Set<string>();
  for (const [nodeId, result] of results) {
    if (completed.has(nodeId)) continue;
    const errorTarget =
      result.error === undefined
        ? undefined
        : getErrorTarget(
            nodeId,
            errorEdges as Map<string, PipelineEdge[]>,
            extractErrorCode(result.error)
          );
    if (
      errorTarget === undefined ||
      (errorTarget !== state.nextNodeId && !completed.has(errorTarget))
    ) {
      corrupt(
        loopNode.id,
        `result for unfinished node "${nodeId}" is not a handled error`
      );
    }
    handledErrorTargets.add(errorTarget);
  }

  const activeFork = validateForkState(
    loopNode.id,
    state,
    nodes,
    outgoingEdges,
    bodyIds,
    completed
  );

  if (state.completed) {
    if (activeFork !== undefined) {
      corrupt(loopNode.id, "completed cursor cannot retain forkState");
    }
    const exitNodeId = state.completedNodeIds.at(-1);
    if (
      exitNodeId === undefined ||
      !loopNode.bodyGraph?.normalExitNodeIds.includes(exitNodeId)
    ) {
      corrupt(
        loopNode.id,
        `completed cursor did not reach a valid normal exit${
          exitNodeId === undefined ? "" : `: "${exitNodeId}"`
        }`
      );
    }
    return;
  }

  const nextNodeId = state.nextNodeId!;
  if (activeFork !== undefined) {
    if (nextNodeId !== activeFork.id) {
      corrupt(
        loopNode.id,
        `mid-flight fork "${activeFork.forkId}" must resume at "${activeFork.id}"`
      );
    }
    return;
  }

  if (completed.has(nextNodeId)) {
    corrupt(loopNode.id, `next node "${nextNodeId}" is already completed`);
  }

  const lastCompletedNodeId = state.completedNodeIds.at(-1);
  const normalTargets =
    lastCompletedNodeId === undefined
      ? new Set([loopNode.bodyGraph!.entryNodeId])
      : new Set(
          (outgoingEdges.get(lastCompletedNodeId) ?? []).flatMap(edgeTargets)
        );
  if (
    !normalTargets.has(nextNodeId) &&
    !handledErrorTargets.has(nextNodeId)
  ) {
    corrupt(
      loopNode.id,
      `next node "${nextNodeId}" does not follow the retained graph position`
    );
  }
}

function validateForkState(
  loopNodeId: string,
  state: LoopBodyGraphCheckpointState,
  nodes: readonly PipelineNode[],
  outgoingEdges: ReadonlyMap<string, PipelineEdge[]>,
  bodyIds: ReadonlySet<string>,
  completed: ReadonlySet<string>
): ForkNode | undefined {
  if (state.forkState === undefined) return undefined;
  if (!isRecord(state.forkState)) {
    corrupt(loopNodeId, "forkState must be an object");
  }

  const entries = Object.entries(state.forkState);
  if (entries.length > 1) {
    corrupt(loopNodeId, "forkState contains multiple active forks");
  }
  if (entries.length === 0) return undefined;

  const [forkId, forkProgress] = entries[0]!;
  const matchingForks = nodes.filter(
    (node): node is ForkNode => node.type === "fork" && node.forkId === forkId
  );
  if (matchingForks.length !== 1) {
    corrupt(loopNodeId, `fork ID "${forkId}" is not a unique body fork`);
  }
  const forkNode = matchingForks[0]!;
  if (!isRecord(forkProgress) || !isRecord(forkProgress.branches)) {
    corrupt(loopNodeId, `fork "${forkId}" branches must be an object`);
  }
  if (!completed.has(forkNode.id)) {
    corrupt(loopNodeId, `mid-flight fork node "${forkNode.id}" is not completed`);
  }
  if (state.completed) {
    corrupt(loopNodeId, "completed cursor cannot retain forkState");
  }

  const branchEntries = Object.entries(forkProgress.branches);
  if (branchEntries.length === 0) {
    corrupt(loopNodeId, `fork "${forkId}" has no retained branches`);
  }
  const branchIds = new Set(
    getForkBranchStartIds(outgoingEdges.get(forkNode.id) ?? [])
  );
  for (const [branchId, branch] of branchEntries) {
    if (!branchIds.has(branchId)) {
      corrupt(
        loopNodeId,
        `branch ID "${branchId}" is not a branch of fork "${forkId}"`
      );
    }
    if (!isRecord(branch) || !isRecord(branch.nodeResults)) {
      corrupt(loopNodeId, `branch "${branchId}" nodeResults must be an object`);
    }
    validateResultRecord(
      loopNodeId,
      `branch "${branchId}" result`,
      branch.nodeResults,
      bodyIds
    );
  }
  return forkNode;
}

function validateResultRecord(
  loopNodeId: string,
  label: string,
  record: Record<string, unknown>,
  bodyIds: ReadonlySet<string>
): Map<string, NodeResult> {
  const results = new Map<string, NodeResult>();
  for (const [nodeId, value] of Object.entries(record)) {
    if (!bodyIds.has(nodeId)) {
      corrupt(loopNodeId, `${label} "${nodeId}" is outside bodyNodeIds`);
    }
    if (!isRecord(value) || value.nodeId !== nodeId) {
      corrupt(loopNodeId, `${label} key/nodeId mismatch for "${nodeId}"`);
    }
    results.set(nodeId, value as unknown as NodeResult);
  }
  return results;
}

function edgeTargets(edge: PipelineEdge): string[] {
  if (edge.type === "error") return [];
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(loopNodeId: string, detail: string): never {
  throw new Error(
    `Loop node "${loopNodeId}": corrupt retained graph cursor: ${detail}`
  );
}
