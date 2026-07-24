import type { ValidationError } from "@dzupagent/flow-ast";

import type { CompilationSourceSpan } from "../types.js";

/** Stage-3 diagnostic before projection into the public compiler result. */
export interface SemanticDiagnostic extends ValidationError {
  span?: CompilationSourceSpan;
  fixes?: readonly SemanticRelativeQuickFix[];
}

export interface SemanticRelativeQuickFix {
  readonly id: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly expectedText: string;
  readonly newText: string;
}

export function nodeFieldSpan(
  start: number,
  end: number,
): CompilationSourceSpan {
  return {
    kind: "node-field-offsets",
    start,
    end,
  };
}
