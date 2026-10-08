/**
 * v2-pipeline-approval.ts — a V2 `policy.requireApproval` suspends a
 * `PipelineRuntime` run for a recorded decision
 * (DZA-DSL-V2-EXECUTOR-S5-20261008-PO, S5-P option C).
 *
 * Runs after `applyPipelinePolicies`. Each node it marked with
 * `executionPolicy.requireApproval` gets an approval gate in front of it,
 * using the runtime's existing interaction protocol: the run suspends at the
 * gate with a pending interaction, and `PipelineRuntime.resumeInteraction`
 * continues on the recorded decision. `approved` runs the step under its
 * remaining budget/timeout policy. `rejected` goes to a sink node that keeps
 * `requireApproval`, so the runtime fails the run before it (fail closed) and
 * the step and everything after it never run.
 *
 * @module compile-orchestrator/v2-pipeline-approval
 */

import { createPipelineInteractionSpecV1 } from "@dzupagent/runtime-contracts";
import type {
  ConditionalEdge,
  GateNode,
  NodeExecutionPolicy,
  PipelineEdge,
  PipelineNode,
  TransformNode,
} from "@dzupagent/runtime-contracts/pipeline-artifact";

interface MutableArtifact {
  schemaVersion?: string;
  entryNodeId?: string;
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
}

/**
 * Insert an approval gate in front of every node whose execution policy
 * requires approval, in place. Returns the inserted gate ids.
 */
export function insertPipelineApprovalGates(artifact: unknown): string[] {
  const definition = artifact as MutableArtifact;
  const nodes = definition.nodes ?? [];
  const edges = definition.edges ?? [];
  const targets = nodes.filter(
    (node) => node.executionPolicy?.requireApproval === true,
  );
  const gateIds: string[] = [];
  for (const step of targets) {
    const gateId = `${step.id}__approval`;
    const rejectedId = `${step.id}__approval_rejected`;
    const authoredPath = step.source?.path ?? step.id;

    // Every way into the step now goes through the gate.
    for (const edge of edges) {
      if (edge.type === "conditional") {
        for (const [key, target] of Object.entries(edge.branches)) {
          if (target === step.id) edge.branches[key] = gateId;
        }
      } else if (edge.targetNodeId === step.id) {
        edge.targetNodeId = gateId;
      }
    }
    if (definition.entryNodeId === step.id) definition.entryNodeId = gateId;

    const gate: GateNode = {
      id: gateId,
      type: "gate",
      gateType: "approval",
      name: `approval:${authoredPath}`,
      condition: `Approve step "${step.source?.nodeId ?? step.id}"?`,
      interaction: createPipelineInteractionSpecV1({
        kind: "approval",
        authoredNodeId: gateId,
        authoredPath: `${authoredPath}.policy.requireApproval`,
        question: `Approve step "${step.source?.nodeId ?? step.id}"?`,
        choices: [],
        outcomeToSuccessor: { approved: step.id, rejected: rejectedId },
        requestSchema: { kind: "approval", decisions: ["approved", "rejected"] },
      }),
    };
    // Never executed: the runtime fails the run before an approval-required
    // node runs, which is the terminal outcome of a rejection.
    const rejected: TransformNode = {
      id: rejectedId,
      type: "transform",
      name: `approval-rejected:${authoredPath}`,
      transformName: "dzupflow.v2.approval-rejected",
      executionPolicy: { requireApproval: true },
    };
    const decision: ConditionalEdge = {
      type: "conditional",
      sourceNodeId: gateId,
      predicateName: `approval__${gateId}__predicate`,
      branches: { approved: step.id, rejected: rejectedId },
    };

    const remaining = withoutApproval(step.executionPolicy);
    if (remaining === undefined) delete step.executionPolicy;
    else step.executionPolicy = remaining;

    nodes.splice(nodes.indexOf(step), 0, gate);
    nodes.push(rejected);
    edges.push(decision);
    gateIds.push(gateId);
  }
  if (gateIds.length > 0) definition.schemaVersion = "1.1.0";
  return gateIds;
}

function withoutApproval(
  policy: NodeExecutionPolicy | undefined,
): NodeExecutionPolicy | undefined {
  if (policy === undefined) return undefined;
  const { requireApproval: _approval, ...rest } = policy;
  return Object.keys(rest).length === 0 ? undefined : rest;
}
