import { createHash } from "node:crypto";

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
  return {
    schema: FLOW_CORPUS_REPORT_SCHEMA,
    resolverMode: "corpus-documents",
    passed:
      summary.ready === summary.total &&
      summary.changesRequired === 0 &&
      summary.invalid === 0 &&
      summary.hashMismatches === 0 &&
      summary.compileFailed === 0,
    summary,
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
    "| Source | Hash | Qualification | Strict migration | Compile | Diagnostics | Compatibility warnings |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of report.items) {
    lines.push(
      `| \`${item.path}\` | ${item.hashMatches ? "match" : "mismatch"} | ${item.qualification} | ${item.status} | ${item.compileStatus} | ${item.compileDiagnosticCodes.join(", ") || "none"} | ${item.compatibilityWarningCodes.join(", ") || "none"} |`,
    );
  }
  lines.push(
    "",
    "This is a provider-free authoring qualification. Placeholder tool and persona",
    "resolvers isolate parser, normalization, compiler, composition, and strict-reference drift;",
    "the result is not runtime, provider, deployment, or host-capability qualification.",
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
