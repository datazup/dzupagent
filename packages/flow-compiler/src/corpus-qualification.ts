import { createHash } from "node:crypto";

import {
  formatDocumentToDslChecked,
  parseDslToDocument,
} from "@dzupagent/flow-dsl";

import type { FlowCompiler, StrictReferenceMigrationItem } from "./types.js";

export const FLOW_CORPUS_MANIFEST_SCHEMA =
  "dzupagent.flowCorpusManifest/v1" as const;
export const FLOW_CORPUS_REPORT_SCHEMA =
  "dzupagent.flowCorpusQualification/v1" as const;

export interface FlowCorpusManifestEntry {
  id: string;
  path: string;
  sha256: string;
  qualification: "compile-example" | "authoring-only";
}

export interface FlowCorpusManifest {
  schema: typeof FLOW_CORPUS_MANIFEST_SCHEMA;
  entries: FlowCorpusManifestEntry[];
}

export interface LoadedFlowCorpusSource extends FlowCorpusManifestEntry {
  source: string;
}

/**
 * Formatter round-trip outcome for one corpus source, measured
 * `parse -> format -> reparse`:
 *
 * - `lossless`   - the formatter reproduced every authored field.
 * - `lossy`      - output reparsed, but authored fields were dropped or
 *                  altered (`lossPaths` names them).
 * - `not-reparsable` - output failed to parse at all.
 * - `unparsable-source` - the corpus source itself did not parse, so the
 *                  formatter was never exercised.
 *
 * This is a MEASUREMENT, not a gate: it is deliberately excluded from
 * `report.passed` so the qualifier stays usable while losslessness is still
 * being driven up. Ratchet on `roundTrip.lossless` instead.
 */
export type FlowCorpusRoundTripStatus =
  | "lossless"
  | "lossy"
  | "not-reparsable"
  | "unparsable-source";

export interface FlowCorpusQualificationItem {
  id: string;
  path: string;
  expectedSha256: string;
  actualSha256: string;
  hashMatches: boolean;
  qualification: FlowCorpusManifestEntry["qualification"];
  status: StrictReferenceMigrationItem["status"];
  compileStatus: "succeeded" | "failed" | "not-required";
  compileDiagnosticCodes: string[];
  compatibilityDiagnosticCodes: string[];
  compatibilityWarningCodes: string[];
  strictDiagnosticCodes: string[];
  blockingReferenceCodes: string[];
  roundTripStatus: FlowCorpusRoundTripStatus;
  /** Authored document paths the formatter failed to preserve. */
  roundTripLossPaths: string[];
}

export interface FlowCorpusQualificationReport {
  schema: typeof FLOW_CORPUS_REPORT_SCHEMA;
  resolverMode: "corpus-documents";
  passed: boolean;
  summary: {
    total: number;
    ready: number;
    changesRequired: number;
    invalid: number;
    hashMismatches: number;
    compileReady: number;
    compileFailed: number;
    authoringOnly: number;
  };
  /**
   * Formatter fidelity across the whole corpus. Reported, never gated — see
   * {@link FlowCorpusRoundTripStatus}.
   */
  roundTrip: {
    total: number;
    lossless: number;
    lossy: number;
    notReparsable: number;
    unparsableSource: number;
  };
  items: FlowCorpusQualificationItem[];
}

export function parseFlowCorpusManifest(value: unknown): FlowCorpusManifest {
  if (!isRecord(value) || value.schema !== FLOW_CORPUS_MANIFEST_SCHEMA) {
    throw new Error(
      `manifest.schema must be "${FLOW_CORPUS_MANIFEST_SCHEMA}"`,
    );
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("manifest.entries must be a non-empty array");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const entries = value.entries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`manifest.entries[${index}] must be an object`);
    }
    const id = requiredString(raw.id, `manifest.entries[${index}].id`);
    const path = requiredString(raw.path, `manifest.entries[${index}].path`);
    const sha256 = requiredString(
      raw.sha256,
      `manifest.entries[${index}].sha256`,
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(
        `manifest.entries[${index}].sha256 must be a 64-character SHA-256 hex digest`,
      );
    }
    const rawQualification = raw.qualification;
    if (
      rawQualification !== undefined &&
      rawQualification !== "compile-example" &&
      rawQualification !== "authoring-only"
    ) {
      throw new Error(
        `manifest.entries[${index}].qualification must be "compile-example" or "authoring-only"`,
      );
    }
    const qualification: FlowCorpusManifestEntry["qualification"] =
      rawQualification ?? "compile-example";
    if (ids.has(id)) throw new Error(`duplicate manifest entry id "${id}"`);
    if (paths.has(path)) {
      throw new Error(`duplicate manifest entry path "${path}"`);
    }
    ids.add(id);
    paths.add(path);
    return { id, path, sha256, qualification };
  });

  return { schema: FLOW_CORPUS_MANIFEST_SCHEMA, entries };
}

export function hashFlowCorpusSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Measures `parse -> format -> reparse` fidelity for one authored source.
 * Uses the fail-closed formatter so a dropped field is reported as a named
 * `lossPath` rather than silently surviving as plausible-looking output.
 */
export function measureFlowCorpusRoundTrip(source: string): {
  status: FlowCorpusRoundTripStatus;
  lossPaths: string[];
} {
  const parsed = parseDslToDocument(source);
  if (!parsed.ok || parsed.document === null) {
    return { status: "unparsable-source", lossPaths: [] };
  }
  const formatted = formatDocumentToDslChecked(parsed.document);
  if (formatted.ok) return { status: "lossless", lossPaths: [] };
  // `formatDocumentToDslChecked` signals a total reparse failure with the
  // sentinel path "document"; anything else is field-level loss.
  const notReparsable =
    formatted.lossPaths.length === 1 && formatted.lossPaths[0] === "document";
  return {
    status: notReparsable ? "not-reparsable" : "lossy",
    lossPaths: [...formatted.lossPaths],
  };
}

export async function qualifyFlowCorpusSources(
  sources: readonly LoadedFlowCorpusSource[],
  compiler: Pick<
    FlowCompiler,
    "analyzeStrictReferenceMigration" | "compileDsl"
  >,
): Promise<FlowCorpusQualificationReport> {
  const migration = await compiler.analyzeStrictReferenceMigration(
    sources.map(({ id, source }) => ({ id, kind: "dsl", input: source })),
  );
  const migrationById = new Map(
    migration.items.map((item) => [item.id, item]),
  );
  const compileResults = new Map(
    await Promise.all(
      sources
        .filter((source) => source.qualification === "compile-example")
        .map(async (source) => {
          const result = await compiler.compileDsl(source.source);
          return [source.id, result] as const;
        }),
    ),
  );

  const items = sources.map((source) => {
    const migrationItem = migrationById.get(source.id);
    if (migrationItem === undefined) {
      throw new Error(`migration result is missing source "${source.id}"`);
    }
    const actualSha256 = hashFlowCorpusSource(source.source);
    const roundTrip = measureFlowCorpusRoundTrip(source.source);
    const compileResult = compileResults.get(source.id);
    const compileDiagnosticCodes =
      compileResult !== undefined && "errors" in compileResult
        ? uniqueCodes(compileResult.errors)
        : [];
    return {
      id: source.id,
      path: source.path,
      expectedSha256: source.sha256,
      actualSha256,
      hashMatches: actualSha256 === source.sha256,
      qualification: source.qualification,
      status: migrationItem.status,
      compileStatus:
        source.qualification === "authoring-only"
          ? ("not-required" as const)
          : compileResult !== undefined && "errors" in compileResult
            ? ("failed" as const)
            : ("succeeded" as const),
      compileDiagnosticCodes,
      compatibilityDiagnosticCodes: uniqueCodes(
        migrationItem.compatibilityDiagnostics,
      ),
      compatibilityWarningCodes: uniqueCodes(
        migrationItem.compatibilityWarnings,
      ),
      strictDiagnosticCodes: uniqueCodes(migrationItem.strictDiagnostics),
      blockingReferenceCodes: [...migrationItem.blockingReferenceCodes],
      roundTripStatus: roundTrip.status,
      roundTripLossPaths: roundTrip.lossPaths,
    };
  });

  const summary = {
    total: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    changesRequired: items.filter(
      (item) => item.status === "changes-required",
    ).length,
    invalid: items.filter((item) => item.status === "invalid").length,
    hashMismatches: items.filter((item) => !item.hashMatches).length,
    compileReady: items.filter((item) => item.compileStatus === "succeeded")
      .length,
    compileFailed: items.filter((item) => item.compileStatus === "failed")
      .length,
    authoringOnly: items.filter(
      (item) => item.compileStatus === "not-required",
    ).length,
  };
  const countRoundTrip = (status: FlowCorpusRoundTripStatus): number =>
    items.filter((item) => item.roundTripStatus === status).length;
  const roundTrip = {
    total: items.length,
    lossless: countRoundTrip("lossless"),
    lossy: countRoundTrip("lossy"),
    notReparsable: countRoundTrip("not-reparsable"),
    unparsableSource: countRoundTrip("unparsable-source"),
  };
  return {
    schema: FLOW_CORPUS_REPORT_SCHEMA,
    resolverMode: "corpus-documents",
    // Round-trip fidelity is intentionally absent from this predicate: it is a
    // tracked measurement, not an admission gate. See FlowCorpusRoundTripStatus.
    passed:
      summary.ready === summary.total &&
      summary.changesRequired === 0 &&
      summary.invalid === 0 &&
      summary.hashMismatches === 0 &&
      summary.compileFailed === 0,
    summary,
    roundTrip,
    items,
  };
}

export function renderFlowCorpusQualificationMarkdown(
  report: FlowCorpusQualificationReport,
): string {
  const lines = [
    "# Flow Corpus Qualification",
    "",
    `Status: **${report.passed ? "passed" : "failed"}**`,
    "",
    "| Total | Strict-ready | Changes required | Invalid | Hash mismatches | Compile-ready | Compile-failed | Authoring-only |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.summary.total} | ${report.summary.ready} | ${report.summary.changesRequired} | ${report.summary.invalid} | ${report.summary.hashMismatches} | ${report.summary.compileReady} | ${report.summary.compileFailed} | ${report.summary.authoringOnly} |`,
    "",
    "## Formatter round trip (measured, not gated)",
    "",
    `Lossless: **${report.roundTrip.lossless} / ${report.roundTrip.total}**`,
    "",
    "| Lossless | Lossy | Not reparsable | Unparsable source |",
    "| ---: | ---: | ---: | ---: |",
    `| ${report.roundTrip.lossless} | ${report.roundTrip.lossy} | ${report.roundTrip.notReparsable} | ${report.roundTrip.unparsableSource} |`,
    "",
    "| Source | Hash | Qualification | Strict migration | Compile | Round trip | Diagnostics | Compatibility warnings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of report.items) {
    lines.push(
      `| \`${item.path}\` | ${item.hashMatches ? "match" : "mismatch"} | ${item.qualification} | ${item.status} | ${item.compileStatus} | ${item.roundTripStatus} | ${item.compileDiagnosticCodes.join(", ") || "none"} | ${item.compatibilityWarningCodes.join(", ") || "none"} |`,
    );
  }
  lines.push(
    "",
    "This is a provider-free authoring qualification. Placeholder tool and persona",
    "resolvers isolate parser, normalization, compiler, composition, and strict-reference drift;",
    "the result is not runtime, provider, deployment, or host-capability qualification.",
    "",
    "Formatter round-trip counts are reported for tracking and do NOT affect the",
    "pass/fail status above. A `lossy` row means formatter output reparsed but lost",
    "authored fields; never persist that output as a source of truth.",
    "",
    "Formatter round-trip counts are reported for tracking and do NOT affect the",
    "pass/fail status above. A `lossy` row means formatter output reparsed but lost",
    "authored fields; never persist that output as a source of truth.",
    "",
  );
  return lines.join("\n");
}

function uniqueCodes(
  diagnostics: readonly { code: string }[],
): string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
