import {
  parseFlowReferenceExpression,
  type FlowReferenceFilter,
  type ParsedFlowReference,
} from "../reference-expression.js";
import {
  MISSING_VALUE,
  failure,
  hasOwn,
  isObjectRecord,
  type EvaluationFailure,
  type MissingValue,
  type ValueResult,
} from "./internal.js";

export function evaluateTypedConditionReference(
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
          value = stableJsonStringify(value);
        } catch {
          return failure(
            "TYPED_CONDITION_VALUE_UNSUPPORTED",
            'filter "json" cannot encode a non-portable or cyclic value',
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

function stableJsonStringify(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("unsupported JSON value");
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError("non-plain JSON object");
  }
  if (ancestors.has(value)) throw new TypeError("cyclic JSON value");
  ancestors.add(value);
  const encoded = Array.isArray(value)
    ? `[${value.map((item) => stableJsonStringify(item, ancestors)).join(",")}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableJsonStringify(value[key], ancestors)}`,
        )
        .join(",")}}`;
  ancestors.delete(value);
  return encoded;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
