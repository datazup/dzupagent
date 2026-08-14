import {
  FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  isFlowTypedCondition,
} from "../expressions.js";
import type { FlowNode } from "../types.js";
import { joinPath } from "../validation-helpers.js";
import { describeJsType } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue, ValidateNodeArray } from "./shared.js";

export function validateLoop(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
  validateNodeArray: ValidateNodeArray
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);
  const condition = obj["condition"];
  if (typeof condition !== "string" || condition.length === 0) {
    issues.push({
      path: joinPath(path, "condition"),
      code: "MISSING_REQUIRED_FIELD",
      message: `loop.condition is required (non-empty string), received ${describeJsType(
        condition
      )}`,
    });
    return null;
  }
  const typedCondition = obj["typedCondition"];
  let ok = true;
  if (typedCondition !== undefined && !isFlowTypedCondition(typedCondition)) {
    issues.push({
      path: joinPath(path, "typedCondition"),
      code: "INVALID_CONDITION",
      message: "loop.typedCondition must be a canonical FlowTypedCondition",
    });
    ok = false;
  }
  if (
    typedCondition !== undefined &&
    condition !== FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW
  ) {
    issues.push({
      path: joinPath(path, "condition"),
      code: "INVALID_CONDITION",
      message: `loop.condition must equal "${FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW}" when typedCondition is present`,
    });
    ok = false;
  }
  const body = validateNodeArray(obj["body"], joinPath(path, "body"), issues);
  if (body === null) return null;
  if (!ok) return null;
  if (body.length === 0) {
    issues.push({
      path,
      code: "EMPTY_BODY",
      message: "loop.body must contain at least one node",
    });
  }
  const node: FlowNode = { type: "loop", ...common, condition, body };
  if (isFlowTypedCondition(typedCondition))
    node.typedCondition = typedCondition;
  if (typeof obj["maxIterations"] === "number")
    node.maxIterations = obj["maxIterations"];
  const onExhausted = obj["onExhausted"];
  if (onExhausted === "fail" || onExhausted === "continue") {
    node.onExhausted = onExhausted;
  } else if (onExhausted !== undefined) {
    issues.push({
      path: joinPath(path, "onExhausted"),
      code: "INVALID_ENUM_VALUE",
      message: `loop.onExhausted must be "fail" or "continue" when present, received ${describeJsType(
        onExhausted
      )}`,
    });
    return null;
  }
  const iterationTimeoutMs = obj["iterationTimeoutMs"];
  if (
    typeof iterationTimeoutMs === "number" &&
    Number.isInteger(iterationTimeoutMs) &&
    iterationTimeoutMs > 0
  ) {
    node.iterationTimeoutMs = iterationTimeoutMs;
  } else if (iterationTimeoutMs !== undefined) {
    issues.push({
      path: joinPath(path, "iterationTimeoutMs"),
      code: "WRONG_FIELD_TYPE",
      message: `loop.iterationTimeoutMs must be a positive integer when present, received ${describeJsType(
        iterationTimeoutMs
      )}`,
    });
    return null;
  }
  const iterationBudgetCents = obj["iterationBudgetCents"];
  if (
    typeof iterationBudgetCents === "number" &&
    Number.isFinite(iterationBudgetCents) &&
    iterationBudgetCents > 0
  ) {
    node.iterationBudgetCents = iterationBudgetCents;
  } else if (iterationBudgetCents !== undefined) {
    issues.push({
      path: joinPath(path, "iterationBudgetCents"),
      code: "WRONG_FIELD_TYPE",
      message: `loop.iterationBudgetCents must be a positive finite number when present, received ${describeJsType(
        iterationBudgetCents
      )}`,
    });
    return null;
  }
  const progressKey = obj["progressKey"];
  if (typeof progressKey === "string" && progressKey.length > 0)
    node.progressKey = progressKey;
  return node;
}
