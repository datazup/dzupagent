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

export interface FlowExpressionAnalysis {
  deterministic: boolean;
  refs: string[];
  warnings: string[];
}

export * from "./reference-expression.js";
