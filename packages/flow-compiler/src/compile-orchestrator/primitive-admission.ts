import type { FlowNode } from "@dzupagent/flow-ast";

import { validateFlowPrimitiveSelections } from "../primitive-registry-admission.js";
import type {
  CompilationError,
  CompileFailure,
  CompilerOptions,
} from "../types.js";
import { countDiagnosticsByCategory } from "./diagnostics.js";

interface CompileFailureEvent {
  readonly type: "flow:compile_failed";
  readonly compileId: string;
  readonly stage: 3;
  readonly errorCount: number;
  readonly durationMs: number;
}

/** Convert expanded-primitive binding drift into one Stage 3 compile failure. */
export function rejectInvalidPrimitiveSelection(
  ast: FlowNode,
  opts: CompilerOptions,
  compileId: string,
  startedAt: number,
  emit: (event: CompileFailureEvent) => void,
): CompileFailure | undefined {
  const issues = validateFlowPrimitiveSelections(
    ast,
    opts.primitiveRegistry,
    opts.primitiveBindings,
  );
  if (issues.length === 0) return undefined;
  const errors: CompilationError[] = issues.map((issue) => ({
    stage: 3,
    code: "PRIMITIVE_REGISTRY_BINDING_REQUIRED",
    message: issue.message,
    nodePath: issue.nodePath,
    category: "registry",
  }));
  emit({
    type: "flow:compile_failed",
    compileId,
    stage: 3,
    errorCount: errors.length,
    durationMs: Date.now() - startedAt,
  });
  return {
    errors,
    compileId,
    diagnosticCountsByCategory: countDiagnosticsByCategory(errors),
  };
}
