import type { FlowNode, ValidationError } from "@dzupagent/flow-ast";

/**
 * Shared types and field helpers for the data-driven Stage-2 structural
 * validator (RF-9 / CODE-M-08 + ARCH-M-06). The per-node-kind rule table is
 * split across `shape-validate-rules.ts` (control-flow + leaf nodes) and
 * `shape-validate-rules-distributed.ts` (fleet / knowledge / worker / adapter
 * nodes), with both files staying under the 500-LOC ceiling. The dispatcher in
 * `shape-validate.ts` assembles them into one exhaustive table.
 */

/** Traversal context threaded through every rule. */
export interface VisitContext {
  readonly path: string;
  readonly errors: ValidationError[];
  /** Recurse into a child node, extending the current path. */
  readonly visit: (child: FlowNode, childPath: string) => void;
}

/** Narrow a FlowNode to the variant with discriminant `K`. */
export type NodeOf<K extends FlowNode["type"]> = Extract<FlowNode, { type: K }>;

/** A structural rule for one FlowNode kind. */
export type ShapeRule<K extends FlowNode["type"]> = (
  node: NodeOf<K>,
  ctx: VisitContext
) => void;

/** A partial rule table keyed by a subset of FlowNode kinds. */
export type ShapeRulePartial<K extends FlowNode["type"]> = {
  [P in K]: ShapeRule<P>;
};

/** Full rule table — one entry per FlowNode kind (exhaustive by construction). */
export type ShapeRuleTable = {
  [K in FlowNode["type"]]: ShapeRule<K>;
};

export function emptyBody(
  nodeType: FlowNode["type"],
  nodePath: string,
  message: string
): ValidationError {
  return { nodeType, nodePath, code: "EMPTY_BODY", message };
}

export function missing(
  nodeType: FlowNode["type"],
  nodePath: string,
  message: string
): ValidationError {
  return { nodeType, nodePath, code: "MISSING_REQUIRED_FIELD", message };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
