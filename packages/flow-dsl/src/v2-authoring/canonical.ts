import { createHash } from "node:crypto";

import { stringify } from "yaml";

import type { DslDiagnostic } from "../types.js";

const TOP_LEVEL_ORDER = [
  "dsl",
  "id",
  "title",
  "description",
  "version",
  "imports",
  "inputs",
  "defaults",
  "tags",
  "meta",
  "durability",
  "steps",
] as const;
const STEP_ORDER = [
  "id",
  "use",
  "with",
  "when",
  "policy",
  "retry",
  "catch",
  "save",
  "evidence",
  "annotations",
] as const;

export function canonicalizeV2Document(
  value: unknown
):
  | { readonly ok: true; readonly document: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly diagnostics: readonly DslDiagnostic[] } {
  const jsonError = validateJsonValue(value, "root", new WeakSet());
  if (jsonError !== undefined) {
    return { ok: false, diagnostics: Object.freeze([jsonError]) };
  }
  if (!isPlainRecord(value)) {
    return {
      ok: false,
      diagnostics: Object.freeze([
        diagnostic(
          "V2_AUTHORING_DOCUMENT_REQUIRED",
          "V2 authoring input must be a plain JSON object",
          "root"
        ),
      ]),
    };
  }
  return {
    ok: true,
    document: deepFreeze(orderRecord(value, "root")),
  };
}

export function renderCanonicalV2Yaml(
  document: Readonly<Record<string, unknown>>
): string {
  return stringify(document, {
    aliasDuplicateObjects: false,
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
}

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function orderRecord(
  value: Readonly<Record<string, unknown>>,
  path: string
): Record<string, unknown> {
  const order =
    path === "root" ? TOP_LEVEL_ORDER : isStepPath(path) ? STEP_ORDER : [];
  const rank = new Map<string, number>(order.map((key, index) => [key, index]));
  const entries = Object.entries(value).sort(([left], [right]) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (
        (leftRank ?? order.length) - (rightRank ?? order.length) ||
        left.localeCompare(right)
      );
    }
    return left.localeCompare(right);
  });
  return Object.fromEntries(
    entries.map(([key, nested]) => [key, orderValue(nested, `${path}.${key}`)])
  );
}

function orderValue(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => orderValue(item, `${path}[${index}]`));
  }
  return isPlainRecord(value) ? orderRecord(value, path) : value;
}

function isStepPath(path: string): boolean {
  return /(?:^|\.)steps\[\d+\]$|\.(?:then|else)\[\d+\]$/u.test(path);
}

function validateJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>
): DslDiagnostic | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : diagnostic(
          "V2_AUTHORING_NON_JSON_VALUE",
          "V2 authoring numbers must be finite",
          path
        );
  }
  if (typeof value !== "object") {
    return diagnostic(
      "V2_AUTHORING_NON_JSON_VALUE",
      "V2 authoring values must be JSON-compatible",
      path
    );
  }
  if (seen.has(value)) {
    return diagnostic(
      "V2_AUTHORING_CYCLIC_VALUE",
      "V2 authoring input must not contain cycles",
      path
    );
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    return diagnostic(
      "V2_AUTHORING_NON_JSON_VALUE",
      "V2 authoring objects must use a plain prototype",
      path
    );
  }
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((nested, index) => [String(index), nested] as const)
    : Object.entries(value);
  for (const [key, nested] of entries) {
    const nestedError = validateJsonValue(
      nested,
      Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`,
      seen
    );
    if (nestedError !== undefined) return nestedError;
  }
  seen.delete(value);
  return undefined;
}

function diagnostic(
  code: string,
  message: string,
  path: string
): DslDiagnostic {
  return { phase: "normalize", code, message, path };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
  } else {
    Object.values(value).forEach((item) => deepFreeze(item));
  }
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
