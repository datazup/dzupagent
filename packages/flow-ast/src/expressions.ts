/**
 * Structured expression AST — the CURRENT authoring surface for conditions.
 * Per `packages/flow-ast/EXPRESSIONS.md`, new code authors `FlowExpression`
 * / `FlowTypedCondition` values (subpath `@dzupagent/flow-ast/expressions`;
 * the AST types alone are re-exported type-only from the root barrel) and
 * evaluates them with the typed-condition-evaluator subpath.
 */

export type FlowExpression =
  | { op: "literal"; value: string | number | boolean | null }
  | { op: "ref"; path: string }
  | { op: "and" | "or"; args: FlowExpression[] }
  | { op: "not"; arg: FlowExpression }
  | {
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      left: FlowExpression;
      right: FlowExpression;
    }
  | { op: "exists" | "empty"; arg: FlowExpression }
  | { op: "contains"; collection: FlowExpression; value: FlowExpression }
  | { op: "in"; value: FlowExpression; collection: FlowExpression }
  | { exprJs: string };

/**
 * Canonical typed control condition.
 *
 * Existing hosts still consume the legacy string condition field. Until a
 * host implements this contract, a typed branch retains the fixed
 * fail-closed legacy shadow exported below.
 */
export interface FlowTypedCondition {
  readonly schema: "dzupagent.flowTypedCondition/v1";
  readonly expression: FlowExpression;
}

/** Exact host capability required before a typed condition may be evaluated. */
export const FLOW_TYPED_CONDITION_CAPABILITY =
  "flow.control.typed-condition@1" as const;

/** Legacy shadow used only to keep non-typed hosts fail closed. */
export const FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW = "false";

/** Runtime shape guard shared by parsers, validators, and compiler stages. */
export function isFlowExpression(value: unknown): value is FlowExpression {
  return isFlowExpressionNode(value, { nodes: 0 }, 0);
}

function isFlowExpressionNode(
  value: unknown,
  state: { nodes: number },
  depth: number,
): value is FlowExpression {
  state.nodes += 1;
  if (state.nodes > 256 || depth > 32) return false;
  if (!isRecord(value)) return false;
  if ("exprJs" in value) {
    return typeof value.exprJs === "string" && Object.keys(value).length === 1;
  }
  switch (value.op) {
    case "literal":
      return (
        Object.keys(value).length === 2 &&
        (value.value === null ||
          typeof value.value === "string" ||
          typeof value.value === "number" ||
          typeof value.value === "boolean")
      );
    case "ref":
      return Object.keys(value).length === 2 && typeof value.path === "string";
    case "and":
    case "or":
      return (
        Object.keys(value).length === 2 &&
        Array.isArray(value.args) &&
        value.args.length > 0 &&
        value.args.every((arg) => isFlowExpressionNode(arg, state, depth + 1))
      );
    case "not":
    case "exists":
    case "empty":
      return (
        Object.keys(value).length === 2 &&
        isFlowExpressionNode(value.arg, state, depth + 1)
      );
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return (
        Object.keys(value).length === 3 &&
        isFlowExpressionNode(value.left, state, depth + 1) &&
        isFlowExpressionNode(value.right, state, depth + 1)
      );
    case "contains":
      return (
        Object.keys(value).length === 3 &&
        isFlowExpressionNode(value.collection, state, depth + 1) &&
        isFlowExpressionNode(value.value, state, depth + 1)
      );
    case "in":
      return (
        Object.keys(value).length === 3 &&
        isFlowExpressionNode(value.value, state, depth + 1) &&
        isFlowExpressionNode(value.collection, state, depth + 1)
      );
    default:
      return false;
  }
}

/** Runtime shape guard for the canonical typed-condition bridge. */
export function isFlowTypedCondition(
  value: unknown,
): value is FlowTypedCondition {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.schema === "dzupagent.flowTypedCondition/v1" &&
    isFlowExpression(value.expression)
  );
}

export interface FlowExpressionAnalysis {
  deterministic: boolean;
  refs: string[];
  warnings: string[];
}

export * from "./reference-expression.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
