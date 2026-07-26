import {
  MISSING_VALUE,
  describeValue,
  failure,
  isObjectRecord,
  type EvaluationFailure,
  type MissingValue,
  type ValueResult,
} from "./internal.js";

export function evaluateTypedConditionEmpty(
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

export function structurallyEqualTypedConditionValues(
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
  const prior = seen.get(left);
  if (prior !== undefined) {
    return failure(
      "TYPED_CONDITION_VALUE_UNSUPPORTED",
      "typed equality does not support cyclic values",
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
      const equal = structurallyEqualTypedConditionValues(
        left[index],
        right[index],
        path,
        seen,
      );
      if (!equal.ok || !equal.value) return equal;
    }
    seen.delete(left);
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
    const equal = structurallyEqualTypedConditionValues(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      path,
      seen,
    );
    if (!equal.ok || !equal.value) return equal;
  }
  seen.delete(left);
  return { ok: true, value: true };
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
