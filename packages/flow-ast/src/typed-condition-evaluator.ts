import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  isFlowTypedCondition,
  type FlowExpression,
  type FlowTypedCondition,
} from "./expressions.js";
import type {
  FlowTypedConditionEvaluationOptions,
  FlowTypedConditionEvaluationResult,
} from "./typed-condition-evaluator/contracts.js";
import {
  MISSING_VALUE,
  describeValue,
  failure,
  type EvaluationFailure,
  type MissingValue,
  type ValueResult,
} from "./typed-condition-evaluator/internal.js";
import { evaluateTypedConditionReference } from "./typed-condition-evaluator/reference.js";
import {
  evaluateTypedConditionEmpty,
  structurallyEqualTypedConditionValues,
} from "./typed-condition-evaluator/value.js";

export { FLOW_TYPED_CONDITION_CAPABILITY } from "./expressions.js";
export type {
  FlowTypedConditionEvaluationErrorCode,
  FlowTypedConditionEvaluationOptions,
  FlowTypedConditionEvaluationResult,
} from "./typed-condition-evaluator/contracts.js";

/**
 * Provider-free evaluator for the canonical typed-condition contract.
 *
 * This function has no I/O or target activation authority. A host must
 * explicitly advertise the exact typed-condition capability on every call.
 * Invalid shapes, raw JavaScript, missing required values, incompatible
 * runtime types, and unsupported values fail closed as structured results.
 */
export function evaluateFlowTypedCondition(
  condition: FlowTypedCondition | unknown,
  options: FlowTypedConditionEvaluationOptions,
): FlowTypedConditionEvaluationResult {
  if (!options.hostCapabilities.includes(FLOW_TYPED_CONDITION_CAPABILITY)) {
    return failure(
      "TYPED_CONDITION_CAPABILITY_REQUIRED",
      `host must explicitly advertise "${FLOW_TYPED_CONDITION_CAPABILITY}" before evaluating typed conditions`,
      "condition",
    );
  }
  if (!isFlowTypedCondition(condition)) {
    return failure(
      "INVALID_TYPED_CONDITION",
      "typed condition does not match dzupagent.flowTypedCondition/v1",
      "condition",
    );
  }

  const resolvedReferences: string[] = [];
  const evaluated = evaluateExpression(
    condition.expression,
    options.bindings,
    "condition.expression",
    resolvedReferences,
  );
  if (!evaluated.ok) return evaluated;
  if (evaluated.value === MISSING_VALUE) {
    return failure(
      "TYPED_REFERENCE_MISSING",
      "typed condition resolved to a missing value",
      "condition.expression",
    );
  }
  if (typeof evaluated.value !== "boolean") {
    return failure(
      "TYPED_CONDITION_TYPE_MISMATCH",
      `typed condition must evaluate to boolean; received ${describeValue(evaluated.value)}`,
      "condition.expression",
    );
  }
  return {
    ok: true,
    value: evaluated.value,
    resolvedReferences: Object.freeze([...new Set(resolvedReferences)]),
  };
}

function evaluateExpression(
  expression: FlowExpression,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
): ValueResult {
  if ("exprJs" in expression) {
    return failure(
      "RAW_JS_EXPRESSION_FORBIDDEN",
      "raw JavaScript is forbidden in typed-condition evaluation",
      path,
    );
  }

  switch (expression.op) {
    case "literal":
      if (
        typeof expression.value === "number" &&
        !Number.isFinite(expression.value)
      ) {
        return failure(
          "TYPED_CONDITION_VALUE_UNSUPPORTED",
          "typed-condition numeric literals must be finite",
          `${path}.value`,
        );
      }
      return { ok: true, value: expression.value };
    case "ref":
      return evaluateTypedConditionReference(
        expression.path,
        bindings,
        `${path}.path`,
        resolvedReferences,
      );
    case "and":
      return evaluateBooleanList(
        expression.args,
        bindings,
        path,
        resolvedReferences,
        true,
      );
    case "or":
      return evaluateBooleanList(
        expression.args,
        bindings,
        path,
        resolvedReferences,
        false,
      );
    case "not": {
      const value = evaluateExpression(
        expression.arg,
        bindings,
        `${path}.arg`,
        resolvedReferences,
      );
      if (!value.ok) return value;
      const boolean = requireBoolean(value.value, `${path}.arg`);
      return boolean.ok ? { ok: true, value: !boolean.value } : boolean;
    }
    case "exists": {
      const value = evaluateExpression(
        expression.arg,
        bindings,
        `${path}.arg`,
        resolvedReferences,
      );
      if (!value.ok) return value;
      return {
        ok: true,
        value:
          value.value !== MISSING_VALUE &&
          value.value !== null &&
          value.value !== undefined,
      };
    }
    case "empty": {
      const value = evaluateExpression(
        expression.arg,
        bindings,
        `${path}.arg`,
        resolvedReferences,
      );
      return value.ok
        ? evaluateTypedConditionEmpty(value.value, `${path}.arg`)
        : value;
    }
    case "eq":
    case "ne": {
      const pair = evaluatePair(
        expression.left,
        expression.right,
        bindings,
        path,
        resolvedReferences,
      );
      if (!pair.ok) return pair;
      const equal = structurallyEqualTypedConditionValues(
        pair.left,
        pair.right,
        path,
      );
      if (!equal.ok) return equal;
      return {
        ok: true,
        value: expression.op === "eq" ? equal.value : !equal.value,
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return evaluateOrderedComparison(
        expression.op,
        expression.left,
        expression.right,
        bindings,
        path,
        resolvedReferences,
      );
    case "contains":
    case "in":
      return evaluateContains(
        expression.collection,
        expression.value,
        bindings,
        path,
        resolvedReferences,
      );
  }
}

function evaluateBooleanList(
  expressions: readonly FlowExpression[],
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
  identity: boolean,
): ValueResult {
  let result = identity;
  for (let index = 0; index < expressions.length; index += 1) {
    const value = evaluateExpression(
      expressions[index]!,
      bindings,
      `${path}.args[${index}]`,
      resolvedReferences,
    );
    if (!value.ok) return value;
    const boolean = requireBoolean(value.value, `${path}.args[${index}]`);
    if (!boolean.ok) return boolean;
    result = identity ? result && boolean.value : result || boolean.value;
    if (identity ? !result : result) break;
  }
  return { ok: true, value: result };
}

function evaluateOrderedComparison(
  operator: "gt" | "gte" | "lt" | "lte",
  leftExpression: FlowExpression,
  rightExpression: FlowExpression,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
): ValueResult {
  const pair = evaluatePair(
    leftExpression,
    rightExpression,
    bindings,
    path,
    resolvedReferences,
  );
  if (!pair.ok) return pair;
  if (
    (typeof pair.left !== "number" && typeof pair.left !== "string") ||
    typeof pair.left !== typeof pair.right ||
    (typeof pair.left === "number" &&
      (!Number.isFinite(pair.left) ||
        !Number.isFinite(pair.right as number)))
  ) {
    return failure(
      "TYPED_CONDITION_TYPE_MISMATCH",
      `${operator} requires matching finite numbers or strings`,
      path,
    );
  }
  const comparison =
    typeof pair.left === "number"
      ? pair.left - (pair.right as number)
      : pair.left < (pair.right as string)
        ? -1
        : pair.left > (pair.right as string)
          ? 1
          : 0;
  return {
    ok: true,
    value:
      operator === "gt"
        ? comparison > 0
        : operator === "gte"
          ? comparison >= 0
          : operator === "lt"
            ? comparison < 0
            : comparison <= 0,
  };
}

function evaluatePair(
  leftExpression: FlowExpression,
  rightExpression: FlowExpression,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
):
  | { readonly ok: true; readonly left: unknown; readonly right: unknown }
  | EvaluationFailure {
  const left = evaluateExpression(
    leftExpression,
    bindings,
    `${path}.left`,
    resolvedReferences,
  );
  if (!left.ok) return left;
  const right = evaluateExpression(
    rightExpression,
    bindings,
    `${path}.right`,
    resolvedReferences,
  );
  if (!right.ok) return right;
  if (left.value === MISSING_VALUE || right.value === MISSING_VALUE) {
    return failure(
      "TYPED_REFERENCE_MISSING",
      "comparison operand resolved to a missing value",
      path,
    );
  }
  return { ok: true, left: left.value, right: right.value };
}

function evaluateContains(
  collectionExpression: FlowExpression,
  valueExpression: FlowExpression,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
): ValueResult {
  const collection = evaluateExpression(
    collectionExpression,
    bindings,
    `${path}.collection`,
    resolvedReferences,
  );
  if (!collection.ok) return collection;
  const value = evaluateExpression(
    valueExpression,
    bindings,
    `${path}.value`,
    resolvedReferences,
  );
  if (!value.ok) return value;
  if (collection.value === MISSING_VALUE || value.value === MISSING_VALUE) {
    return failure(
      "TYPED_REFERENCE_MISSING",
      "membership operand resolved to a missing value",
      path,
    );
  }
  if (
    typeof collection.value === "string" &&
    typeof value.value === "string"
  ) {
    return { ok: true, value: collection.value.includes(value.value) };
  }
  if (Array.isArray(collection.value)) {
    for (const item of collection.value) {
      const equal = structurallyEqualTypedConditionValues(
        item,
        value.value,
        path,
      );
      if (!equal.ok) return equal;
      if (equal.value) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }
  return failure(
    "TYPED_CONDITION_TYPE_MISMATCH",
    "membership requires a string/string pair or an array collection",
    path,
  );
}

function requireBoolean(
  value: unknown | MissingValue,
  path: string,
):
  | { readonly ok: true; readonly value: boolean }
  | EvaluationFailure {
  if (value === MISSING_VALUE) {
    return failure(
      "TYPED_REFERENCE_MISSING",
      "boolean operand resolved to a missing value",
      path,
    );
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : failure(
        "TYPED_CONDITION_TYPE_MISMATCH",
        `boolean operand required; received ${describeValue(value)}`,
        path,
      );
}
