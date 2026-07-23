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
  status: StrictReferenceMigrationItem["status"];
  compatibilityDiagnosticCodes: string[];
  compatibilityWarningCodes: string[];
  strictDiagnosticCodes: string[];
  blockingReferenceCodes: string[];
}

export interface FlowCorpusQualificationReport {
  schema: typeof FLOW_CORPUS_REPORT_SCHEMA;
  resolverMode: "placeholder-authoring";
  passed: boolean;
  summary: {
    total: number;
    ready: number;
    changesRequired: number;
    invalid: number;
    hashMismatches: number;
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
    if (ids.has(id)) throw new Error(`duplicate manifest entry id "${id}"`);
    if (paths.has(path)) {
      throw new Error(`duplicate manifest entry path "${path}"`);
    }
    ids.add(id);
    paths.add(path);
    return { id, path, sha256 };
  });

  return { schema: FLOW_CORPUS_MANIFEST_SCHEMA, entries };
}

export function hashFlowCorpusSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export async function qualifyFlowCorpusSources(
  sources: readonly LoadedFlowCorpusSource[],
  compiler: Pick<FlowCompiler, "analyzeStrictReferenceMigration">,
): Promise<FlowCorpusQualificationReport> {
  const migration = await compiler.analyzeStrictReferenceMigration(
    sources.map(({ id, source }) => ({ id, kind: "dsl", input: source })),
  );
  const migrationById = new Map(
    migration.items.map((item) => [item.id, item]),
  );

  const items = sources.map((source) => {
    const migrationItem = migrationById.get(source.id);
    if (migrationItem === undefined) {
      throw new Error(`migration result is missing source "${source.id}"`);
    }
    const actualSha256 = hashFlowCorpusSource(source.source);
    return {
      id: source.id,
      path: source.path,
      expectedSha256: source.sha256,
      actualSha256,
      hashMatches: actualSha256 === source.sha256,
      status: migrationItem.status,
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
  };
  return {
    schema: FLOW_CORPUS_REPORT_SCHEMA,
    resolverMode: "placeholder-authoring",
    passed:
      summary.ready === summary.total &&
      summary.changesRequired === 0 &&
      summary.invalid === 0 &&
      summary.hashMismatches === 0,
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
    "| Total | Strict-ready | Changes required | Invalid | Hash mismatches |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${report.summary.total} | ${report.summary.ready} | ${report.summary.changesRequired} | ${report.summary.invalid} | ${report.summary.hashMismatches} |`,
    "",
    "| Source | Hash | Strict migration | Compatibility warnings |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.items) {
    lines.push(
      `| \`${item.path}\` | ${item.hashMatches ? "match" : "mismatch"} | ${item.status} | ${item.compatibilityWarningCodes.join(", ") || "none"} |`,
    );
  }
  lines.push(
    "",
    "This is a provider-free authoring qualification. Placeholder tool and persona",
    "resolvers isolate parser, normalization, compiler, and strict-reference drift;",
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
