import type { FlowNode, SequenceNode } from "./types.js";
import { joinPath } from "./validation-helpers.js";
import type { SchemaIssue } from "./validate/shared.js";

interface FlattenedNode {
  node: FlowNode;
  path: string;
  index: number;
}

/**
 * Depth-first, pre-order flatten of every node in a flow tree, tagged with
 * its document-order index. Used to check ordering constraints between
 * node types that may be nested at different depths (branch/for_each/etc).
 */
function flattenNodes(
  node: FlowNode,
  path: string,
  order: { current: number },
  out: FlattenedNode[],
): void {
  out.push({ node, path, index: order.current++ });
  const children = childArraysOf(node);
  for (const { nodes, suffix } of children) {
    nodes.forEach((child, i) => {
      flattenNodes(
        child,
        joinPath(joinPath(path, suffix), String(i)),
        order,
        out,
      );
    });
  }
}

function childArraysOf(
  node: FlowNode,
): Array<{ nodes: FlowNode[]; suffix: string }> {
  switch (node.type) {
    case "sequence":
      return [{ nodes: node.nodes, suffix: "nodes" }];
    case "for_each":
      return [{ nodes: node.body, suffix: "body" }];
    case "branch":
      return [
        { nodes: node.then, suffix: "then" },
        { nodes: node.else ?? [], suffix: "else" },
      ];
    case "approval":
      return [
        { nodes: node.onApprove, suffix: "onApprove" },
        { nodes: node.onReject ?? [], suffix: "onReject" },
      ];
    case "persona":
      return [{ nodes: node.body, suffix: "body" }];
    case "route":
      return [{ nodes: node.body, suffix: "body" }];
    case "parallel":
      return node.branches.map((b, i) => ({
        nodes: b,
        suffix: `branches[${i}]`,
      }));
    case "try_catch":
      return [
        { nodes: node.body, suffix: "body" },
        { nodes: node.catch, suffix: "catch" },
      ];
    case "loop":
      return [{ nodes: node.body, suffix: "body" }];
    default:
      return [];
  }
}

/**
 * Rejects any `spdd.arm_dispatch` node whose matching `spdd.project_plan`
 * (same `spddRunId`) does not appear earlier in document order. There is no
 * FlowRun-shaped dependency graph in flow-ast today (confirmed: every prior
 * rejection case is unknown-type / missing-field / duplicate-id) — this is
 * new, additive document-level validation specific to the spdd.* node family.
 */
export function validateSpddNodeOrdering(
  root: SequenceNode,
  path: string,
  issues: SchemaIssue[],
): void {
  const flattened: FlattenedNode[] = [];
  flattenNodes(root, path, { current: 0 }, flattened);

  const projectPlanIndexByRunId = new Map<string, number>();
  for (const { node, index } of flattened) {
    if (node.type === "spdd.project_plan") {
      const existing = projectPlanIndexByRunId.get(node.spddRunId);
      if (existing === undefined || index < existing) {
        projectPlanIndexByRunId.set(node.spddRunId, index);
      }
    }
  }

  for (const { node, path: nodePath, index } of flattened) {
    if (node.type !== "spdd.arm_dispatch") continue;
    const projectPlanIndex = projectPlanIndexByRunId.get(node.spddRunId);
    if (projectPlanIndex === undefined || projectPlanIndex >= index) {
      issues.push({
        path: nodePath,
        code: "SPDD_ORDERING_VIOLATION",
        message: `spdd.arm_dispatch (spddRunId="${node.spddRunId}") must appear after a spdd.project_plan node with the same spddRunId in document order`,
      });
    }
  }
}
