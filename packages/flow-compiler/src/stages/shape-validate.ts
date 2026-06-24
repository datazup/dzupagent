import type { FlowNode, ValidationError } from "@dzupagent/flow-ast";

import { routeTarget } from "../route-target.js";
import { controlAndLeafValidators } from "./shape-validate-rules.js";
import { distributedValidators } from "./shape-validate-rules-distributed.js";
import type { ShapeRuleTable, VisitContext } from "./shape-validate-shared.js";

/**
 * The complete, exhaustive structural rule table, assembled from the
 * control-flow + leaf rules and the distributed/adapter rules. Typed as
 * `ShapeRuleTable` (a mapped type over `FlowNode["type"]`) so a missing or
 * extra kind across the source files is a COMPILE error — preserving the
 * exhaustiveness guarantee of the old `default: never` switch arm.
 */
const nodeValidators: ShapeRuleTable = {
  ...controlAndLeafValidators,
  ...distributedValidators,
};

/**
 * Stage 2 — Structural validation.
 *
 * Runs purely over the AST. Aggregates every structural defect into a single
 * ValidationError[] (no early exit). Does NOT resolve refs (Stage 3) and does
 * NOT compile to a target (Stage 4).
 *
 * Includes the OI-4 cross-stage rule: rejects `on_error`-bearing constructs in
 * flows that would route to skill-chain. The feature-bitmask preview is reused
 * from `../route-target.ts` so STAGE 2 and STAGE 4 stay in lockstep.
 *
 * RF-9 (CODE-M-08 / ARCH-M-06): the former ~36-branch `visit()` switch is now a
 * data-driven dispatch over the `nodeValidators` rule table (see
 * ./shape-validate-rules.ts). `walkOnError` is likewise data-driven over a
 * single `childSlices` table instead of a second mirror switch.
 */
export function validateShape(ast: FlowNode): ValidationError[] {
  const errors: ValidationError[] = [];
  visit(ast, "root", errors);

  // OI-4: skill-chain-routed flows reject on_error anywhere.
  const { target } = routeTarget(ast);
  if (target === "skill-chain") {
    walkOnError(ast, "root", errors);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Structural dispatch — looks up the per-node-kind rule and runs it, threading
// a VisitContext that lets each rule recurse into its child slices.
// ---------------------------------------------------------------------------

function visit(node: FlowNode, path: string, errors: ValidationError[]): void {
  const ctx: VisitContext = {
    path,
    errors,
    visit: (child, childPath) => visit(child, childPath, errors),
  };
  // The rule table is exhaustive over FlowNode["type"] by construction
  // (mapped type), so this lookup is always defined. The cast aligns the
  // node-specific rule signature with the erased FlowNode argument.
  const rule = nodeValidators[node.type] as (
    n: FlowNode,
    c: VisitContext
  ) => void;
  rule(node, ctx);
}

// ---------------------------------------------------------------------------
// OI-4 walker — emits one MISSING_REQUIRED_FIELD per `on_error`-bearing node
// when the AST routes to skill-chain. Forward-compatible structural check:
// the FlowNode union does not yet declare `on_error` on any variant.
// Traversal is data-driven via the `childSlices` table below so it stays in
// lockstep with the node shapes without a second mirror switch.
// ---------------------------------------------------------------------------

function walkOnError(
  node: FlowNode,
  path: string,
  errors: ValidationError[]
): void {
  if ((node as unknown as Record<string, unknown>).on_error !== undefined) {
    errors.push({
      nodeType: node.type,
      nodePath: path,
      code: "MISSING_REQUIRED_FIELD",
      message: "on_error is only legal in pipeline-targeted flows",
    });
  }
  for (const { child, path: childPath } of childSlices(node, path)) {
    walkOnError(child, childPath, errors);
  }
}

/**
 * Enumerate the child nodes of a container node (with their paths) for the OI-4
 * walker. Leaf nodes yield nothing. Mirrors the child slices the old
 * `walkOnError` switch traversed, with identical ordering.
 */
function childSlices(
  node: FlowNode,
  path: string
): { child: FlowNode; path: string }[] {
  switch (node.type) {
    case "sequence":
      return node.nodes.map((child, idx) => ({
        child,
        path: `${path}.nodes[${idx}]`,
      }));
    case "branch": {
      const out = node.then.map((child, idx) => ({
        child,
        path: `${path}.then[${idx}]`,
      }));
      if (node.else) {
        out.push(
          ...node.else.map((child, idx) => ({
            child,
            path: `${path}.else[${idx}]`,
          }))
        );
      }
      return out;
    }
    case "parallel":
      return node.branches.flatMap((branch, bIdx) =>
        branch.map((child, idx) => ({
          child,
          path: `${path}.branches[${bIdx}][${idx}]`,
        }))
      );
    case "for_each":
      return node.body.map((child, idx) => ({
        child,
        path: `${path}.body[${idx}]`,
      }));
    case "approval": {
      const out = node.onApprove.map((child, idx) => ({
        child,
        path: `${path}.onApprove[${idx}]`,
      }));
      if (node.onReject) {
        out.push(
          ...node.onReject.map((child, idx) => ({
            child,
            path: `${path}.onReject[${idx}]`,
          }))
        );
      }
      return out;
    }
    case "persona":
    case "route":
    case "loop":
      return node.body.map((child, idx) => ({
        child,
        path: `${path}.body[${idx}]`,
      }));
    case "try_catch":
      return [
        ...node.body.map((child, idx) => ({
          child,
          path: `${path}.body[${idx}]`,
        })),
        ...node.catch.map((child, idx) => ({
          child,
          path: `${path}.catch[${idx}]`,
        })),
      ];
    case "action":
    case "clarification":
    case "complete":
    case "spawn":
    case "classify":
    case "emit":
    case "memory":
    case "set":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query":
    case "worker.dispatch":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
    case "prompt":
    case "return_to":
    case "agent":
    case "validate":
      return [];
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return [];
    }
  }
}
