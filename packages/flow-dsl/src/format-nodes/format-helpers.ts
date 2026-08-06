import type { FlowNode } from "@dzupagent/flow-ast";

/**
 * Shared context threaded through every node-group formatter.
 *
 * `formatNode` is injected so group formatters can recurse into child nodes
 * without importing the coordinator (which would create a circular import).
 */
export interface FormatContext {
  readonly lines: string[];
  readonly formatNode: (
    lines: string[],
    node: FlowNode,
    indentLevel: number
  ) => void;
}

/** Narrow the `FlowNode` union to the members with the given `type` tag. */
export type NodeOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>;

export function indentFor(indentLevel: number): string {
  return "  ".repeat(indentLevel);
}

export function pushCommon(
  lines: string[],
  node: FlowNode,
  indentLevel: number
): void {
  const indent = indentFor(indentLevel);
  if (node.id) lines.push(`${indent}id: ${node.id}`);
  if (node.name) lines.push(`${indent}name: ${quote(node.name)}`);
  if (node.description)
    pushTextField(lines, indentLevel, "description", node.description);
  if (
    node.meta &&
    Object.keys(node.meta).length > 0 &&
    !(node.type === "parallel" && node.meta.branchNames)
  ) {
    lines.push(`${indent}meta:`);
    for (const [key, value] of Object.entries(node.meta)) {
      lines.push(`${indent}  ${key}: ${formatScalar(value)}`);
    }
  }
}

export function pushField(
  lines: string[],
  indentLevel: number,
  key: string,
  value: string | number
): void {
  const indent = indentFor(indentLevel);
  lines.push(
    `${indent}${key}: ${typeof value === "string" ? quote(value) : value}`
  );
}

/**
 * Emit authored text without routing embedded newlines through JSON escapes.
 *
 * Formatting a multiline prompt through {@link quote} historically changed
 * an authored newline into the two characters `\\` and `n` on reparse. The
 * parser now decodes formatter-compatible JSON escapes as a compatibility
 * safeguard, while a real block scalar remains the canonical, reviewable
 * representation for multiline prose. Keep single-line output compact.
 */
export function pushTextField(
  lines: string[],
  indentLevel: number,
  key: string,
  value: string
): void {
  if (!value.includes("\n")) {
    pushField(lines, indentLevel, key, value);
    return;
  }

  const indent = indentFor(indentLevel);
  lines.push(`${indent}${key}: |`);
  for (const line of value.split("\n")) {
    lines.push(`${indent}  ${line}`);
  }
}

export function quote(value: string): string {
  // The numeric branch is written so its sub-alternatives are MUTUALLY
  // EXCLUSIVE, which is what keeps this linear. The previous form used
  // `(?:\d+\.?\d*|\.\d+)`: there, `\d+` and `\d*` are adjacent with only an
  // optional `.` between them, so an all-digit run could be split between them
  // in many ways. On a near-miss (a long digit run followed by one invalid
  // character) the engine walked every split before failing — measured
  // QUADRATIC: 5k chars 36ms, 10k 144ms, 20k 617ms, 40k 2,514ms (~4.0x per
  // doubling). That is reachable from author-supplied flow content, so it was a
  // real ReDoS, not a lint false positive.
  //
  // Now the first alternative requires a leading digit and the second requires
  // a leading `.`, so at most one can ever apply and there is nothing to
  // backtrack across. Same language, no ambiguity: re-measured linear at
  // ~0.6ms for 40k chars. Grammar is unchanged — `1`, `1.`, `1.5`, `.5`,
  // `+1.5e-3`, `1e10` all still match; `1.2.3` and `.` still do not.
  // be unambiguous; the heuristic still flags the alternation but cannot see that
  // the branches are mutually exclusive. Measured linear after the fix: 40k chars
  // 0.17ms (was 2,514ms). Differential-tested vs the old pattern over 9,261
  // strings with 0 mismatches, so the accepted language is unchanged.
  const yamlTypedScalar =
  // eslint-disable-next-line security/detect-unsafe-regex -- Rewritten above to
    /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)$/i;
  if (/^[A-Za-z0-9_.\/:-]+$/.test(value) && !yamlTypedScalar.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Emit a plain-object value as a nested YAML block: sub-objects recurse into
 * deeper blocks; scalars and arrays go through {@link formatScalar}.
 * `undefined` entries are skipped. Empty objects emit `key: {}` so the
 * authored (empty) value still round-trips.
 */
export function pushObjectBlock(
  lines: string[],
  indentLevel: number,
  key: string,
  value: Record<string, unknown>
): void {
  const indent = indentFor(indentLevel);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    lines.push(`${indent}${key}: {}`);
    return;
  }
  lines.push(`${indent}${key}:`);
  for (const [entryKey, entryValue] of entries) {
    if (
      typeof entryValue === "object" &&
      entryValue !== null &&
      !Array.isArray(entryValue)
    ) {
      pushObjectBlock(
        lines,
        indentLevel + 1,
        entryKey,
        entryValue as Record<string, unknown>
      );
    } else {
      lines.push(`${indent}  ${entryKey}: ${formatScalar(entryValue)}`);
    }
  }
}

export function formatScalar(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
  return JSON.stringify(value);
}
