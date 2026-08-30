/**
 * @datazup/canonical-json — canonical JSON stringification and SHA-256
 * digests with explicit, named semantics.
 *
 * Extracted from dzupagent (ARCH27-T-13, SHARED-KIT-CANDIDATES.md #1):
 * 15+ hand-rolled `stableStringify`/`sha256` copies feed persisted hashes
 * (idempotency keys, evidence receipts, the v2 import lock chain) with four
 * incompatible semantics. Each source variant survives here as a named
 * preset so call sites can migrate one at a time with byte-identical
 * digests; the semantic differences become options instead of accidents.
 *
 * Every preset is pinned by golden vectors generated from the original
 * dzupagent implementations (`golden-vectors.test.ts`). Divergences from a
 * source variant are limited to inputs on which the source crashed or
 * returned a non-string; each is listed on its preset and covered by its
 * own test:
 *
 * - `authoring-v1`: cyclic input overflowed the stack (RangeError); the
 *   preset throws a TypeError instead. Top-level `undefined`/function/
 *   symbol made the source return `undefined` (typed as string), poisoning
 *   the digest call; the preset throws a TypeError up front.
 * - `classification-envelope-v1`: a top-level function/symbol made the
 *   source return `undefined`; the preset throws a TypeError up front.
 *
 * Key order is always UTF-16 code-unit order via an explicit comparator —
 * never `localeCompare`, which varies with the host ICU locale (the bug
 * fixed by ARCH27-T-01).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Rendering policy for `undefined` values, by position. */
export interface UndefinedValuePolicy {
  /**
   * An object entry whose value is `undefined`. `"token"` keeps the key and
   * emits a bare `undefined` token (deterministic, but not valid JSON);
   * `"omit"` drops the entry.
   */
  objectValue: "token" | "omit";
  /**
   * An `undefined` array item. `"elide"` emits nothing between the commas
   * (`[1,,3]`); `"null"` and `"token"` emit those texts.
   */
  arrayItem: "elide" | "null" | "token";
  /** `undefined` passed as the top-level value. */
  topLevel: "throw" | "null" | "token";
}

/** Rendering policy for function and symbol values, by position. */
export interface FunctionSymbolPolicy {
  /**
   * `"token"` keeps the key and emits a bare `undefined` token;
   * `"placeholder"` emits `"[Function]"` / the symbol's `toString()` as a
   * JSON string.
   */
  objectValue: "token" | "placeholder";
  arrayItem: "elide" | "placeholder";
  topLevel: "throw" | "placeholder";
}

/**
 * `"throw"` tracks visited objects and unwinds after each subtree, so a
 * shared acyclic reference is fine and only a true cycle throws (with the
 * given message). `"marker"` never unwinds: EVERY repeated object
 * reference — cyclic or not — renders as the `"[Circular]"` JSON string.
 * The marker mode reproduces the compile-evidence source exactly; its
 * repeated-reference behavior is load-bearing for existing digests.
 */
export type CyclePolicy =
  | { policy: "throw"; message: string }
  | { policy: "marker" };

export interface CanonicalJsonOptions {
  undefinedValues: UndefinedValuePolicy;
  functionsAndSymbols: FunctionSymbolPolicy;
  /** `"throw"` matches native JSON.stringify; `"decimal-string"` emits the bigint's decimal digits as a JSON string. */
  bigint: "throw" | "decimal-string";
  cycles: CyclePolicy;
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/** UTF-16 code-unit comparison; deliberately not localeCompare. */
function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CIRCULAR_MARKER = JSON.stringify("[Circular]");

interface Nothing {
  nothing: "undefined" | "function-or-symbol";
  placeholder?: string;
}

function renderValue(
  value: unknown,
  options: CanonicalJsonOptions,
  seen: WeakSet<object>,
): string | Nothing {
  if (value === undefined) {
    return { nothing: "undefined" };
  }
  if (typeof value === "function") {
    return {
      nothing: "function-or-symbol",
      placeholder: JSON.stringify("[Function]"),
    };
  }
  if (typeof value === "symbol") {
    return {
      nothing: "function-or-symbol",
      placeholder: JSON.stringify(value.toString()),
    };
  }
  if (typeof value === "bigint") {
    if (options.bigint === "throw") {
      throw new TypeError("Do not know how to serialize a BigInt");
    }
    return JSON.stringify(value.toString());
  }
  if (value === null || typeof value !== "object") {
    // NaN and ±Infinity serialize to "null", exactly as JSON.stringify does.
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    if (options.cycles.policy === "marker") return CIRCULAR_MARKER;
    throw new TypeError(options.cycles.message);
  }
  seen.add(value);

  let serialized: string;
  if (Array.isArray(value)) {
    const parts = value.map((item) =>
      renderArrayItem(renderValue(item, options, seen), options),
    );
    serialized = `[${parts.join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort(compareUtf16)) {
      const entry = renderObjectValue(key, record[key], options, seen);
      if (entry !== undefined) parts.push(entry);
    }
    serialized = `{${parts.join(",")}}`;
  }

  if (options.cycles.policy === "throw") seen.delete(value);
  return serialized;
}

function renderArrayItem(
  rendered: string | Nothing,
  options: CanonicalJsonOptions,
): string {
  if (typeof rendered === "string") return rendered;
  if (rendered.nothing === "undefined") {
    switch (options.undefinedValues.arrayItem) {
      case "elide":
        return "";
      case "null":
        return "null";
      case "token":
        return "undefined";
    }
  }
  switch (options.functionsAndSymbols.arrayItem) {
    case "elide":
      return "";
    case "placeholder":
      return rendered.placeholder as string;
  }
}

/** Returns the rendered `"key":value` text, or undefined to omit the entry. */
function renderObjectValue(
  key: string,
  value: unknown,
  options: CanonicalJsonOptions,
  seen: WeakSet<object>,
): string | undefined {
  const rendered = renderValue(value, options, seen);
  const encodedKey = JSON.stringify(key);
  if (typeof rendered === "string") return `${encodedKey}:${rendered}`;
  if (rendered.nothing === "undefined") {
    switch (options.undefinedValues.objectValue) {
      case "token":
        return `${encodedKey}:undefined`;
      case "omit":
        return undefined;
    }
  }
  switch (options.functionsAndSymbols.objectValue) {
    case "token":
      return `${encodedKey}:undefined`;
    case "placeholder":
      return `${encodedKey}:${rendered.placeholder as string}`;
  }
}

/**
 * Canonicalize `value` under explicit semantics. Object keys are always in
 * UTF-16 code-unit order; everything else is governed by `options`.
 */
export function canonicalStringify(
  value: unknown,
  options: CanonicalJsonOptions,
): string {
  const rendered = renderValue(value, options, new WeakSet());
  if (typeof rendered === "string") return rendered;
  if (rendered.nothing === "undefined") {
    switch (options.undefinedValues.topLevel) {
      case "throw":
        throw new TypeError("cannot canonicalize `undefined` at the top level");
      case "null":
        return "null";
      case "token":
        return "undefined";
    }
  }
  switch (options.functionsAndSymbols.topLevel) {
    case "throw":
      throw new TypeError(
        "cannot canonicalize a function or symbol value at the top level",
      );
    case "placeholder":
      return rendered.placeholder as string;
  }
}

// ---------------------------------------------------------------------------
// The sorted-json/v1 engine (idempotency-v1)
// ---------------------------------------------------------------------------

/**
 * Exact port of `@dzupagent/runtime-contracts` `canonicalJson` (the
 * `dzupagent.sorted-json/v1` scheme behind persisted idempotency keys). Its
 * semantics cannot be expressed through `CanonicalJsonOptions` and are
 * pinned by golden vectors instead:
 *
 * - keys are sorted, then re-inserted into a JS object, so integer-like
 *   keys enumerate in numeric order ahead of string keys
 *   (`{"2":6,"10":5,...}` — NOT pure UTF-16 order);
 * - `JSON.stringify` performs the final emission: `undefined`/function/
 *   symbol object values are omitted, array items become `null`, an own
 *   enumerable `toJSON` is invoked on the sorted copy (so its result is
 *   NOT re-sorted), and an inherited `toJSON` (e.g. `Date.prototype`) is
 *   stripped by the rebuild;
 * - cyclic input overflows the stack (RangeError); non-serializable
 *   top-level input throws a TypeError.
 */
export function sortedJsonV1Stringify(value: unknown): string {
  const encoded = JSON.stringify(sortValue(value));
  if (encoded === undefined) {
    throw new TypeError("Canonical JSON input must be JSON-serializable.");
  }
  return encoded;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    // A null-prototype object preserves JSON keys such as `__proto__` as
    // data instead of invoking the legacy object prototype setter.
    const sorted: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * `flow-dsl/src/v2-authoring/canonical.ts` `stableStringify`: feeds
 * `canonicalSourceSha256`/`semanticSha256` and the v2 import lock chain.
 * Divergence from source: cycles throw a TypeError (source overflowed the
 * stack); top-level `undefined`/function/symbol throw (source returned a
 * non-string).
 */
export const AUTHORING_V1_OPTIONS: CanonicalJsonOptions = Object.freeze({
  undefinedValues: Object.freeze({
    objectValue: "token",
    arrayItem: "elide",
    topLevel: "throw",
  }),
  functionsAndSymbols: Object.freeze({
    objectValue: "token",
    arrayItem: "elide",
    topLevel: "throw",
  }),
  bigint: "throw",
  cycles: Object.freeze({
    policy: "throw",
    message: "cannot canonicalize a cyclic value",
  }),
} as const);

/**
 * `flow-compiler/src/classification-envelope.ts` `stableStringify`: feeds
 * classification-envelope and tool-security-policy hashes. Divergence from
 * source: a top-level function/symbol throws up front (source returned a
 * non-string).
 */
export const CLASSIFICATION_ENVELOPE_V1_OPTIONS: CanonicalJsonOptions =
  Object.freeze({
    undefinedValues: Object.freeze({
      objectValue: "omit",
      arrayItem: "null",
      topLevel: "null",
    }),
    functionsAndSymbols: Object.freeze({
      objectValue: "token",
      arrayItem: "elide",
      topLevel: "throw",
    }),
    bigint: "throw",
    cycles: Object.freeze({
      policy: "throw",
      message: "cannot hash cyclic envelope",
    }),
  } as const);

/**
 * `flow-compiler/src/compile-orchestrator/evidence.ts` `stableStringify`:
 * feeds compile-evidence source hashes. Total (never throws): bigints
 * become decimal strings, functions/symbols become placeholder strings, and
 * every REPEATED object reference — not only a true cycle — renders as
 * `"[Circular]"` (the source never unwinds its seen-set; existing digests
 * depend on this).
 */
export const COMPILE_EVIDENCE_V1_OPTIONS: CanonicalJsonOptions = Object.freeze({
  undefinedValues: Object.freeze({
    objectValue: "token",
    arrayItem: "token",
    topLevel: "token",
  }),
  functionsAndSymbols: Object.freeze({
    objectValue: "placeholder",
    arrayItem: "placeholder",
    topLevel: "placeholder",
  }),
  bigint: "decimal-string",
  cycles: Object.freeze({ policy: "marker" }),
} as const);

/**
 * `agent-adapters` digest sites (capability manifests, observed-capability
 * event identity, wired-runtime definition hashes): object entries with
 * `undefined` values are omitted, `undefined`/function/symbol array items
 * are elided, and any top-level `undefined`/function/symbol, bigint, or
 * cycle throws. Upstreamed from dzupagent's private
 * `ADAPTER_CANONICAL_JSON_OPTIONS` (ARCH27-T-13 follow-up); the option
 * values and the cycle message are digest-load-bearing and must not change.
 */
export const ADAPTER_DIGEST_V1_OPTIONS: CanonicalJsonOptions = Object.freeze({
  undefinedValues: Object.freeze({
    objectValue: "omit",
    arrayItem: "elide",
    topLevel: "throw",
  }),
  functionsAndSymbols: Object.freeze({
    objectValue: "token",
    arrayItem: "elide",
    topLevel: "throw",
  }),
  bigint: "throw",
  cycles: Object.freeze({
    policy: "throw",
    message: "cannot canonicalize a cyclic adapter value",
  }),
} as const);

export type CanonicalJsonPreset =
  | "idempotency-v1"
  | "authoring-v1"
  | "classification-envelope-v1"
  | "compile-evidence-v1"
  | "adapter-digest-v1";

const PRESET_OPTIONS: Record<
  Exclude<CanonicalJsonPreset, "idempotency-v1">,
  CanonicalJsonOptions
> = {
  "authoring-v1": AUTHORING_V1_OPTIONS,
  "classification-envelope-v1": CLASSIFICATION_ENVELOPE_V1_OPTIONS,
  "compile-evidence-v1": COMPILE_EVIDENCE_V1_OPTIONS,
  "adapter-digest-v1": ADAPTER_DIGEST_V1_OPTIONS,
};

/** Canonicalize `value` under a named preset. */
export function canonicalize(
  value: unknown,
  preset: CanonicalJsonPreset,
): string {
  if (preset === "idempotency-v1") return sortedJsonV1Stringify(value);
  return canonicalStringify(value, PRESET_OPTIONS[preset]);
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Prefixed(text: string): `sha256:${string}` {
  return `sha256:${sha256Hex(text)}`;
}

/** Bare-hex SHA-256 of the canonical form (the idempotency-key convention). */
export function canonicalDigestHex(
  value: unknown,
  preset: CanonicalJsonPreset,
): string {
  return sha256Hex(canonicalize(value, preset));
}

/** `sha256:`-prefixed SHA-256 of the canonical form (the flow-dsl / flow-compiler convention). */
export function canonicalDigestPrefixed(
  value: unknown,
  preset: CanonicalJsonPreset,
): `sha256:${string}` {
  return sha256Prefixed(canonicalize(value, preset));
}
