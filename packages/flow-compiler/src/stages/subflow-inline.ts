import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import type {
  CompilationDiagnostic,
  FlowCompileSubflowEvidence,
  FlowDocumentResolver,
} from "../types.js";
import { inlineNode } from "./subflow-inline/inline.js";

// Composition root for the subflow-inline stage. The per-concern passes —
// id/namespace remapping (subflow-inline/rewrite.ts), reference-scope
// collection (subflow-inline/reference-scope.ts), shared constants
// (subflow-inline/constants.ts), and subflow resolution + node inlining with
// cycle detection (subflow-inline/inline.ts) — live in sibling leaf modules.

export interface InlineSubflowOptions {
  currentFlowRef?: string;
}

export interface InlineSubflowResult {
  root: FlowNode;
  diagnostics: CompilationDiagnostic[];
  subflows: FlowCompileSubflowEvidence[];
}

export async function inlineSubflows(
  root: FlowNode,
  resolver: FlowDocumentResolver,
  options: InlineSubflowOptions = {}
): Promise<InlineSubflowResult> {
  const diagnostics: CompilationDiagnostic[] = [];
  const subflows: FlowCompileSubflowEvidence[] = [];
  const stack = options.currentFlowRef ? [options.currentFlowRef] : [];
  const inlined = await inlineNode(
    root,
    resolver,
    "root",
    stack,
    diagnostics,
    subflows
  );
  return {
    root:
      inlined.length === 1 ? inlined[0]! : { type: "sequence", nodes: inlined },
    diagnostics,
    subflows,
  };
}

export function currentFlowRefFromDocument(
  document: unknown
): string | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const id = (document as Partial<FlowDocumentV1>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
