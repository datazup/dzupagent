import type { FlowNode } from "@dzupagent/flow-ast";

export interface UnsupportedTypedCondition {
  readonly path: string;
}

/**
 * Current generic targets preserve only string predicates. Typed conditions
 * are validated before this pass, then blocked before artifact emission.
 */
export function collectUnsupportedTypedConditions(
  root: FlowNode,
): UnsupportedTypedCondition[] {
  const unsupported: UnsupportedTypedCondition[] = [];
  visit(root, "root", unsupported);
  return unsupported;
}

function visit(
  node: FlowNode,
  path: string,
  unsupported: UnsupportedTypedCondition[],
): void {
  if (node.type === "branch" && node.typedCondition !== undefined) {
    unsupported.push({ path: `${path}.typedCondition` });
  }
  for (const [child, childPath] of childNodes(node, path)) {
    visit(child, childPath, unsupported);
  }
}

function childNodes(
  node: FlowNode,
  path: string,
): Array<[FlowNode, string]> {
  switch (node.type) {
    case "sequence":
      return node.nodes.map((child, index) => [
        child,
        `${path}.nodes[${index}]`,
      ]);
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return node.body.map((child, index) => [
        child,
        `${path}.body[${index}]`,
      ]);
    case "branch":
      return [
        ...node.then.map(
          (child, index) =>
            [child, `${path}.then[${index}]`] as [FlowNode, string],
        ),
        ...(node.else ?? []).map(
          (child, index) =>
            [child, `${path}.else[${index}]`] as [FlowNode, string],
        ),
      ];
    case "parallel":
      return node.branches.flatMap((branch, branchIndex) =>
        branch.map(
          (child, index) =>
            [
              child,
              `${path}.branches[${branchIndex}][${index}]`,
            ] as [FlowNode, string],
        ),
      );
    case "approval":
      return [
        ...node.onApprove.map(
          (child, index) =>
            [child, `${path}.onApprove[${index}]`] as [FlowNode, string],
        ),
        ...(node.onReject ?? []).map(
          (child, index) =>
            [child, `${path}.onReject[${index}]`] as [FlowNode, string],
        ),
      ];
    case "try_catch":
      return [
        ...node.body.map(
          (child, index) =>
            [child, `${path}.body[${index}]`] as [FlowNode, string],
        ),
        ...node.catch.map(
          (child, index) =>
            [child, `${path}.catch[${index}]`] as [FlowNode, string],
        ),
      ];
    default:
      return [];
  }
}
