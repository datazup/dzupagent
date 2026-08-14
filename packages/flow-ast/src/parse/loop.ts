import {
  FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
  isFlowTypedCondition,
} from "../expressions.js";
import type { LoopNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

export function parseLoop(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): LoopNode | null {
  const conditionRaw = obj.condition;
  const typedConditionRaw = obj.typedCondition;
  const bodyRaw = obj.body;
  let failed = false;

  if (typeof conditionRaw !== "string") {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `loop.condition must be a string, received ${describeJsType(
        conditionRaw
      )}`,
      pointer: joinPointer(pointer, "condition"),
    });
    failed = true;
  }
  if (
    typedConditionRaw !== undefined &&
    !isFlowTypedCondition(typedConditionRaw)
  ) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "loop.typedCondition must be a canonical FlowTypedCondition",
      pointer: joinPointer(pointer, "typedCondition"),
    });
    failed = true;
  }
  if (
    typedConditionRaw !== undefined &&
    conditionRaw !== FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW
  ) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `loop.condition must equal "${FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW}" when typedCondition is present`,
      pointer: joinPointer(pointer, "condition"),
    });
    failed = true;
  }
  if (!Array.isArray(bodyRaw)) {
    ctx.errors.push({
      code: bodyRaw === undefined ? "WRONG_FIELD_TYPE" : "EXPECTED_ARRAY",
      message: `loop.body must be an array, received ${describeJsType(
        bodyRaw
      )}`,
      pointer: joinPointer(pointer, "body"),
    });
    failed = true;
  }

  if (failed) {
    if (Array.isArray(bodyRaw))
      ctx.parseNodeArray(bodyRaw, joinPointer(pointer, "body"), ctx);
    return null;
  }

  const body = ctx.parseNodeArray(
    bodyRaw as unknown[],
    joinPointer(pointer, "body"),
    ctx
  );
  const typedCondition = isFlowTypedCondition(typedConditionRaw)
    ? typedConditionRaw
    : undefined;
  const node: LoopNode = {
    type: "loop",
    ...parseCommonNodeFields(obj, pointer, ctx),
    condition: conditionRaw as string,
    ...(typedCondition === undefined ? {} : { typedCondition }),
    body,
  };
  if (typeof obj.maxIterations === "number")
    node.maxIterations = obj.maxIterations;
  if (obj.onExhausted === "fail" || obj.onExhausted === "continue") {
    node.onExhausted = obj.onExhausted;
  } else if (obj.onExhausted !== undefined) {
    ctx.errors.push({
      code: "INVALID_ENUM_VALUE",
      message: `loop.onExhausted must be "fail" or "continue" when present, received ${describeJsType(
        obj.onExhausted
      )}`,
      pointer: joinPointer(pointer, "onExhausted"),
    });
  }
  if (
    typeof obj.iterationTimeoutMs === "number" &&
    Number.isInteger(obj.iterationTimeoutMs) &&
    obj.iterationTimeoutMs > 0
  ) {
    node.iterationTimeoutMs = obj.iterationTimeoutMs;
  } else if (obj.iterationTimeoutMs !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `loop.iterationTimeoutMs must be a positive integer when present, received ${describeJsType(
        obj.iterationTimeoutMs
      )}`,
      pointer: joinPointer(pointer, "iterationTimeoutMs"),
    });
  }
  if (
    typeof obj.iterationBudgetCents === "number" &&
    Number.isFinite(obj.iterationBudgetCents) &&
    obj.iterationBudgetCents > 0
  ) {
    node.iterationBudgetCents = obj.iterationBudgetCents;
  } else if (obj.iterationBudgetCents !== undefined) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `loop.iterationBudgetCents must be a positive finite number when present, received ${describeJsType(
        obj.iterationBudgetCents
      )}`,
      pointer: joinPointer(pointer, "iterationBudgetCents"),
    });
  }
  if (typeof obj.progressKey === "string" && obj.progressKey.length > 0)
    node.progressKey = obj.progressKey;
  return node;
}
