import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowExpression } from "@dzupagent/flow-ast/expressions";

/** Reverse a deterministic canonical condition into bounded keyed V2 syntax. */
export function reverseV2Condition(
  node: Extract<FlowNode, { type: "branch" }>
): unknown {
  if (node.typedCondition !== undefined) {
    return reverseExpression(node.typedCondition.expression);
  }
  return node.condition.length > 0 ? node.condition : undefined;
}

function reverseExpression(expression: FlowExpression): unknown {
  if ("exprJs" in expression) return undefined;
  switch (expression.op) {
    case "literal":
      return expression.value;
    case "ref":
      return { ref: expression.path };
    case "and":
    case "or":
      return {
        [expression.op === "and" ? "all" : "any"]:
          expression.args.map(reverseExpression),
      };
    case "not":
    case "exists":
      return { [expression.op]: reverseExpression(expression.arg) };
    case "empty":
      return { is_empty: reverseExpression(expression.arg) };
    case "contains":
      return {
        contains: [
          reverseExpression(expression.collection),
          reverseExpression(expression.value),
        ],
      };
    case "in":
      return {
        in: [
          reverseExpression(expression.value),
          reverseExpression(expression.collection),
        ],
      };
    default:
      return {
        [expression.op]: [
          reverseExpression(expression.left),
          reverseExpression(expression.right),
        ],
      };
  }
}
