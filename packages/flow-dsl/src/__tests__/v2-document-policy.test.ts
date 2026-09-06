import type { FlowDocumentPolicy } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../parse-dsl.js";
import {
  formatDslV2Document,
  importDslV2Source,
  previewDslV1ToV2Migration,
} from "../v2-authoring.js";

const FULL_POLICY = { budgetCents: 125, timeoutMs: 5000, workingDirectory: "/workspace/packet" };

function document(policy?: unknown) {
  return {
    dsl: "dzupflow/v2", id: "document-policy", version: "2.0.0",
    ...(policy === undefined ? {} : { policy }),
    steps: [{ id: "done", use: "core.complete@1", with: { result: "accepted" } }],
  };
}

function source(version: "v1" | "v2", policy?: unknown): string {
  const policyText = policy === undefined ? "" :
    policy !== null && typeof policy === "object" && !Array.isArray(policy) && Object.keys(policy).length > 0
      ? `policy:\n${Object.entries(policy).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n")}\n`
      : `policy: ${JSON.stringify(policy)}\n`;
  return `dsl: dzupflow/${version}\nid: document-policy\nversion: ${version === "v1" ? "1" : "2.0.0"}\n${policyText}steps:\n` +
    (version === "v1" ? "  - complete:\n      id: done\n      result: accepted\n" :
      "  - id: done\n    use: core.complete@1\n    with:\n      result: accepted\n");
}

function formatted(policy?: unknown) {
  const result = formatDslV2Document(document(policy));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

describe("DSL-MVP-POLICY-01 document policy", () => {
  it.each<[string, FlowDocumentPolicy | undefined]>([
    ["absent", undefined], ["budget", { budgetCents: 125 }],
    ["timeout", { timeoutMs: 5000 }], ["directory", { workingDirectory: "/workspace/packet" }],
    ["full", FULL_POLICY], ["empty", {}], ["empty directory", { workingDirectory: "" }],
  ])("preserves %s policy through parsing, formatting and exact migration", (_name, policy) => {
    const v1 = parseDslToDocument(source("v1", policy));
    const v2 = parseDslToDocument(source("v2", policy));
    expect(v1.ok).toBe(true);
    expect(v2.diagnostics).toEqual([]);
    expect(v2.document).toEqual(v1.document);
    expect(v2.document?.policy).toEqual(policy);
    const result = formatted(policy);
    expect(result.canonicalDocument).toEqual(v1.document);
    expect(importDslV2Source(result.canonicalSource)).toEqual(result);
    const report = previewDslV1ToV2Migration(source("v1", policy));
    expect(report.classification).toBe("equivalent");
    expect(report.canonicalEquivalent).toBe(true);
    expect(report.sourceSemanticSha256).toBe(report.candidateSemanticSha256);
    if (report.candidateSource === undefined) throw new Error("missing exact candidate");
    expect(parseDslToDocument(report.candidateSource).document).toEqual(v1.document);
    expect(report.authority).toMatchObject({ reportOnlyMigration: true, documentMutation: false, runtimeExecution: false });
    if (policy === undefined) {
      expect(result.document).not.toHaveProperty("policy");
      expect(report.candidateSource).not.toContain("policy:");
    }
  });

  it.each([
    ["null", null], ["array", []], ["string", "125"],
    ["string budget", { budgetCents: "125" }], ["zero budget", { budgetCents: 0 }],
    ["negative budget", { budgetCents: -1 }], ["string timeout", { timeoutMs: "5000" }],
    ["zero timeout", { timeoutMs: 0 }], ["negative timeout", { timeoutMs: -1 }],
    ["numeric directory", { workingDirectory: 1 }],
  ])("rejects %s with policy diagnostics and no migration candidate", (_name, policy) => {
    const parsed = parseDslToDocument(source("v2", policy));
    expect(parsed.ok).toBe(false);
    expect(parsed.document).toBeNull();
    const diagnostic = parsed.diagnostics.find((item) => item.path?.startsWith("root.policy"));
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.span?.lineStart).toBeGreaterThanOrEqual(4);
    const imported = importDslV2Source(source("v2", policy));
    expect(imported.ok).toBe(false);
    expect(imported.diagnostics.some((item) => item.path?.startsWith("root.policy"))).toBe(true);
    const report = previewDslV1ToV2Migration(source("v1", policy));
    expect(report.classification).toBe("invalid");
    expect(report).not.toHaveProperty("candidateSource");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-JSON numeric policy %s at authoring", (value) => {
    for (const key of ["budgetCents", "timeoutMs"]) {
      const result = formatDslV2Document(document({ [key]: value }));
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "V2_AUTHORING_NON_JSON_VALUE", path: `root.policy.${key}` })]);
    }
  });

  it("preserves semantic identity across key order while retaining source-specific hashes", () => {
    const reordered = { workingDirectory: FULL_POLICY.workingDirectory, timeoutMs: 5000, budgetCents: 125 };
    expect(formatted(FULL_POLICY)).toEqual(formatted(reordered));
    const originalSource = source("v1", FULL_POLICY);
    const first = previewDslV1ToV2Migration(originalSource);
    expect(previewDslV1ToV2Migration(originalSource)).toEqual(first);
    const second = previewDslV1ToV2Migration(source("v1", reordered));
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(second.sourceSemanticSha256).toBe(first.sourceSemanticSha256);
    expect(second.candidateSourceSha256).toBe(first.candidateSourceSha256);
    expect(formatted(FULL_POLICY).canonicalSource.indexOf("\npolicy:")).toBeLessThan(formatted(FULL_POLICY).canonicalSource.indexOf("\nsteps:"));
  });

  it.each<FlowDocumentPolicy>([
    { ...FULL_POLICY, budgetCents: 126 }, { ...FULL_POLICY, timeoutMs: 5001 },
    { ...FULL_POLICY, workingDirectory: "/workspace/another-packet" },
  ])("binds each changed policy value into semantic identity: %j", (policy) => {
    expect(formatted(policy).semanticSha256).not.toBe(formatted(FULL_POLICY).semanticSha256);
  });

  it("does not mutate frozen caller data", () => {
    const raw = document(Object.freeze({ ...FULL_POLICY }));
    Object.freeze(raw.steps[0]?.with);
    Object.freeze(raw.steps[0]);
    Object.freeze(raw.steps);
    Object.freeze(raw);
    const before = JSON.stringify(raw);
    expect(formatDslV2Document(raw).ok).toBe(true);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("retains unknown-field rejection and lossy migration guards", () => {
    const unknown = formatDslV2Document({ ...document(FULL_POLICY), inventedPolicy: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_FIELD", path: "root.inventedPolicy" }));
    const lossy = previewDslV1ToV2Migration(source("v1", FULL_POLICY).replace("      result:", "      description: Keep this metadata\n      result:"));
    expect(lossy.classification).toBe("lossy");
    expect(lossy).not.toHaveProperty("candidateSource");
  });
});
