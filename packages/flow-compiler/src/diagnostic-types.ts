import type { FlowDiagnosticCategory } from "@dzupagent/flow-ast";

export type CompilationStage = 1 | 2 | 3 | 4;

export interface CompilationDiagnostic {
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
  /**
   * Stable editor-facing location. DSL parse diagnostics use source lines,
   * object compilation uses field-relative offsets, and DSL semantic
   * diagnostics use absolute UTF-16 source offsets.
   */
  span?: CompilationSourceSpan;
  fixes?: readonly FlowDiagnosticQuickFix[];
}

export interface CompilationWarning {
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
  span?: CompilationSourceSpan;
  fixes?: readonly FlowDiagnosticQuickFix[];
}

export type CompilationSourceSpan =
  | {
      kind: "source-lines";
      lineStart: number;
      columnStart: number;
      lineEnd: number;
      columnEnd: number;
    }
  | {
      kind: "node-field-offsets";
      start: number;
      end: number;
    }
  | {
      kind: "source-offsets";
      start: number;
      end: number;
      lineStart: number;
      columnStart: number;
      lineEnd: number;
      columnEnd: number;
    };

export interface FlowDiagnosticTextEdit {
  start: number;
  end: number;
  expectedText: string;
  newText: string;
}

export interface FlowDiagnosticQuickFix {
  id: string;
  title: string;
  applicability: "safe";
  sourceDigest: `sha256:${string}`;
  edits: readonly FlowDiagnosticTextEdit[];
}

export interface FlowEditorDiagnostic {
  severity: "error" | "warning";
  stage: CompilationStage;
  code: string;
  message: string;
  nodePath?: string;
  suggestion?: string;
  category?: FlowDiagnosticCategory;
  span?: CompilationSourceSpan;
  fixes?: readonly FlowDiagnosticQuickFix[];
}
