import type {
  FlowExpression,
  FlowExpressionAnalysis,
} from "@dzupagent/flow-ast";

function isFlowExpression(value: unknown): value is FlowExpression {
  return Boolean(
    value &&
      typeof value === "object" &&
      ("op" in value || "exprJs" in value),
  );
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

  const nested = childExpressions(expr)
    .filter(isFlowExpression)
    .map(analyzeFlowExpression);

  return {
    deterministic: nested.every((item) => item.deterministic),
    refs: [...new Set(nested.flatMap((item) => item.refs))],
    warnings: [...new Set(nested.flatMap((item) => item.warnings))],
  };
}
