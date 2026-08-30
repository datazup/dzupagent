/**
 * Canonical child-node traversal contract for the flow AST.
 *
 * This module is the ONE statement of which fields carry child nodes. Every
 * traversal — typed walks over the canonical `FlowNode` union and untyped
 * walks over raw (pre-validation) documents — must derive its key set from
 * these constants instead of hand-copying a list. Hand-copied lists drifted
 * into six divergent variants and silently skipped subtrees (approval
 * branches, catch handlers, parallel branch contents — the mechanism behind
 * finding ARCH-M-10 / ARCH27-N-18's diagnostics gaps).
 *
 * Digest-feeding traversals (capability-manifest hashing, classification
 * envelopes) deliberately keep their own iteration code: their visit ORDER is
 * load-bearing for persisted hashes and must not change when this list gains
 * a field. They may still pin their key MEMBERSHIP against these constants.
 */
import type { FlowNode } from "./types.js";

/**
 * Fields of the canonical FlowNode union whose value is `FlowNode[]`:
 * sequence.nodes; for_each/persona/route/loop/try_catch.body; branch.then and
 * branch.else; approval.onApprove and approval.onReject; try_catch.catch.
 * `parallel.branches` is excluded — it is the one `FlowNode[][]` container
 * and is listed separately as FLOW_BRANCH_CONTAINER_FIELD.
 */
export const FLOW_CHILD_NODE_FIELDS = [
  "nodes",
  "body",
  "then",
  "else",
  "onApprove",
  "onReject",
  "catch",
] as const;

export type FlowChildNodeField = (typeof FLOW_CHILD_NODE_FIELDS)[number];

/** The single `FlowNode[][]` container: parallel.branches. */
export const FLOW_BRANCH_CONTAINER_FIELD = "branches" as const;

/**
 * Every child-bearing field including `branches` — for membership checks
 * (e.g. "skip child containers when scanning a node's scalar entries").
 */
export const FLOW_CHILD_CONTAINER_FIELDS = [
  ...FLOW_CHILD_NODE_FIELDS,
  FLOW_BRANCH_CONTAINER_FIELD,
] as const;

/**
 * Raw/authoring documents additionally nest node arrays under `steps` (the
 * document-root container that lowering rewrites to canonical fields).
 */
export const RAW_STEP_CONTAINER_FIELD = "steps" as const;

/**
 * Child-node fields for walks over raw (pre-validation) values. Order keeps
 * `steps` beside `nodes` to preserve the warning order of pre-existing raw
 * walks that listed the fields this way.
 */
export const RAW_CHILD_NODE_FIELDS = [
  "nodes",
  RAW_STEP_CONTAINER_FIELD,
  "body",
  "then",
  "else",
  "onApprove",
  "onReject",
  "catch",
] as const;

/**
 * Snake_case approval-branch spellings accepted by the authoring dialect,
 * mapped to their canonical field. Walks do NOT follow these — normalize
 * first; they are exported for normalizers and authoring-dialect field sets.
 */
export const RAW_SNAKE_CASE_CHILD_FIELD_ALIASES = Object.freeze({
  on_approve: "onApprove",
  on_reject: "onReject",
} as const);

export type FlowNodeVisitor = (node: FlowNode, path: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A child-node array of a flow node, with the path suffix that reaches it. */
export interface FlowChildArray {
  nodes: FlowNode[];
  /** Path suffix relative to the parent node, e.g. `body` or `branches[0]`. */
  suffix: string;
}

/**
 * The child-node arrays of a canonical flow node, in FLOW_CHILD_NODE_FIELDS
 * order, followed by parallel branches as `branches[i]` entries. Absent
 * optional containers (`branch.else`, `approval.onReject`) are omitted, not
 * returned as empty arrays — no traversal distinguishes the two.
 */
export function flowChildArrays(node: FlowNode): FlowChildArray[] {
  const record = node as unknown as Record<string, unknown>;
  const out: FlowChildArray[] = [];
  for (const field of FLOW_CHILD_NODE_FIELDS) {
    const children = record[field];
    if (!Array.isArray(children)) continue;
    out.push({ nodes: children as FlowNode[], suffix: field });
  }
  const branches = record[FLOW_BRANCH_CONTAINER_FIELD];
  if (Array.isArray(branches)) {
    branches.forEach((branch, index) => {
      if (!Array.isArray(branch)) return;
      out.push({
        nodes: branch as FlowNode[],
        suffix: `${FLOW_BRANCH_CONTAINER_FIELD}[${index}]`,
      });
    });
  }
  return out;
}

/**
 * Pre-order walk of a canonical AST subtree: visits `node`, then every child
 * under FLOW_CHILD_NODE_FIELDS in list order, then parallel branches.
 */
export function walkFlowNodes(
  node: FlowNode,
  visit: FlowNodeVisitor,
  path = "root",
): void {
  visit(node, path);
  for (const { nodes, suffix } of flowChildArrays(node)) {
    nodes.forEach((child, index) => {
      walkFlowNodes(child, visit, `${path}.${suffix}[${index}]`);
    });
  }
}

export type RawNodeVisitor = (
  node: Record<string, unknown>,
  path: string,
) => void;

/**
 * Pre-order walk of a raw (pre-validation) subtree. Follows array children
 * and single-object children under RAW_CHILD_NODE_FIELDS, and `branches`
 * both in its canonical `FlowNode[][]` shape and as a plain array of node
 * objects. Non-object leaves are ignored. Snake_case aliases are not
 * followed (see RAW_SNAKE_CASE_CHILD_FIELD_ALIASES).
 */
export function walkRawNodes(
  value: unknown,
  visit: RawNodeVisitor,
  path = "root",
): void {
  if (!isRecord(value)) return;
  visit(value, path);
  for (const field of RAW_CHILD_NODE_FIELDS) {
    const child = value[field];
    if (Array.isArray(child)) {
      child.forEach((entry, index) => {
        walkRawNodes(entry, visit, `${path}.${field}[${index}]`);
      });
    } else if (isRecord(child)) {
      walkRawNodes(child, visit, `${path}.${field}`);
    }
  }
  const branches = value[FLOW_BRANCH_CONTAINER_FIELD];
  if (Array.isArray(branches)) {
    branches.forEach((branch, branchIndex) => {
      if (Array.isArray(branch)) {
        branch.forEach((entry, index) => {
          walkRawNodes(
            entry,
            visit,
            `${path}.${FLOW_BRANCH_CONTAINER_FIELD}[${branchIndex}][${index}]`,
          );
        });
      } else {
        walkRawNodes(
          branch,
          visit,
          `${path}.${FLOW_BRANCH_CONTAINER_FIELD}[${branchIndex}]`,
        );
      }
    });
  }
}
