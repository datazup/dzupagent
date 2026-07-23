export const FLOW_REFERENCE_ROOTS = [
  "inputs",
  "state",
  "steps",
  "loop",
  "context",
  "secrets",
  "artifacts",
  "params",
] as const;

export const FLOW_REFERENCE_FILTERS = [
  "length",
  "json",
  "upper",
  "lower",
  "default",
] as const;

export const COMPAT_REFERENCE_ROOTS = [
  ...FLOW_REFERENCE_ROOTS,
  "input",
  "output",
  "node",
  "last_agent",
  "item",
  "ctx",
] as const;

export type FlowReferencePolicy = "compat-v1" | "strict";
export type FlowReferenceUseSite =
  | "value-interpolation"
  | "required-value"
  | "boolean-control"
  | "policy"
  | "compile-time-constant";
export type FlowTemplateForm = "literal" | "whole-value" | "interpolation";
export type FlowReferenceDiagnosticSeverity = "warning" | "error";
export type FlowReferenceDiagnosticCode =
  | "EMPTY_REFERENCE"
  | "MALFORMED_REFERENCE"
  | "DISALLOWED_REFERENCE_ROOT"
  | "INVALID_REFERENCE_INDEX"
  | "UNKNOWN_REFERENCE_FILTER"
  | "INVALID_REFERENCE_FILTER_ARGUMENT"
  | "MISSING_REFERENCE"
  | "UNTERMINATED_TEMPLATE";

export interface FlowReferenceSpan {
  start: number;
  end: number;
}

export type FlowReferenceSegment =
  | ({ kind: "property"; key: string } & FlowReferenceSpan)
  | ({ kind: "index"; index: number } & FlowReferenceSpan);

export interface FlowReferenceFilter extends FlowReferenceSpan {
  name: string;
  argument?: string | number;
}

export interface ParsedFlowReference extends FlowReferenceSpan {
  source: string;
  root: string;
  segments: FlowReferenceSegment[];
  filters: FlowReferenceFilter[];
}

export interface FlowReferenceDiagnostic extends FlowReferenceSpan {
  code: FlowReferenceDiagnosticCode;
  severity: FlowReferenceDiagnosticSeverity;
  message: string;
  sourcePath?: string;
  useSite: FlowReferenceUseSite;
}

export type FlowReferenceBindings = Readonly<
  Record<string, readonly string[] | undefined>
>;

export interface FlowReferenceAnalysisOptions {
  policy?: FlowReferencePolicy;
  useSite?: FlowReferenceUseSite;
  allowedRoots?: readonly string[];
  knownBindings?: FlowReferenceBindings;
  sourcePath?: string;
}

export interface FlowReferenceParseResult {
  ok: boolean;
  reference?: ParsedFlowReference;
  diagnostics: FlowReferenceDiagnostic[];
}

export interface FlowTemplateReferenceAnalysis {
  valid: boolean;
  form: FlowTemplateForm;
  references: ParsedFlowReference[];
  diagnostics: FlowReferenceDiagnostic[];
}

/**
 * Type-preserving authored reference used by fragment definitions before
 * expansion. The generic is intentionally phantom: expansion resolves the
 * source against fragment params and emits an ordinary AST value.
 */
export interface FlowReferenceValue<T = unknown> {
  readonly kind: "flow-reference";
  readonly source: string;
  readonly __valueType?: T;
}
