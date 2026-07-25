import {
  analyzeFlowTemplateReferences,
  type FlowReferenceFilter,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

import { deepFreeze, stableStringify } from "./evidence.js";
import type { V2InactiveLocalHostError } from "./host-contracts.js";

const MAX_RESOLUTION_DEPTH = 32;
const MAX_RESOLUTION_NODES = 4096;
const TEMPLATE = /\{\{[\s\S]*?\}\}/g;

export type V2LocalResolutionResult<T = unknown> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly resolvedReferences: readonly string[];
    }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError };

/** Resolve only strict inputs/state/steps references into bounded JSON. */
export function resolveV2LocalHostValue<T>(
  value: T,
  bindings: Readonly<Record<string, unknown>>,
  path: string
): V2LocalResolutionResult<T> {
  const resolved = new Set<string>();
  const budget = { nodes: 0 };
  const result = resolveValue(value, bindings, path, resolved, budget, 0);
  return result.ok
    ? {
        ok: true,
        value: deepFreeze(result.value as T),
        resolvedReferences: Object.freeze([...resolved]),
      }
    : result;
}

function resolveValue(
  value: unknown,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolved: Set<string>,
  budget: { nodes: number },
  depth: number
): V2LocalResolutionResult {
  budget.nodes += 1;
  if (depth > MAX_RESOLUTION_DEPTH || budget.nodes > MAX_RESOLUTION_NODES) {
    return fail(path, "reference resolution exceeded its depth or node bound");
  }
  if (typeof value === "string") {
    return resolveString(value, bindings, path, resolved);
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const nested = resolveValue(
        item,
        bindings,
        `${path}[${index}]`,
        resolved,
        budget,
        depth + 1
      );
      if (!nested.ok) return nested;
      output.push(nested.value);
    }
    return { ok: true, value: output, resolvedReferences: [] };
  }
  if (isPlainRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const nested = resolveValue(
        item,
        bindings,
        `${path}.${key}`,
        resolved,
        budget,
        depth + 1
      );
      if (!nested.ok) return nested;
      output[key] = nested.value;
    }
    return { ok: true, value: output, resolvedReferences: [] };
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { ok: true, value, resolvedReferences: [] };
  }
  return fail(path, "runtime values must remain finite JSON values");
}

function resolveString(
  source: string,
  bindings: Readonly<Record<string, unknown>>,
  path: string,
  resolved: Set<string>
): V2LocalResolutionResult {
  const analysis = analyzeFlowTemplateReferences(source, {
    policy: "strict",
    useSite: "required-value",
    allowedRoots: ["inputs", "state", "steps"],
    sourcePath: path,
  });
  if (!analysis.valid) {
    return fail(
      path,
      analysis.diagnostics
        .map((item) => `${item.code}:${item.message}`)
        .join("; ")
    );
  }
  if (analysis.form === "literal") {
    return { ok: true, value: source, resolvedReferences: [] };
  }
  const values: unknown[] = [];
  for (const reference of analysis.references) {
    resolved.add(reference.source);
    const referenceValue = resolveReference(reference, bindings);
    if (!referenceValue.ok) return fail(path, referenceValue.message);
    values.push(referenceValue.value);
  }
  if (analysis.form === "whole-value") {
    return {
      ok: true,
      value: structuredClone(values[0]),
      resolvedReferences: [],
    };
  }
  let cursor = 0;
  let index = 0;
  const output = source.replace(TEMPLATE, (match, offset: number) => {
    cursor = offset + match.length;
    const value = values[index++];
    return typeof value === "string" ? value : stableStringify(value);
  });
  void cursor;
  return { ok: true, value: output, resolvedReferences: [] };
}

function resolveReference(
  reference: ParsedFlowReference,
  bindings: Readonly<Record<string, unknown>>
): { readonly ok: true; readonly value: unknown } | {
  readonly ok: false;
  readonly message: string;
} {
  if (!hasOwn(bindings, reference.root)) {
    return { ok: false, message: `missing reference ${reference.source}` };
  }
  let value: unknown = bindings[reference.root];
  for (const segment of reference.segments) {
    if (segment.kind === "index") {
      if (!Array.isArray(value) || segment.index >= value.length) {
        return { ok: false, message: `missing reference ${reference.source}` };
      }
      value = value[segment.index];
    } else {
      if (!isPlainRecord(value) || !hasOwn(value, segment.key)) {
        return { ok: false, message: `missing reference ${reference.source}` };
      }
      value = value[segment.key];
    }
  }
  return applyFilters(value, reference.filters, reference.source);
}

function applyFilters(
  initial: unknown,
  filters: readonly FlowReferenceFilter[],
  source: string
): { readonly ok: true; readonly value: unknown } | {
  readonly ok: false;
  readonly message: string;
} {
  let value = initial;
  for (const filter of filters) {
    switch (filter.name) {
      case "default":
        if (value === null || value === undefined) value = filter.argument;
        break;
      case "length":
        if (typeof value === "string" || Array.isArray(value)) {
          value = value.length;
        } else if (isPlainRecord(value)) {
          value = Object.keys(value).length;
        } else return filterFailure(source, filter.name);
        break;
      case "upper":
      case "lower":
        if (typeof value !== "string") return filterFailure(source, filter.name);
        value = filter.name === "upper" ? value.toUpperCase() : value.toLowerCase();
        break;
      case "json":
        value = stableStringify(value);
        break;
      default:
        return filterFailure(source, filter.name);
    }
  }
  return { ok: true, value };
}

function filterFailure(source: string, filter: string) {
  return {
    ok: false as const,
    message: `reference ${source} cannot apply ${filter} to its runtime value`,
  };
}

function fail(
  path: string,
  message: string
): { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  return {
    ok: false,
    error: {
      code: "V2_LOCAL_HOST_REFERENCE_RESOLUTION_FAILED",
      message,
      path,
    },
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
