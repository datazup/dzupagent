import type {
  PipelineCheckpoint,
  PipelineEdge,
  PipelineNode,
  PipelineRecursiveForkCompletionV1,
} from "@dzupagent/core/pipeline";
import { digestPipelineDefinition } from "@dzupagent/runtime-contracts";
import { mergeRecursiveScopedCommitsV1 } from "@dzupagent/runtime-contracts/recursive-scope";

import { findAdmittedRecursiveForkGraph } from "../loop-executor/definition-validation/graph-helpers.js";
import {
  parseRecursiveStoredCommitV1,
  parseRecursiveStoredFrameV1,
} from "../recursive-scope/durable-child.js";
import { materializeRecursiveBranchPlanV1 } from "../recursive-scope/index.js";
import { validateScopedGraphCheckpointFrame } from "../scoped-graph/validate-scoped-graph-frame.js";
import type { PipelineRuntimeConfig } from "../pipeline-runtime-types.js";
import { getNextNodeIds } from "./edge-resolution.js";
import {
  boundaryFor,
  checkpointDefinitionFor,
  checkpointFrameFromJson,
  planFor,
} from "./recursive-fork-runtime.js";

export function definitionHasRecursiveFork(
  config: Pick<PipelineRuntimeConfig, "definition">
): boolean {
  const nodeMap = new Map<string, PipelineNode>(
    config.definition.nodes.map((node) => [node.id, node])
  );
  return config.definition.nodes.some((node) => {
    if (node.type !== "fork") return false;
    const join = config.definition.nodes.find(
      (candidate) => candidate.type === "join" && candidate.forkId === node.forkId
    );
    if (join?.type !== "join") return false;
    return (
      findAdmittedRecursiveForkGraph(
        node.id,
        join.id,
        nodeMap,
        config.definition.edges
      ) !== undefined
    );
  });
}

function failReceipt(detail: string): never {
  throw new Error(`Corrupt recursive fork completion receipt: ${detail}`);
}

/** Validate retained parent and child custody before resume can dispatch. */
export async function validateRecursiveForkCompletionReceipts(
  config: PipelineRuntimeConfig,
  checkpoint: PipelineCheckpoint
): Promise<void> {
  const receipts = Object.entries(checkpoint.recursiveForkCompletions ?? {});
  if (receipts.length === 0) return;
  const durable = config.recursiveFork?.durable;
  if (durable === undefined) {
    failReceipt("recursive durable custody is unavailable");
  }
  const nodeMap = new Map<string, PipelineNode>(
    config.definition.nodes.map((node) => [node.id, node])
  );
  const outgoingEdges = new Map<string, PipelineEdge[]>();
  for (const node of config.definition.nodes) outgoingEdges.set(node.id, []);
  for (const edge of config.definition.edges) {
    if (edge.type !== "error") outgoingEdges.get(edge.sourceNodeId)?.push(edge);
  }
  const definitionDigest = digestPipelineDefinition(config.definition);

  for (const [forkNodeId, receipt] of receipts) {
    const forkNode = nodeMap.get(forkNodeId);
    if (forkNode?.type !== "fork") failReceipt(`fork "${forkNodeId}" is missing`);
    const joinNode = config.definition.nodes.find(
      (node) => node.type === "join" && node.forkId === forkNode.forkId
    );
    if (joinNode?.type !== "join") {
      failReceipt(`join for fork "${forkNodeId}" is missing`);
    }
    const graph = findAdmittedRecursiveForkGraph(
      forkNode.id,
      joinNode.id,
      nodeMap,
      config.definition.edges
    );
    if (graph === undefined) {
      failReceipt(`fork "${forkNodeId}" no longer has the admitted shape`);
    }
    const plan = materializeRecursiveBranchPlanV1(
      planFor(config, forkNode, graph, checkpoint.pipelineRunId)
    );
    if (
      receipt.schema !== "dzupagent.pipelineRecursiveForkCompletion/v1" ||
      receipt.definitionDigest !== definitionDigest ||
      receipt.forkNodeId !== forkNode.id ||
      receipt.forkId !== forkNode.forkId ||
      receipt.joinNodeId !== joinNode.id ||
      receipt.parentCommitIdentity !== plan.parentCommitIdentity ||
      receipt.ownerPath.length !== plan.ownerPath.length ||
      receipt.ownerPath.some((entry, index) => entry !== plan.ownerPath[index])
    ) {
      failReceipt(`definition or parent binding drift at fork "${forkNodeId}"`);
    }
    if (
      !checkpoint.completedNodeIds.includes(forkNode.id) ||
      !checkpoint.completedNodeIds.includes(joinNode.id) ||
      checkpoint.forkState?.[forkNode.forkId] !== undefined
    ) {
      failReceipt(`public checkpoint boundary drift at fork "${forkNodeId}"`);
    }
    const expectedContinuation = getNextNodeIds(
      joinNode.id,
      outgoingEdges,
      config.predicates,
      checkpoint.state
    )[0];
    if (receipt.selectedContinuationNodeId !== expectedContinuation) {
      failReceipt(`continuation drift at fork "${forkNodeId}"`);
    }

    const commits = [];
    const expectedChildren: PipelineRecursiveForkCompletionV1["children"] = [];
    for (let ordinal = 0; ordinal < plan.frames.length; ordinal += 1) {
      const plannedFrame = plan.frames[ordinal]!;
      const branch = graph.branches[ordinal]!;
      const serializedFrame = await durable.loadFrame(plannedFrame.childScopeId);
      if (serializedFrame === undefined) {
        failReceipt(`child frame "${plannedFrame.childScopeId}" is missing`);
      }
      const retainedFrame = parseRecursiveStoredFrameV1(
        serializedFrame,
        plannedFrame
      );
      const serializedCommit = await durable.loadCommittedChild(
        plannedFrame.childScopeId
      );
      if (serializedCommit === undefined) {
        failReceipt(`child commit "${plannedFrame.childScopeId}" is missing`);
      }
      const commit = parseRecursiveStoredCommitV1(
        serializedCommit,
        retainedFrame
      );
      const scopedCheckpoint = checkpointFrameFromJson(retainedFrame.checkpoint);
      validateScopedGraphCheckpointFrame(
        checkpointDefinitionFor(
          config,
          boundaryFor(config, forkNode, branch)
        ),
        scopedCheckpoint
      );
      if (
        scopedCheckpoint.completed !== true ||
        scopedCheckpoint.outcome?.kind !== "normal" ||
        !branch.normalExitNodeIds.includes(scopedCheckpoint.outcome.exitNodeId)
      ) {
        failReceipt(`child outcome drift at ordinal ${ordinal}`);
      }
      commits.push(commit);
      expectedChildren.push({
        childScopeId: retainedFrame.childScopeId,
        frameIdentity: retainedFrame.frameIdentity,
        commitIdentity: commit.commitIdentity,
        normalExitNodeId: scopedCheckpoint.outcome.exitNodeId,
      });
    }
    const merge = mergeRecursiveScopedCommitsV1(commits);
    if (merge.mergeIdentity !== receipt.mergeIdentity) {
      failReceipt(`merge identity drift at fork "${forkNodeId}"`);
    }
    const expectedCommitIdentities = expectedChildren
      .map((child) => child.commitIdentity)
      .sort();
    if (
      receipt.childCommitIdentities.length !== expectedCommitIdentities.length ||
      receipt.childCommitIdentities.some(
        (identity, index) => identity !== expectedCommitIdentities[index]
      ) ||
      receipt.children.length !== expectedChildren.length ||
      receipt.children.some((child, index) => {
        const expected = expectedChildren[index];
        return (
          expected === undefined ||
          child.childScopeId !== expected.childScopeId ||
          child.frameIdentity !== expected.frameIdentity ||
          child.commitIdentity !== expected.commitIdentity ||
          child.normalExitNodeId !== expected.normalExitNodeId
        );
      })
    ) {
      failReceipt(`child aggregate drift at fork "${forkNodeId}"`);
    }
  }
}
