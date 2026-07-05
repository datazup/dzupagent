import type {
  FlowExpression,
  FlowExpressionAnalysis,
} from "@dzupagent/flow-ast";

function isFlowExpression(value: unknown): value is FlowExpression {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.exprJs === "string") return true;
  switch (record.op) {
    case "literal":
      return "value" in record;
    case "ref":
      return typeof record.path === "string";
    case "and":
    case "or":
      return Array.isArray(record.args);
    case "not":
    case "exists":
    case "empty":
      return "arg" in record;
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return "left" in record && "right" in record;
    case "contains":
      return "collection" in record && "value" in record;
    case "in":
      return "value" in record && "collection" in record;
    default:
      return false;
  }
}

function childExpressions(expr: FlowExpression): FlowExpression[] {
  if ("exprJs" in expr) return [];
  switch (expr.op) {
    case "literal":
    case "ref":
      return [];
    case "and":
    case "or":
      return expr.args;
    case "not":
    case "exists":
    case "empty":
      return [expr.arg];
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return [expr.left, expr.right];
    case "contains":
      return [expr.collection, expr.value];
    case "in":
      return [expr.value, expr.collection];
    default: {
      const _exhaustive: never = expr;
      void _exhaustive;
      return [];
    }
  }
}

export function analyzeFlowExpression(
  expr: FlowExpression,
): FlowExpressionAnalysis {
  if (!isFlowExpression(expr)) {
    return {
      deterministic: false,
      refs: [],
      warnings: ["INVALID_EXPRESSION_NODE"],
    };
  }

  if ("exprJs" in expr) {
    return {
      deterministic: false,
      refs: [],
      warnings: ["RAW_JS_EXPRESSION"],
    };
  }
  if (expr.op === "ref") {
    return { deterministic: true, refs: [expr.path], warnings: [] };
  }
  if (expr.op === "literal") {
    return { deterministic: true, refs: [], warnings: [] };
  }

  const children = childExpressions(expr);
  const invalidChildCount = children.filter(
    (child) => !isFlowExpression(child),
  ).length;
  const nested = children.filter(isFlowExpression).map(analyzeFlowExpression);

  return {
    deterministic:
      invalidChildCount === 0 && nested.every((item) => item.deterministic),
    refs: [...new Set(nested.flatMap((item) => item.refs))],
    warnings: [
      ...new Set([
        ...nested.flatMap((item) => item.warnings),
        ...(invalidChildCount > 0 ? ["INVALID_EXPRESSION_NODE"] : []),
      ]),
    ],
  };
}
