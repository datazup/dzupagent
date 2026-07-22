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
    if (node.body.length === 0) {
      errors.push(
        emptyBody(node.type, path, "loop.body must contain at least one node")
      );
    }
    node.body.forEach((child, idx) => visit(child, `${path}.body[${idx}]`));
  },
};
