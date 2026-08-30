import { flowChildArrays } from "../node-traversal.js";
import type { FlowNode, ValidationErrorCode } from "../types.js";
import { joinPath } from "../validation-helpers.js";

export interface ValidationTraversalIssue {
  path: string;
  code: ValidationErrorCode;
  message: string;
}

export function validateCanonicalNodeIds(
  node: FlowNode,
  path: string,
  issues: ValidationTraversalIssue[],
  seen: Map<string, string>,
): void {
  if (typeof node.id !== "string" || node.id.length === 0) {
    issues.push({
      path: joinPath(path, "id"),
      code: "MISSING_REQUIRED_FIELD",
      message: "canonical document nodes must define a non-empty id",
    });
  } else {
    const priorPath = seen.get(node.id);
    if (priorPath !== undefined) {
      issues.push({
        path: joinPath(path, "id"),
        code: "DUPLICATE_NODE_ID",
        message: `duplicate node id "${node.id}" first seen at ${priorPath}`,
      });
    } else {
      seen.set(node.id, path);
    }
  }

  // Children are reached through the canonical child-array accessor, which
  // derives its key set from FLOW_CHILD_NODE_FIELDS — the union-pinned list a
  // new container field cannot bypass. The path suffixes reproduce the ones
  // this function emitted when it carried its own copy of the per-type switch
  // (`branches[i]` already includes the branch index).
  for (const { nodes, suffix } of flowChildArrays(node)) {
    nodes.forEach((child, index) => {
      validateCanonicalNodeIds(
        child,
        `${joinPath(path, suffix)}[${index}]`,
        issues,
        seen,
      );
    });
  }
}
