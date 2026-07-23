import type {
  CompileResult,
  StrictReferenceMigrationItem,
  StrictReferenceMigrationReport,
  StrictReferenceMigrationSource,
} from "./types.js";

const REFERENCE_SUBCODES = [
  "EMPTY_REFERENCE",
  "MALFORMED_REFERENCE",
  "DISALLOWED_REFERENCE_ROOT",
  "INVALID_REFERENCE_INDEX",
  "UNKNOWN_REFERENCE_FILTER",
  "INVALID_REFERENCE_FILTER_ARGUMENT",
  "MISSING_REFERENCE",
  "UNTERMINATED_TEMPLATE",
  "MISSING_REFERENCE_PORT",
  "REFERENCE_NOT_AVAILABLE",
  "REFERENCE_TYPE_MISMATCH",
] as const;

export interface StrictReferenceMigrationRunners {
  compileCompatibility(
    source: StrictReferenceMigrationSource,
  ): Promise<CompileResult>;
  compileStrict(
    source: StrictReferenceMigrationSource,
  ): Promise<CompileResult>;
}

/** Compare compatibility and strict compilation for a bounded source corpus. */
export async function analyzeStrictReferenceMigrationSources(
  sources: readonly StrictReferenceMigrationSource[],
  runners: StrictReferenceMigrationRunners,
): Promise<StrictReferenceMigrationReport> {
  const items: StrictReferenceMigrationItem[] = [];
  for (const source of sources) {
    const compatibility = await runners.compileCompatibility(source);
    const strict = await runners.compileStrict(source);
    items.push(toMigrationItem(source, compatibility, strict));
  }
  return {
    schema: "dzupagent.strictReferenceMigration/v1",
    summary: summarize(items),
    items,
  };
}

function toMigrationItem(
  source: StrictReferenceMigrationSource,
  compatibility: CompileResult,
  strict: CompileResult,
): StrictReferenceMigrationItem {
  const compatibilityDiagnostics =
    "errors" in compatibility ? compatibility.errors : [];
  const compatibilityWarnings =
    "errors" in compatibility ? [] : compatibility.warnings;
  const strictDiagnostics = "errors" in strict ? strict.errors : [];
  const blockingReferenceCodes = sortedUnique(
    strictDiagnostics.flatMap(referenceSubcodes),
  );

  let status: StrictReferenceMigrationItem["status"];
  if ("errors" in compatibility) {
    status = "invalid";
  } else if (!("errors" in strict)) {
    status = "ready";
  } else if (
    strictDiagnostics.length > 0 &&
    strictDiagnostics.every(isReferenceDiagnostic)
  ) {
    status = "changes-required";
  } else {
    status = "invalid";
  }

  return {
    id: source.id,
    kind: source.kind,
    status,
    compatibilityDiagnostics,
    compatibilityWarnings,
    strictDiagnostics,
    blockingReferenceCodes,
  };
}

function summarize(
  items: readonly StrictReferenceMigrationItem[],
): StrictReferenceMigrationReport["summary"] {
  const diagnosticsByCode: Record<string, number> = {};
  const compilerDiagnosticsByCode: Record<string, number> = {};
  for (const item of items) {
    for (const diagnostic of item.strictDiagnostics) {
      for (const code of referenceSubcodes(diagnostic)) {
        diagnosticsByCode[code] = (diagnosticsByCode[code] ?? 0) + 1;
      }
    }
    const statusDiagnostics =
      item.status === "invalid"
        ? item.compatibilityDiagnostics
        : item.strictDiagnostics;
    for (const diagnostic of statusDiagnostics) {
      compilerDiagnosticsByCode[diagnostic.code] =
        (compilerDiagnosticsByCode[diagnostic.code] ?? 0) + 1;
    }
  }
  return {
    total: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    changesRequired: items.filter(
      (item) => item.status === "changes-required",
    ).length,
    invalid: items.filter((item) => item.status === "invalid").length,
    diagnosticsByCode: Object.fromEntries(
      Object.entries(diagnosticsByCode).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    compilerDiagnosticsByCode: Object.fromEntries(
      Object.entries(compilerDiagnosticsByCode).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function isReferenceDiagnostic(
  diagnostic: StrictReferenceMigrationItem["strictDiagnostics"][number],
): boolean {
  return (
    diagnostic.stage === 3 &&
    (diagnostic.code === "INVALID_REFERENCE" ||
      (diagnostic.code === "INVALID_CONDITION" &&
        referenceSubcodes(diagnostic).length > 0))
  );
}

function referenceSubcodes(
  diagnostic: StrictReferenceMigrationItem["strictDiagnostics"][number],
): string[] {
  if (diagnostic.stage !== 3) return [];
  return REFERENCE_SUBCODES.filter((code) =>
    new RegExp(`(?:\\[|\\b)${code}(?:\\]|\\b)`).test(diagnostic.message),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
