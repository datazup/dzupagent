import { createHash } from "node:crypto";

import type { FlowDiagnosticQuickFix } from "./types.js";

export type ApplyFlowDiagnosticQuickFixResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Apply one source-digest and expected-text guarded quick fix without mutating
 * caller data. Edits must be non-overlapping absolute UTF-16 ranges.
 */
export function applyFlowDiagnosticQuickFix(
  source: string,
  fix: FlowDiagnosticQuickFix,
): ApplyFlowDiagnosticQuickFixResult {
  if (digestSource(source) !== fix.sourceDigest) {
    return {
      ok: false,
      reason: "source digest changed after the diagnostic was produced",
    };
  }
  const edits = [...fix.edits].sort((left, right) => right.start - left.start);
  let previousStart = source.length + 1;
  for (const edit of edits) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > source.length
    ) {
      return { ok: false, reason: "quick-fix edit range is invalid" };
    }
    if (edit.end > previousStart) {
      return { ok: false, reason: "quick-fix edits overlap" };
    }
    if (source.slice(edit.start, edit.end) !== edit.expectedText) {
      return {
        ok: false,
        reason: "quick-fix expected text does not match the source",
      };
    }
    previousStart = edit.start;
  }
  let updated = source;
  for (const edit of edits) {
    updated =
      updated.slice(0, edit.start) +
      edit.newText +
      updated.slice(edit.end);
  }
  return { ok: true, source: updated };
}

function digestSource(source: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
