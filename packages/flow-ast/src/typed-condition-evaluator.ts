import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  isFlowTypedCondition,
  type FlowExpression,
  type FlowTypedCondition,
} from "./expressions.js";
import {
  parseFlowReferenceExpression,
  type FlowReferenceFilter,
  type ParsedFlowReference,
} from "./reference-expression.js";

export interface FlowTypedConditionEvaluationOptions {
  /** Capabilities explicitly owned by the calling host. */
  readonly hostCapabilities: readonly string[];
  /** Runtime values keyed by canonical strict reference roots. */
  readonly bindings: Readonly<Record<string, unknown>>;
}

export type FlowTypedConditionEvaluationErrorCode =
  | "TYPED_CONDITION_CAPABILITY_REQUIRED"
  | "INVALID_TYPED_CONDITION"
  | "RAW_JS_EXPRESSION_FORBIDDEN"
  | "INVALID_TYPED_REFERENCE"
  | "TYPED_REFERENCE_MISSING"
  | "TYPED_CONDITION_TYPE_MISMATCH"
  | "TYPED_CONDITION_VALUE_UNSUPPORTED";

export type FlowTypedConditionEvaluationResult =
  | {
      readonly ok: true;
      readonly value: boolean;
      readonly resolvedReferences: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: FlowTypedConditionEvaluationErrorCode;
      readonly message: string;
      readonly path: string;
    };

type EvaluationFailure = Extract<
  FlowTypedConditionEvaluationResult,
  { readonly ok: false }
>;
type MissingValue = typeof MISSING_VALUE;
type ValueResult =
  | { readonly ok: true; readonly value: unknown | MissingValue }
  | EvaluationFailure;

const MISSING_VALUE = Symbol("dzupagent.flowTypedCondition.missing");

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
      return evaluateReference(
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
      return value.ok ? evaluateEmpty(value.value, `${path}.arg`) : value;
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
      const equal = structuralEqual(pair.left, pair.right, path);
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
      const equal = structuralEqual(item, value.value, path);
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

function evaluateReference(
  source: string,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolvedReferences: string[],
): ValueResult {
  const parsed = parseFlowReferenceExpression(source, {
    policy: "strict",
    useSite: "boolean-control",
    sourcePath: path,
  });
  if (!parsed.ok || parsed.reference === undefined) {
    const detail = parsed.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("; ");
    return failure(
      "INVALID_TYPED_REFERENCE",
      detail.length > 0 ? detail : `invalid typed reference "${source}"`,
      path,
    );
  }
  resolvedReferences.push(parsed.reference.source);
  return applyReferenceFilters(
    resolveReference(parsed.reference, bindings),
    parsed.reference.filters,
    path,
  );
}

function resolveReference(
  reference: ParsedFlowReference,
  bindings: Readonly<Record<string, unknown>>,
): unknown | MissingValue {
  if (!hasOwn(bindings, reference.root)) return MISSING_VALUE;
  let value: unknown = bindings[reference.root];
  for (const segment of reference.segments) {
    if (segment.kind === "index") {
      if (!Array.isArray(value) || segment.index >= value.length) {
        return MISSING_VALUE;
      }
      value = value[segment.index];
    } else {
      if (!isObjectRecord(value) || !hasOwn(value, segment.key)) {
        return MISSING_VALUE;
      }
      value = value[segment.key];
    }
  }
  return value;
}

function applyReferenceFilters(
  initial: unknown | MissingValue,
  filters: readonly FlowReferenceFilter[],
  path: string,
): ValueResult {
  let value = initial;
  for (const filter of filters) {
    switch (filter.name) {
      case "default":
        if (
          value === MISSING_VALUE ||
          value === null ||
          value === undefined
        ) {
          value = filter.argument;
        }
        break;
      case "length":
        if (typeof value === "string" || Array.isArray(value)) {
          value = value.length;
        } else if (isObjectRecord(value)) {
          value = Object.keys(value).length;
        } else {
          return filterTypeFailure(filter.name, path);
        }
        break;
      case "upper":
      case "lower":
        if (typeof value !== "string") {
          return filterTypeFailure(filter.name, path);
        }
        value =
          filter.name === "upper"
            ? value.toUpperCase()
            : value.toLowerCase();
        break;
      case "json":
        if (value === MISSING_VALUE || value === undefined) {
          return filterTypeFailure(filter.name, path);
        }
        try {
          const encoded = JSON.stringify(value);
          if (encoded === undefined) {
            return filterTypeFailure(filter.name, path);
          }
          value = encoded;
        } catch {
          return failure(
            "TYPED_CONDITION_VALUE_UNSUPPORTED",
            'filter "json" cannot encode a cyclic or unsupported value',
            path,
          );
        }
        break;
      default:
        return failure(
          "INVALID_TYPED_REFERENCE",
          `unsupported reference filter "${filter.name}"`,
          path,
        );
    }
  }
  return { ok: true, value };
}

function evaluateEmpty(
  value: unknown | MissingValue,
  path: string,
): ValueResult {
  if (
    value === MISSING_VALUE ||
    value === null ||
    value === undefined
  ) {
    return { ok: true, value: true };
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return { ok: true, value: value.length === 0 };
  }
  if (isObjectRecord(value)) {
    return { ok: true, value: Object.keys(value).length === 0 };
  }
  return failure(
    "TYPED_CONDITION_TYPE_MISMATCH",
    `empty requires null, string, array, or plain object; received ${describeValue(value)}`,
    path,
  );
}

function structuralEqual(
  left: unknown,
  right: unknown,
  path: string,
  seen: WeakMap<object, object> = new WeakMap(),
): { readonly ok: true; readonly value: boolean } | EvaluationFailure {
  if (
    Object.is(left, right) &&
    (left === null || typeof left !== "object")
  ) {
    return { ok: true, value: true };
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return { ok: true, value: false };
  }
  if (
    (!Array.isArray(left) && !isPlainObject(left)) ||
    (!Array.isArray(right) && !isPlainObject(right))
  ) {
    return failure(
      "TYPED_CONDITION_VALUE_UNSUPPORTED",
      "typed equality supports only scalar, array, and plain-object values",
      path,
    );
  }
  if (left === right) return { ok: true, value: true };
  const prior = seen.get(left);
  if (prior !== undefined) {
    return prior === right
      ? { ok: true, value: true }
      : failure(
          "TYPED_CONDITION_VALUE_UNSUPPORTED",
          "typed equality does not support divergent cyclic values",
          path,
        );
  }
  seen.set(left, right);

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return { ok: true, value: false };
    }
    if (left.length !== right.length) return { ok: true, value: false };
    for (let index = 0; index < left.length; index += 1) {
      const equal = structuralEqual(left[index], right[index], path, seen);
      if (!equal.ok || !equal.value) return equal;
    }
    return { ok: true, value: true };
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return { ok: true, value: false };
  }
  for (const key of leftKeys) {
    const equal = structuralEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      path,
      seen,
    );
    if (!equal.ok || !equal.value) return equal;
  }
  return { ok: true, value: true };
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

function filterTypeFailure(
  filter: string,
  path: string,
): EvaluationFailure {
  return failure(
    "TYPED_CONDITION_TYPE_MISMATCH",
    `filter "${filter}" received an incompatible runtime value`,
    path,
  );
}

function failure(
  code: FlowTypedConditionEvaluationErrorCode,
  message: string,
  path: string,
): EvaluationFailure {
  return { ok: false, code, message, path };
}

function hasOwn(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
