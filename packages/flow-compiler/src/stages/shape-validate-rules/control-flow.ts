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
import { validateForEachAdmission } from "./for-each-admission.js";

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
    errors.push(...validateForEachAdmission(node, path));
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
      const branchPath = `${path}.branches[${bIdx}]`;
      const interaction = findParallelInteraction(
        branch,
        branchPath
      );
      if (interaction !== undefined) {
        errors.push({
          nodeType: interaction.node.type,
          nodePath: interaction.path,
          code: "PARALLEL_INTERACTION_UNSUPPORTED",
          category: "control",
          message:
            `${interaction.node.type} cannot be nested under parallel until ` +
            "the fork scheduler has a durable branch-local interaction frame",
        });
      } else {
        const boundary = findParallelControlBoundary(branch, branchPath);
        if (boundary !== undefined) {
          const isTerminal = boundary.node.type === "complete";
          errors.push({
            nodeType: boundary.node.type,
            nodePath: boundary.path,
            code: isTerminal
              ? "PARALLEL_TERMINAL_UNSUPPORTED"
              : "PARALLEL_SUSPENSION_UNSUPPORTED",
            category: "control",
            message: isTerminal
              ? "complete cannot be nested under parallel until terminal branch ownership, sibling suppression, merge suppression, and outer-continuation suppression are durable"
              : `${boundary.node.type} cannot be nested under parallel until the fork scheduler has an exact branch-owned suspension cursor`,
          });
        } else {
          const recursiveControl = findParallelRecursiveControl(
            branch,
            branchPath
          );
          if (recursiveControl !== undefined) {
            errors.push({
              nodeType: recursiveControl.node.type,
              nodePath: recursiveControl.path,
              code: "PARALLEL_RECURSIVE_CONTROL_UNSUPPORTED",
              category: "control",
              message:
                `${recursiveControl.node.type} cannot be nested under parallel while ` +
                "fork branches use the leaf-only worker; admission requires a definition-bound durable branch frame and canonical recursive dispatcher",
            });
          }
        }
      }
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
    } else {
      errors.push(
        missing(
          node.type,
          path,
          "approval.onReject is required for checkpoint-bound interaction admission"
        )
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
    const parallel = findNestedParallel(node.body, `${path}.body`);
    if (parallel !== undefined) {
      errors.push({
        nodeType: parallel.node.type,
        nodePath: parallel.path,
        code: "PARALLEL_ERROR_PROPAGATION_UNSUPPORTED",
        category: "control",
        message:
          "parallel cannot be nested in a try_catch body until fork branch failures propagate through the authored catch instead of being isolated by the leaf-only fork worker",
      });
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

function findNestedParallel(
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

type ParallelBoundaryNode = Extract<
  FlowNode,
  { type: "complete" | "persona" | "route" }
>;

/**
 * Find control boundaries whose meaning cannot cross the current fork worker.
 * Interactions are handled separately so they retain the Packet 24-A-specific
 * diagnostic and exact nested path.
 */
function findParallelControlBoundary(
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

type ParallelRecursiveControlNode = Extract<
  FlowNode,
  { type: "branch" | "parallel" | "try_catch" | "for_each" | "loop" }
>;

/**
 * The current fork worker walks a flat branch and cannot recursively dispatch
 * graph control. Keep those shapes out of every compiler entry point until a
 * durable branch-local graph frame exists.
 */
function findParallelRecursiveControl(
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

function findParallelInteraction(
  nodes: readonly FlowNode[],
  parentPath: string
): { node: Extract<FlowNode, { type: "approval" | "clarification" }>; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (node.type === "approval" || node.type === "clarification") {
      return { node, path };
    }

    let childGroups: Array<{ nodes: readonly FlowNode[]; path: string }> = [];
    switch (node.type) {
      case "sequence":
        childGroups = [{ nodes: node.nodes, path: `${path}.nodes` }];
        break;
      case "for_each":
      case "persona":
      case "route":
      case "loop":
        childGroups = [{ nodes: node.body, path: `${path}.body` }];
        break;
      case "branch":
        childGroups = [
          { nodes: node.then, path: `${path}.then` },
          ...(node.else === undefined
            ? []
            : [{ nodes: node.else, path: `${path}.else` }]),
        ];
        break;
      case "try_catch":
        childGroups = [
          { nodes: node.body, path: `${path}.body` },
          { nodes: node.catch, path: `${path}.catch` },
        ];
        break;
      case "parallel":
        // Its own validator owns the exact nested fork diagnostic.
        continue;
      default:
        continue;
    }
    for (const childGroup of childGroups) {
      const interaction = findParallelInteraction(
        childGroup.nodes,
        childGroup.path
      );
      if (interaction !== undefined) return interaction;
    }
  }
  return undefined;
}

const STRUCTURED_TYPED_LOOP_BODY_TYPES = new Set<FlowNode["type"]>([
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
      (node.type === "approval" || node.type === "clarification")
    ) {
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
    } else if (node.type === "approval") {
      childGroups.push(node.onApprove);
      childPaths.push(`${path}.onApprove`);
      if (node.onReject !== undefined) {
        childGroups.push(node.onReject);
        childPaths.push(`${path}.onReject`);
      }
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
