/** Definition-bound validation for restored scoped graph frames. */

import type {
  ForkNode,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type { NodeResult } from "../pipeline-runtime-types.js";
import {
  getErrorTarget,
  getForkBranchStartIds,
} from "../pipeline-runtime/edge-resolution.js";
import { extractErrorCode } from "../pipeline-runtime/error-classification.js";
import type {
  ScopedGraphCheckpointDefinition,
  ScopedGraphCheckpointFrame,
} from "./contract.js";

/**
 * Reject a structurally valid but definition-incompatible scoped graph frame.
 * The checkpoint schema cannot know which scoped node/fork/branch IDs belong to the
 * currently loaded definition, so that custody check lives at restore time.
 */
export function validateScopedGraphCheckpointFrame(
  definition: ScopedGraphCheckpointDefinition,
  state: ScopedGraphCheckpointFrame
): void {
  const { boundary, nodes, outgoingEdges, errorEdges } = definition;
  const { displayName, nodeInventoryName } = boundary;
  // Keep the validator body expressed against one boundary object while the
  // legacy loop adapter supplies the historical display and inventory names.
  const loopNode = { id: displayName, bodyGraph: boundary };
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
  const outcome = validateOutcome(loopNode.id, state.outcome);

  if (outcome?.kind === "suspended") {
    if (state.completed || state.nextNodeId !== undefined) {
      corrupt(
        loopNode.id,
        "suspended outcome requires completed=false and must omit nextNodeId"
      );
    }
  } else if (outcome !== undefined) {
    if (!state.completed || state.nextNodeId !== undefined) {
      corrupt(
        loopNode.id,
        `${outcome.kind} outcome requires completed=true and must omit nextNodeId`
      );
    }
  } else if (state.completed) {
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
      `next node "${state.nextNodeId}" is outside ${nodeInventoryName}`
    );
  }

  const completed = new Set<string>();
  for (const completedNodeId of state.completedNodeIds) {
    if (typeof completedNodeId !== "string" || !bodyIds.has(completedNodeId)) {
      corrupt(
        loopNode.id,
        `completed node "${String(completedNodeId)}" is outside ${nodeInventoryName}`
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
    bodyIds,
    nodeInventoryName
  );

  for (const [nodeId, key] of Object.entries(state.nodeIdempotencyKeys)) {
    if (!bodyIds.has(nodeId)) {
      corrupt(
        loopNode.id,
        `idempotency node "${nodeId}" is outside ${nodeInventoryName}`
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
    nodeInventoryName,
    completed
  );

  if (outcome !== undefined) {
    if (activeFork !== undefined) {
      corrupt(loopNode.id, `${outcome.kind} outcome cannot retain forkState`);
    }
    const classifications = outcome.kind === "suspended"
      ? new Set([
          ...(loopNode.bodyGraph?.suspendedExitNodeIds ?? []),
          ...(loopNode.bodyGraph?.suspensionSiteNodeIds ?? []),
        ]).has(outcome.exitNodeId)
        ? ["suspended"]
        : []
      : ([
          ["normal", loopNode.bodyGraph?.normalExitNodeIds ?? []],
          ["terminal", loopNode.bodyGraph?.terminalExitNodeIds ?? []],
          ["error", loopNode.bodyGraph?.errorExitNodeIds ?? []],
        ] as const)
          .filter(([, exitIds]) => exitIds.includes(outcome.exitNodeId))
          .map(([kind]) => kind);
    const classificationMatches =
      classifications.length === 1 && classifications[0] === outcome.kind;
    if (!classificationMatches) {
      corrupt(
        loopNode.id,
        `${outcome.kind} outcome exit "${outcome.exitNodeId}" must have exactly one matching declared classification`
      );
    }

    const outcomeNode = nodeMap.get(outcome.exitNodeId);
    if (outcomeNode === undefined) {
      corrupt(
        loopNode.id,
        `${outcome.kind} outcome exit "${outcome.exitNodeId}" is outside ${nodeInventoryName}`
      );
    }
    const lastCompletedNodeId = state.completedNodeIds.at(-1);
    const reachableTargets =
      lastCompletedNodeId === undefined
        ? new Set([loopNode.bodyGraph!.entryNodeId])
        : new Set(
            (outgoingEdges.get(lastCompletedNodeId) ?? []).flatMap(edgeTargets)
          );
    if (
      outcome.kind !== "normal" &&
      !reachableTargets.has(outcome.exitNodeId) &&
      !handledErrorTargets.has(outcome.exitNodeId)
    ) {
      corrupt(
        loopNode.id,
        `${outcome.kind} outcome exit "${outcome.exitNodeId}" does not follow the retained graph position`
      );
    }

    if (outcome.kind === "normal") {
      if (lastCompletedNodeId !== outcome.exitNodeId) {
        corrupt(
          loopNode.id,
          `normal outcome exit "${outcome.exitNodeId}" is not the last completed node`
        );
      }
    } else if (outcome.kind === "terminal") {
      if (outcomeNode.type !== "suspend") {
        corrupt(
          loopNode.id,
          `terminal outcome exit "${outcome.exitNodeId}" is not a suspend node`
        );
      }
      const terminalTargets = (outgoingEdges.get(outcome.exitNodeId) ?? [])
        .flatMap(edgeTargets);
      if (terminalTargets.length !== 0) {
        corrupt(
          loopNode.id,
          `terminal outcome exit "${outcome.exitNodeId}" has an outgoing body continuation`
        );
      }
    } else {
      if (completed.has(outcome.exitNodeId)) {
        corrupt(
          loopNode.id,
          `suspended outcome exit "${outcome.exitNodeId}" is already completed`
        );
      }
      const suspendCapable =
        outcomeNode.type === "suspend" ||
        (outcomeNode.type === "gate" && outcomeNode.gateType === "approval");
      if (!suspendCapable) {
        corrupt(
          loopNode.id,
          `suspended outcome exit "${outcome.exitNodeId}" is not suspend-capable`
        );
      }
      const resumeEdges = outgoingEdges.get(outcome.exitNodeId) ?? [];
      if (resumeEdges.length === 0) {
        corrupt(
          loopNode.id,
          `suspended outcome exit "${outcome.exitNodeId}" has no resumable body continuation`
        );
      }
      if (resumeEdges.length !== 1) {
        corrupt(
          loopNode.id,
          `suspended outcome exit "${outcome.exitNodeId}" has multiple body continuations`
        );
      }
    }
    return;
  }

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
  state: ScopedGraphCheckpointFrame,
  nodes: readonly PipelineNode[],
  outgoingEdges: ReadonlyMap<string, PipelineEdge[]>,
  bodyIds: ReadonlySet<string>,
  nodeInventoryName: string,
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
      bodyIds,
      nodeInventoryName
    );
  }
  return forkNode;
}

function validateResultRecord(
  loopNodeId: string,
  label: string,
  record: Record<string, unknown>,
  bodyIds: ReadonlySet<string>,
  nodeInventoryName: string
): Map<string, NodeResult> {
  const results = new Map<string, NodeResult>();
  for (const [nodeId, value] of Object.entries(record)) {
    if (!bodyIds.has(nodeId)) {
      corrupt(
        loopNodeId,
        `${label} "${nodeId}" is outside ${nodeInventoryName}`
      );
    }
    if (!isRecord(value) || value.nodeId !== nodeId) {
      corrupt(loopNodeId, `${label} key/nodeId mismatch for "${nodeId}"`);
    }
    results.set(nodeId, value as unknown as NodeResult);
  }
  return results;
}

function validateOutcome(
  loopNodeId: string,
  value: unknown
): ScopedGraphCheckpointFrame["outcome"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    corrupt(loopNodeId, "outcome must be an object");
  }
  if (
    value.kind !== "normal" &&
    value.kind !== "suspended" &&
    value.kind !== "terminal"
  ) {
    corrupt(loopNodeId, `outcome kind "${String(value.kind)}" is invalid`);
  }
  if (typeof value.exitNodeId !== "string" || value.exitNodeId.length === 0) {
    corrupt(loopNodeId, "outcome exitNodeId must be a non-empty string");
  }
  return value as NonNullable<ScopedGraphCheckpointFrame["outcome"]>;
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

function corrupt(displayName: string, detail: string): never {
  throw new Error(`${displayName}: corrupt retained graph cursor: ${detail}`);
}
