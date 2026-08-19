import type { ParseInput } from "@dzupagent/flow-ast";
import type {
  CompilationDiagnostic,
  CompilationWarning,
} from "./diagnostic-types.js";

/**
 * Reporting contracts for the strict-reference migration sweep.
 *
 * Split out of `types.ts` so the compiler's core contracts and this
 * self-contained reporting cluster stop sharing one module's LOC budget.
 * `types.ts` re-exports every name here, so the public surface is unchanged.
 */

export type StrictReferenceMigrationSource =
  | { id: string; kind: "flow"; input: ParseInput }
  | { id: string; kind: "document"; input: unknown }
  | { id: string; kind: "dsl"; input: unknown };

export type StrictReferenceMigrationStatus =
  | "ready"
  | "changes-required"
  | "invalid";

export interface StrictReferenceMigrationItem {
  id: string;
  kind: StrictReferenceMigrationSource["kind"];
  status: StrictReferenceMigrationStatus;
  compatibilityDiagnostics: CompilationDiagnostic[];
  compatibilityWarnings: CompilationWarning[];
  strictDiagnostics: CompilationDiagnostic[];
  blockingReferenceCodes: string[];
}

export interface StrictReferenceMigrationSummary {
  total: number;
  ready: number;
  changesRequired: number;
  invalid: number;
  diagnosticsByCode: Record<string, number>;
  compilerDiagnosticsByCode: Record<string, number>;
}

export interface StrictReferenceMigrationReport {
  schema: "dzupagent.strictReferenceMigration/v1";
  summary: StrictReferenceMigrationSummary;
  items: StrictReferenceMigrationItem[];
}
