import type {
  CompilationDiagnostic,
  CompilationWarning,
  CompileResult,
  FlowEditorDiagnostic,
} from "./types.js";

/**
 * Project a compiler result into one stable editor-facing diagnostic stream.
 *
 * The compiler deliberately keeps source-line spans and node-field-relative
 * spans distinct. Editors that own an AST/path index can resolve
 * `node-field-offsets`; raw DSL parse failures already carry source lines.
 */
export function projectCompilationDiagnostics(
  result: CompileResult,
): FlowEditorDiagnostic[] {
  if ("errors" in result) {
    return result.errors.map((diagnostic) =>
      projectDiagnostic("error", diagnostic),
    );
  }
  return result.warnings.map((diagnostic) =>
    projectDiagnostic("warning", diagnostic),
  );
}

function projectDiagnostic(
  severity: FlowEditorDiagnostic["severity"],
  diagnostic: CompilationDiagnostic | CompilationWarning,
): FlowEditorDiagnostic {
  return {
    severity,
    stage: diagnostic.stage,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.nodePath !== undefined
      ? { nodePath: diagnostic.nodePath }
      : {}),
    ...(diagnostic.suggestion !== undefined
      ? { suggestion: diagnostic.suggestion }
      : {}),
    ...(diagnostic.category !== undefined
      ? { category: diagnostic.category }
      : {}),
    ...(diagnostic.span !== undefined ? { span: diagnostic.span } : {}),
    ...(diagnostic.fixes !== undefined ? { fixes: diagnostic.fixes } : {}),
  };
}
