import type { ValidationError } from "@dzupagent/flow-ast";

import type { CompilationSourceSpan } from "../types.js";

/** Stage-3 diagnostic before projection into the public compiler result. */
export interface SemanticDiagnostic extends ValidationError {
  span?: CompilationSourceSpan;
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
