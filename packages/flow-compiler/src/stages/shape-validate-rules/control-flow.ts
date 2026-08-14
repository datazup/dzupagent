import {
  FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  isFlowTypedCondition,
} from "@dzupagent/flow-ast/expressions";
import type { FlowNode } from "@dzupagent/flow-ast";

import {
  emptyBody,
  isNonEmptyString,
  missing,
  type ShapeRulePartial,
} from "../shape-validate-shared.js";

/**
 * Structural rules for the control-flow FlowNode kinds — the nodes that own
 * child slices and recurse into them via `ctx.visit`. Split out of
 * `shape-validate-rules.ts` for the ARCH-M-06 / MJ-01 god-module decomposition.
 * Each rule pushes its own EMPTY_BODY / MISSING_REQUIRED_FIELD defects.
 *
 * Pure refactor: behaviour (defect codes, messages, recursion paths) is
 * unchanged.
 */
export type ControlFlowKind =
  | "sequence"
  | "for_each"
  | "branch"
  | "parallel"
  | "approval"
  | "persona"
  | "route"
  | "try_catch"
  | "loop";

export const controlFlowValidators: ShapeRulePartial<ControlFlowKind> = {
  sequence: (node, { path, errors, visit }) => {
    if (node.nodes.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "sequence.nodes must contain at least one node"
        )
      );
    }
    node.nodes.forEach((child, idx) => visit(child, `${path}.nodes[${idx}]`));
  },
  for_each: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.source)) {
      errors.push(
        missing(
          node.type,
          path,
          "for_each.source is required (non-empty string)"
        )
      );
    }
    if (!isNonEmptyString(node.as)) {
      errors.push(
        missing(node.type, path, "for_each.as is required (non-empty string)")
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "for_each.body must contain at least one node"
        )
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  branch: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "branch.condition is required (non-empty string)"
        )
      );
    }
    if (
      node.typedCondition !== undefined &&
      !isFlowTypedCondition(node.typedCondition)
    ) {
      errors.push(
        missing(
          node.type,
          path,
          "branch.typedCondition must be a canonical FlowTypedCondition"
        )
      );
    }
    if (
      node.typedCondition !== undefined &&
      node.condition !== FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW
    ) {
      errors.push(
        missing(
          node.type,
          path,
          `branch.condition must equal "${FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW}" when typedCondition is present`
        )
      );
    }
    if (node.then.length === 0) {
      errors.push(
        emptyBody(node.type, path, "branch.then must contain at least one node")
      );
    }
    node.then.forEach((child, idx) => visit(child, `${path}.then[${idx}]`));
    if (node.else !== undefined) {
      if (node.else.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            path,
            "branch.else, when present, must contain at least one node"
          )
        );
      }
      node.else.forEach((child, idx) => visit(child, `${path}.else[${idx}]`));
    }
  },
  parallel: (node, { path, errors, visit }) => {
    if (node.branches.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "parallel.branches must contain at least one branch"
        )
      );
    }
    node.branches.forEach((branch, bIdx) => {
      if (branch.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            `${path}.branches[${bIdx}]`,
            "parallel.branches[*] must contain at least one node"
          )
        );
      }
      branch.forEach((child, idx) =>
        visit(child, `${path}.branches[${bIdx}][${idx}]`)
      );
    });
  },
  approval: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.question)) {
      errors.push(
        missing(
          node.type,
          path,
          "approval.question is required (non-empty string)"
        )
      );
    }
    if (node.onApprove.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "approval.onApprove must contain at least one node"
        )
      );
    }
    node.onApprove.forEach((child, idx) =>
      visit(child, `${path}.onApprove[${idx}]`)
    );
    if (node.onReject !== undefined) {
      if (node.onReject.length === 0) {
        errors.push(
          emptyBody(
            node.type,
            path,
            "approval.onReject, when present, must contain at least one node"
          )
        );
      }
      node.onReject.forEach((child, idx) =>
        visit(child, `${path}.onReject[${idx}]`)
      );
    }
  },
  persona: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.personaId)) {
      errors.push(
        missing(
          node.type,
          path,
          "persona.personaId is required (non-empty string)"
        )
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "persona.body must contain at least one node"
        )
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  route: (node, { path, errors, visit }) => {
    if (node.strategy === "fixed-provider") {
      if (!isNonEmptyString(node.provider)) {
        errors.push(
          missing(
            node.type,
            path,
            "route.provider is required (non-empty string) when strategy='fixed-provider'"
          )
        );
      }
    } else if (node.strategy === "capability") {
      if (!Array.isArray(node.tags) || node.tags.length === 0) {
        errors.push(
          missing(
            node.type,
            path,
            "route.tags is required (non-empty array) when strategy='capability'"
          )
        );
      }
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(node.type, path, "route.body must contain at least one node")
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
  try_catch: (node, { path, errors, visit }) => {
    if (node.body.length === 0) {
      errors.push(
        emptyBody(
          node.type,
          path,
          "try_catch.body must contain at least one node"
        )
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
    node.catch.forEach((child, idx) => visit(child, `${path}.catch[${idx}]`));
  },
  loop: (node, { path, errors, visit }) => {
    if (!isNonEmptyString(node.condition)) {
      errors.push(
        missing(
          node.type,
          path,
          "loop.condition is required (non-empty string)"
        )
      );
    }
    if (
      node.typedCondition !== undefined &&
      !isFlowTypedCondition(node.typedCondition)
    ) {
      errors.push(
        missing(
          node.type,
          path,
          "loop.typedCondition must be a canonical FlowTypedCondition"
        )
      );
    }
    if (
      node.typedCondition !== undefined &&
      node.condition !== FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW
    ) {
      errors.push(
        missing(
          node.type,
          path,
          `loop.condition must equal "${FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW}" when typedCondition is present`
        )
      );
    }
    if (
      node.maxIterations !== undefined &&
      (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0)
    ) {
      errors.push(
        missing(
          node.type,
          path,
          "loop.maxIterations must be a positive integer"
        )
      );
    }
    if (node.body.length === 0) {
      errors.push(
        emptyBody(node.type, path, "loop.body must contain at least one node")
      );
    }
    if (node.typedCondition !== undefined) {
      const unsupported = findStructuredTypedLoopBodyNode(
        node.body,
        `${path}.body`
      );
      if (unsupported !== undefined) {
        errors.push({
          nodeType: node.type,
          nodePath: unsupported.path,
          code: "STRUCTURED_TYPED_LOOP_BODY_UNSUPPORTED",
          category: "control",
          message:
            `typed loop body contains ${unsupported.node.type}, whose control-flow ` +
            "semantics are outside the admitted bounded graph-scheduler matrix",
        });
      }
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
};

const STRUCTURED_TYPED_LOOP_BODY_TYPES = new Set<FlowNode["type"]>([
  "approval",
  "clarification",
  "for_each",
  "loop",
  "persona",
  "return_to",
  "route",
  "subflow",
]);

function findStructuredTypedLoopBodyNode(
  nodes: readonly FlowNode[],
  parentPath: string,
  insideParallel = false
): { node: FlowNode; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (STRUCTURED_TYPED_LOOP_BODY_TYPES.has(node.type)) {
      return { node, path };
    }
    if (insideParallel && node.type === "complete") {
      return { node, path };
    }
    if (
      insideParallel &&
      (node.type === "branch" ||
        node.type === "parallel" ||
        node.type === "try_catch")
    ) {
      return { node, path };
    }

    const childGroups: Array<readonly FlowNode[]> = [];
    const childPaths: string[] = [];
    if (node.type === "sequence") {
      childGroups.push(node.nodes);
      childPaths.push(`${path}.nodes`);
    } else if (node.type === "branch") {
      childGroups.push(node.then);
      childPaths.push(`${path}.then`);
      if (node.else !== undefined) {
        childGroups.push(node.else);
        childPaths.push(`${path}.else`);
      }
    } else if (node.type === "parallel") {
      for (let branch = 0; branch < node.branches.length; branch += 1) {
        const branchNodes = node.branches[branch];
        if (branchNodes === undefined) continue;
        const nested = findStructuredTypedLoopBodyNode(
          branchNodes,
          `${path}.branches[${branch}]`,
          true
        );
        if (nested !== undefined) return nested;
      }
    } else if (node.type === "try_catch") {
      childGroups.push(node.body, node.catch);
      childPaths.push(`${path}.body`, `${path}.catch`);
    }

    for (let group = 0; group < childGroups.length; group += 1) {
      const nested = findStructuredTypedLoopBodyNode(
        childGroups[group]!,
        childPaths[group]!,
        insideParallel
      );
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
