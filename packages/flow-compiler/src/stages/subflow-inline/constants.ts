// ---------------------------------------------------------------------------
// Subflow-inline shared constants
// ---------------------------------------------------------------------------
// Field-name sets and the state-template regex used by the id/namespace
// remapping (rewrite) concern. Kept in a leaf module so the rewrite and
// reference-scope passes share a single source of truth.

export const STATE_KEY_FIELDS = new Set([
  "output",
  "outputKey",
  "outputVar",
  "source",
  "progressKey",
  "sourceRefsKey",
  "driftFindingIdsKey",
  "errorVar",
]);

export const SOURCE_IS_STATE_NODE_TYPES = new Set([
  "evidence.write",
  "validate.schema",
  "validate",
  "memory.write",
]);

// Matches `{{ state.foo.bar.baz }}` template refs. The dotted path is captured
// with a SINGLE flat character class `[A-Za-z0-9_.]+` (one linear quantifier,
// no nesting) to eliminate any ReDoS backtracking risk
// (security/detect-unsafe-regex). This class is deliberately permissive — it
// also accepts leading/trailing/doubled dots — so rewriteStateTemplates
// validates the dotted-identifier shape in JS before rewriting the ref. Refs
// whose path does not validate are left untouched, matching the old regex's
// stricter grammar (`ident(.ident)*`).
export const STATE_TEMPLATE_RE = /\{\{\s*state\.([A-Za-z0-9_.]+)\s*\}\}/g;

// Matches a complete `inputs.foo.bar` template reference while preserving an
// optional filter suffix. The flat character classes keep matching linear and
// the rewrite pass validates the dotted path before substituting it.
export const INPUT_TEMPLATE_RE =
  /\{\{\s*inputs\.([A-Za-z0-9_.]+)([^{}]*)\}\}/g;

// Raw condition expressions use `inputs.foo` without template delimiters.
// Match only the declared head key; any dotted tail remains in the source.
export const RAW_INPUT_REFERENCE_RE = /\binputs\.([A-Za-z_][A-Za-z0-9_]*)/g;

export function inputStateKey(inputKey: string): string {
  return `input__${inputKey}`;
}

export const CHILD_NODE_FIELDS = new Set([
  "nodes",
  "body",
  "then",
  "else",
  "catch",
  "branches",
  "onApprove",
  "onReject",
]);
