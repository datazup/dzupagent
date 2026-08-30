import type { PipelineRecursiveForkCompletionV1 } from "@dzupagent/core/pipeline";
import type { ForkNode, PipelineEdge } from "@dzupagent/runtime-contracts/pipeline-artifact";
import {
  canonicalInputDigest,
  digestPipelineDefinition,
  type NodeExecutionContext,
} from "@dzupagent/runtime-contracts";
import type {
  RecursiveScopedJsonObject,
  RecursiveScopedJsonValue,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import type {
  AdmittedForkBranchGraph,
  AdmittedRecursiveForkGraph,
} from "../loop-executor/definition-validation/graph-helpers.js";
import type { RecursiveScopedDurablePortV1 } from "../recursive-scope/types.js";
import {
  dispatchRecursiveBranchesV1,
  materializeRecursiveBranchPlanV1,
} from "../recursive-scope/index.js";
import {
  parseRecursiveStoredCommitV1,
  parseRecursiveStoredFrameV1,
} from "../recursive-scope/durable-child.js";
import type { RecursiveBranchPlanInputV1 } from "../recursive-scope/types.js";
import type {
  ScopedGraphBoundary,
  ScopedGraphCheckpointDefinition,
  ScopedGraphCheckpointFrame,
  ScopedGraphExecutorDeps,
  ScopedGraphFrameCodec,
} from "../scoped-graph/contract.js";
import { executeScopedGraph } from "../scoped-graph/execute-scoped-graph.js";
import { validateScopedGraphCheckpointFrame } from "../scoped-graph/validate-scoped-graph-frame.js";
import type { NodeResult, PipelineRuntimeConfig } from "../pipeline-runtime-types.js";
import { collectStateDelta } from "./branch-merge.js";
import type { RunFrame } from "./run-frame.js";

export type RecursiveForkRuntimeDeps = ScopedGraphExecutorDeps;

export interface RecursiveForkExecutionResult {
  readonly receipt: Omit<
    PipelineRecursiveForkCompletionV1,
    "checkpointVersion" | "selectedContinuationNodeId"
  >;
}

const SCOPED_FRAME_CODEC: ScopedGraphFrameCodec<ScopedGraphCheckpointFrame> = {
  decode: (frame) => frame,
  encode: (frame) => frame,
};

function digest(value: unknown): RecursiveScopedSha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

function toJsonValue(value: unknown, path: string): RecursiveScopedJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Recursive fork value at ${path} is not finite JSON.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      toJsonValue(entry, `${path}[${index}]`)
    );
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Recursive fork value at ${path} is not a plain JSON object.`);
    }
    const output: Record<string, RecursiveScopedJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toJsonValue(entry, `${path}.${key}`);
    }
    return output;
  }
  throw new Error(`Recursive fork value at ${path} is not JSON serializable.`);
}

function toJsonObject(
  value: Readonly<Record<string, unknown>>,
  path: string
): RecursiveScopedJsonObject {
  return toJsonValue(value, path) as RecursiveScopedJsonObject;
}

export function checkpointFrameFromJson(
  value: RecursiveScopedJsonObject
): ScopedGraphCheckpointFrame {
  return value as unknown as ScopedGraphCheckpointFrame;
}

function checkpointFrameToJson(
  value: ScopedGraphCheckpointFrame
): RecursiveScopedJsonObject {
  return toJsonObject(value as unknown as Record<string, unknown>, "checkpoint");
}

function canonicalNodeResult(result: NodeResult): NodeResult {
  return {
    nodeId: result.nodeId,
    output: result.output,
    durationMs: 0,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.errorMetadata === undefined
      ? {}
      : { errorMetadata: result.errorMetadata }),
    ...(result.providerSessionRefs === undefined
      ? {}
      : { providerSessionRefs: result.providerSessionRefs }),
  };
}

function canonicalCheckpointFrame(
  checkpoint: ScopedGraphCheckpointFrame
): ScopedGraphCheckpointFrame {
  return {
    ...checkpoint,
    nodeResults: Object.fromEntries(
      Object.entries(checkpoint.nodeResults).map(([nodeId, result]) => [
        nodeId,
        canonicalNodeResult(result),
      ])
    ),
  };
}

export function boundaryFor(
  config: PipelineRuntimeConfig,
  forkNode: ForkNode,
  branch: AdmittedForkBranchGraph
): ScopedGraphBoundary {
  return {
    scopeId: `${forkNode.id}:branch:${branch.branchOrdinal}`,
    displayName: `Recursive fork "${forkNode.id}" branch ${branch.branchOrdinal}`,
    sourceDefinitionId: config.definition.id,
    scopedDefinitionId: `${config.definition.id}::fork:${forkNode.id}:branch:${branch.branchOrdinal}`,
    nodeInventoryName: "recursive fork branch graph",
    entryNodeId: branch.branchStartNodeId,
    nodeIds: branch.nodeIds,
    normalExitNodeIds: branch.normalExitNodeIds,
    suspendedExitNodeIds: [],
    terminalExitNodeIds: [],
    errorExitNodeIds: [],
  };
}

export function checkpointDefinitionFor(
  config: PipelineRuntimeConfig,
  boundary: ScopedGraphBoundary
): ScopedGraphCheckpointDefinition {
  const bodyIds = new Set(boundary.nodeIds);
  const nodes = config.definition.nodes.filter((node) => bodyIds.has(node.id));
  const outgoingEdges = new Map<string, PipelineEdge[]>();
  const errorEdges = new Map<string, PipelineEdge[]>();
  for (const node of nodes) {
    outgoingEdges.set(node.id, []);
    errorEdges.set(node.id, []);
  }
  for (const edge of config.definition.edges) {
    const targets =
      edge.type === "conditional"
        ? Object.values(edge.branches)
        : [edge.targetNodeId];
    if (
      !bodyIds.has(edge.sourceNodeId) ||
      targets.some((targetId) => !bodyIds.has(targetId))
    ) {
      continue;
    }
    const target = edge.type === "error" ? errorEdges : outgoingEdges;
    target.get(edge.sourceNodeId)?.push(edge);
  }
  return { boundary, nodes, outgoingEdges, errorEdges };
}

export function planFor(
  config: PipelineRuntimeConfig,
  forkNode: ForkNode,
  graph: AdmittedRecursiveForkGraph,
  runId: string
): RecursiveBranchPlanInputV1 {
  const rootDefinitionDigest = digestPipelineDefinition(
    config.definition
  ) as RecursiveScopedSha256Digest;
  const parentCommitIdentity = digest({
    schema: "dzupagent.pipelineRecursiveForkParent/v1",
    runId,
    rootDefinitionDigest,
    forkNodeId: forkNode.id,
    forkId: forkNode.forkId,
    joinNodeId: graph.joinNodeId,
  });
  return {
    frameKind: "fork-branch",
    rootDefinitionId: config.definition.id,
    rootDefinitionDigest,
    ownerPath: [config.definition.id, forkNode.id],
    ownerNodeId: forkNode.id,
    parentCommitIdentity,
    branches: graph.branches.map((branch) => {
      const boundary = boundaryFor(config, forkNode, branch);
      const nodeIds = new Set(branch.nodeIds);
      const scopedNodes = config.definition.nodes.filter((node) =>
        nodeIds.has(node.id)
      );
      const scopedEdges = config.definition.edges.filter((edge) => {
        const targets =
          edge.type === "conditional"
            ? Object.values(edge.branches)
            : [edge.targetNodeId];
        return (
          nodeIds.has(edge.sourceNodeId) &&
          targets.every((targetId) => nodeIds.has(targetId))
        );
      });
      return {
        branchOrdinal: branch.branchOrdinal,
        branchIdentity: branch.branchStartNodeId,
        childScopeId: `${runId}::fork:${forkNode.id}:branch:${branch.branchOrdinal}`,
        scopedDefinitionId: boundary.scopedDefinitionId,
        scopedDefinitionDigest: digest({
          schema: "dzupagent.pipelineRecursiveForkScopedDefinition/v1",
          rootDefinitionDigest,
          forkNodeId: forkNode.id,
          joinNodeId: graph.joinNodeId,
          branchOrdinal: branch.branchOrdinal,
          boundary,
          nodes: scopedNodes,
          edges: scopedEdges,
        }),
        nodeInventory: branch.nodeIds,
        continuation: { kind: "fork-join", nodeId: graph.joinNodeId },
        checkpoint: checkpointFrameToJson({
          completed: false,
          nextNodeId: branch.branchStartNodeId,
          completedNodeIds: [],
          nodeResults: {},
          nodeIdempotencyKeys: {},
        }),
      };
    }),
  };
}

function assertNodeResult(value: RecursiveScopedJsonValue, key: string): NodeResult {
  const record = value as RecursiveScopedJsonObject;
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof record.nodeId !== "string" ||
    record.nodeId !== key ||
    typeof record.durationMs !== "number"
  ) {
    throw new Error(`Recursive fork retained result "${key}" is corrupt.`);
  }
  return value as unknown as NodeResult;
}

export async function executeAdmittedRecursiveFork(
  deps: RecursiveForkRuntimeDeps,
  forkNode: ForkNode,
  graph: AdmittedRecursiveForkGraph,
  outerFrame: RunFrame,
  durable: RecursiveScopedDurablePortV1
): Promise<RecursiveForkExecutionResult> {
  const planInput = planFor(
    deps.config,
    forkNode,
    graph,
    outerFrame.runId
  );
  const plan = materializeRecursiveBranchPlanV1(planInput);
  const retainedFramePresence = await Promise.all(
    plan.frames.map((frame) => durable.loadFrame(frame.childScopeId))
  );
  const mode = retainedFramePresence.every((frame) => frame !== undefined)
    ? "restart"
    : "initial";
  const baseState = structuredClone(outerFrame.runState);
  const baseResults = new Map(outerFrame.nodeResults);

  const outcome = await dispatchRecursiveBranchesV1(
    {
      durable,
      createChildExecutor: ({ frame }) => {
        const branchOrdinal =
          frame.ownership.kind === "fork-branch"
            ? frame.ownership.branchOrdinal
            : -1;
        const branch = graph.branches[branchOrdinal];
        if (branch === undefined) {
          throw new Error("Recursive fork branch ownership is corrupt.");
        }
        const boundary = boundaryFor(deps.config, forkNode, branch);
        const childState = structuredClone(baseState);
        return {
          execute: async ({ frame: currentFrame, persistCheckpoint }) => {
            let latestCheckpoint = checkpointFrameFromJson(
              currentFrame.checkpoint
            );
            const context: NodeExecutionContext = {
              state: childState,
              previousResults: new Map(baseResults),
              ...(deps.config.signal === undefined
                ? {}
                : { signal: deps.config.signal }),
            };
            const result = await executeScopedGraph(
              deps,
              boundary,
              outerFrame,
              {
                scopedRunId: currentFrame.childScopeId,
                context,
                resumeFrame: latestCheckpoint,
                onCheckpoint: async (checkpoint) => {
                  latestCheckpoint = canonicalCheckpointFrame(checkpoint);
                  await persistCheckpoint(
                    checkpointFrameToJson(latestCheckpoint)
                  );
                },
              },
              SCOPED_FRAME_CODEC
            );
            if (result.outcome.kind !== "normal") {
              return {
                status: "blocked" as const,
                reason: "invalid-child-state" as const,
              };
            }
            return {
              status: "completed" as const,
              commit: {
                state: toJsonObject(
                  collectStateDelta(baseState, childState),
                  "state"
                ),
                results: toJsonObject(
                  Object.fromEntries(
                    [...result.nodeResults].map(([nodeId, nodeResult]) => [
                      nodeId,
                      canonicalNodeResult(nodeResult),
                    ])
                  ),
                  "results"
                ),
                idempotencyKeys: { ...latestCheckpoint.nodeIdempotencyKeys },
                effects: {},
                charges: {},
                intentClaims: [],
              },
            };
          },
        };
      },
    },
    { mode, plan: planInput }
  );

  if (outcome.status !== "completed") {
    const detail = "reason" in outcome ? outcome.reason : outcome.control;
    throw new Error(
      `Recursive fork dispatch failed closed: ${outcome.status}:${detail}`
    );
  }

  Object.assign(outerFrame.runState, outcome.merge.state);
  for (const [nodeId, value] of Object.entries(outcome.merge.results)) {
    outerFrame.nodeResults.set(nodeId, assertNodeResult(value, nodeId));
  }
  Object.assign(outerFrame.nodeIdempotencyKeys, outcome.merge.idempotencyKeys);

  const commitsByOrdinal = [...outcome.commits].sort((left, right) => {
    const leftOrdinal =
      left.ownership.kind === "fork-branch"
        ? left.ownership.branchOrdinal
        : Number.MAX_SAFE_INTEGER;
    const rightOrdinal =
      right.ownership.kind === "fork-branch"
        ? right.ownership.branchOrdinal
        : Number.MAX_SAFE_INTEGER;
    return leftOrdinal - rightOrdinal;
  });
  const children: PipelineRecursiveForkCompletionV1["children"] = [];
  for (const commit of commitsByOrdinal) {
    const ordinal =
      commit.ownership.kind === "fork-branch"
        ? commit.ownership.branchOrdinal
        : -1;
    const branch = graph.branches[ordinal];
    const plannedFrame = plan.frames[ordinal];
    if (branch === undefined || plannedFrame === undefined) {
      throw new Error("Recursive fork commit ownership is corrupt.");
    }
    const serializedFrame = await durable.loadFrame(commit.childScopeId);
    const serializedCommit = await durable.loadCommittedChild(commit.childScopeId);
    if (serializedFrame === undefined || serializedCommit === undefined) {
      throw new Error("Recursive fork completion evidence is missing.");
    }
    const retainedFrame = parseRecursiveStoredFrameV1(
      serializedFrame,
      plannedFrame
    );
    const retainedCommit = parseRecursiveStoredCommitV1(
      serializedCommit,
      retainedFrame
    );
    if (retainedCommit.commitIdentity !== commit.commitIdentity) {
      throw new Error("Recursive fork commit identity drifted after dispatch.");
    }
    const checkpoint = checkpointFrameFromJson(retainedFrame.checkpoint);
    validateScopedGraphCheckpointFrame(
      checkpointDefinitionFor(
        deps.config,
        boundaryFor(deps.config, forkNode, branch)
      ),
      checkpoint
    );
    if (
      checkpoint.completed !== true ||
      checkpoint.outcome?.kind !== "normal" ||
      !branch.normalExitNodeIds.includes(checkpoint.outcome.exitNodeId)
    ) {
      throw new Error("Recursive fork retained outcome is not normal completion.");
    }
    for (const nodeId of checkpoint.completedNodeIds) {
      if (!outerFrame.completedNodeIds.includes(nodeId)) {
        outerFrame.completedNodeIds.push(nodeId);
      }
    }
    children.push({
      childScopeId: retainedFrame.childScopeId,
      frameIdentity: retainedFrame.frameIdentity,
      commitIdentity: retainedCommit.commitIdentity,
      normalExitNodeId: checkpoint.outcome.exitNodeId,
    });
  }

  return {
    receipt: {
      schema: "dzupagent.pipelineRecursiveForkCompletion/v1",
      definitionDigest: digestPipelineDefinition(deps.config.definition),
      ownerPath: [...plan.ownerPath],
      forkNodeId: forkNode.id,
      forkId: forkNode.forkId,
      joinNodeId: graph.joinNodeId,
      parentCommitIdentity: plan.parentCommitIdentity,
      mergeIdentity: outcome.merge.mergeIdentity,
      childCommitIdentities: children
        .map((child) => child.commitIdentity)
        .sort(),
      children,
    },
  };
}
