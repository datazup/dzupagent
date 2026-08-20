import type { FlowNode } from "@dzupagent/flow-ast";

import { validateFlowPrimitiveSelections } from "../primitive-registry-admission.js";
import type {
  CompilationError,
  CompileFailure,
  CompilerOptions,
} from "../types.js";
import { failCompile, type CompileFailureSink } from "./compile-failure.js";

/** Convert expanded-primitive binding drift into one Stage 3 compile failure. */
export function rejectInvalidPrimitiveSelection(
  ast: FlowNode,
  opts: CompilerOptions,
  fail: CompileFailureSink,
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
  return failCompile(fail, 3, errors);
}
