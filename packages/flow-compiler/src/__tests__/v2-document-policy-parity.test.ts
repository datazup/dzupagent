import type { FlowDocumentPolicy } from "@dzupagent/flow-ast";
import { parseDslToDocument } from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import { compileTextInput, createFlowCompiler } from "../index.js";

function source(version: "v1" | "v2", policy?: FlowDocumentPolicy): string {
  const policyText = policy === undefined ? "" : `policy:\n${Object.entries(policy).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n")}\n`;
  return `dsl: dzupflow/${version}\nid: compiled-policy\nversion: ${version === "v1" ? "1" : "2.0.0"}\n${policyText}steps:\n` +
    (version === "v1" ? "  - set:\n      id: seed\n      assign:\n        ready: true\n  - complete:\n      id: done\n      result: accepted\n" :
      "  - id: seed\n    use: core.set@1\n    with:\n      assign:\n        ready: true\n  - id: done\n    use: core.complete@1\n    with:\n      result: accepted\n");
}

const resolver = { resolve: () => null, listAvailable: () => [] };

describe("DSL-MVP-POLICY-01 compiler document-policy parity", () => {
  it.each<[string, FlowDocumentPolicy | undefined]>([
    ["absent", undefined], ["budget", { budgetCents: 125 }], ["timeout", { timeoutMs: 5000 }],
    ["directory", { workingDirectory: "/workspace/packet" }],
    ["full", { budgetCents: 125, timeoutMs: 5000, workingDirectory: "/workspace/packet" }],
  ])("preserves %s policy across every document frontend", async (_name, policy) => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const v1 = source("v1", policy);
    const v2 = source("v2", policy);
    const canonical = parseDslToDocument(v1);
    if (!canonical.ok) throw new Error(JSON.stringify(canonical.diagnostics));
    const results = [
      await compiler.compileDsl(v1), await compiler.compileDsl(v2),
      await compiler.compileDocument(canonical.document), await compileTextInput(compiler, v2),
      await compileTextInput(compiler, JSON.stringify(canonical.document)),
    ];
    const baseline = results[0];
    if (baseline === undefined || "errors" in baseline) throw new Error(JSON.stringify(baseline));
    for (const result of results) {
      if ("errors" in result) throw new Error(JSON.stringify(result.errors));
      expect(result.documentPolicy).toEqual(policy);
      expect(result.target).toBe(baseline.target);
      expect(result.requirements.semanticHash).toBe(baseline.requirements.semanticHash);
      // Pipeline artifact/node IDs are generated per compile. Pin the full
      // canonical flow metadata and executable payload instead of erasing IDs.
      expect(result.target).toBe("planning-dag");
      expect(result.artifact).toMatchObject({
        metadata: { flow: { nodes: {
          root: { id: "root", type: "sequence" },
          "root.nodes[0]": { id: "seed", type: "set" },
          "root.nodes[1]": { id: "done", type: "complete" },
        } } },
        nodes: [
          { type: "tool", toolName: "dzup.runtime.set", arguments: { assign: { ready: true } } },
          { type: "suspend", description: "accepted" },
        ],
      });
    }
    const second = results[1];
    const doc = results[2];
    if (second === undefined || doc === undefined || "errors" in second || "errors" in doc) throw new Error("missing successful frontends");
    expect(second.evidence.sourceHash).not.toBe(baseline.evidence.sourceHash);
    expect(second.compileId).not.toBe(baseline.compileId);
    expect(second.evidence.sourceKind).toBe("dzupflow-dsl");
    expect(doc.evidence.sourceKind).toBe("flow-document");
  });

  it.each([0, -1])("rejects invalid policy %s before artifact emission", async (budgetCents) => {
    const compiler = createFlowCompiler({ toolResolver: resolver });
    const result = await compiler.compileDsl(source("v2", { budgetCents }));
    expect("artifact" in result).toBe(false);
    if (!("errors" in result)) throw new Error("invalid policy compiled");
    expect(result.errors).toContainEqual(expect.objectContaining({ nodePath: "root.policy.budgetCents" }));
  });
});
