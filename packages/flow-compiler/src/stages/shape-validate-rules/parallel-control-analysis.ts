import type { FlowNode } from "@dzupagent/flow-ast";

type ParallelBoundaryNode = Extract<
  FlowNode,
  { type: "complete" | "persona" | "route" }
>;

type ParallelRecursiveControlNode = Extract<
  FlowNode,
  { type: "branch" | "parallel" | "try_catch" | "for_each" | "loop" }
>;

function parallelChildGroups(
  node: FlowNode,
  path: string
): Array<{ nodes: readonly FlowNode[]; path: string }> {
  switch (node.type) {
    case "sequence":
      return [{ nodes: node.nodes, path: `${path}.nodes` }];
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return [{ nodes: node.body, path: `${path}.body` }];
    case "branch":
      return [
        { nodes: node.then, path: `${path}.then` },
        ...(node.else === undefined
          ? []
          : [{ nodes: node.else, path: `${path}.else` }]),
      ];
    case "parallel":
      return node.branches.map((branch, branchIndex) => ({
        nodes: branch,
        path: `${path}.branches[${branchIndex}]`,
      }));
    case "try_catch":
      return [
        { nodes: node.body, path: `${path}.body` },
        { nodes: node.catch, path: `${path}.catch` },
      ];
    case "approval":
      return [
        { nodes: node.onApprove, path: `${path}.onApprove` },
        ...(node.onReject === undefined
          ? []
          : [{ nodes: node.onReject, path: `${path}.onReject` }]),
      ];
    default:
      return [];
  }
}

export function findNestedParallel(
  nodes: readonly FlowNode[],
  parentPath: string
): { node: Extract<FlowNode, { type: "parallel" }>; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (node.type === "parallel") return { node, path };
    for (const childGroup of parallelChildGroups(node, path)) {
      const parallel = findNestedParallel(childGroup.nodes, childGroup.path);
      if (parallel !== undefined) return parallel;
    }
  }
  return undefined;
}

/** Find terminal and suspension boundaries that cannot cross a fork worker. */
export function findParallelControlBoundary(
  nodes: readonly FlowNode[],
  parentPath: string
): { node: ParallelBoundaryNode; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (
      node.type === "complete" ||
      node.type === "persona" ||
      node.type === "route"
    ) {
      return { node, path };
    }
    for (const childGroup of parallelChildGroups(node, path)) {
      const boundary = findParallelControlBoundary(
        childGroup.nodes,
        childGroup.path
      );
      if (boundary !== undefined) return boundary;
    }
  }
  return undefined;
}

/** W3-C5A: exactly one direct branch with two normal-only leaf arms. */
export function isAdmittedParallelConditionalBranch(
  nodes: readonly FlowNode[],
  parentPath: string
): boolean {
  if (nodes.length !== 1) return false;
  const node = nodes[0];
  if (
    node?.type !== "branch" ||
    node.then.length === 0 ||
    node.else === undefined ||
    node.else.length === 0
  ) {
    return false;
  }
  return (
    findParallelRecursiveControl(node.then, `${parentPath}[0].then`) ===
      undefined &&
    findParallelRecursiveControl(node.else, `${parentPath}[0].else`) ===
      undefined
  );
}

export function findParallelRecursiveControl(
  nodes: readonly FlowNode[],
  parentPath: string
): { node: ParallelRecursiveControlNode; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (
      node.type === "branch" ||
      node.type === "parallel" ||
      node.type === "try_catch" ||
      node.type === "for_each" ||
      node.type === "loop"
    ) {
      return { node, path };
    }
    for (const childGroup of parallelChildGroups(node, path)) {
      const control = findParallelRecursiveControl(
        childGroup.nodes,
        childGroup.path
      );
      if (control !== undefined) return control;
    }
  }
  return undefined;
}

export function findParallelInteraction(
  nodes: readonly FlowNode[],
  parentPath: string
):
  | {
      node: Extract<FlowNode, { type: "approval" | "clarification" }>;
      path: string;
    }
  | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (node.type === "approval" || node.type === "clarification") {
      return { node, path };
    }
    if (node.type === "parallel") continue;
    for (const childGroup of parallelChildGroups(node, path)) {
      const interaction = findParallelInteraction(
        childGroup.nodes,
        childGroup.path
      );
      if (interaction !== undefined) return interaction;
    }
  }
  return undefined;
}
