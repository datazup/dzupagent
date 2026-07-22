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
