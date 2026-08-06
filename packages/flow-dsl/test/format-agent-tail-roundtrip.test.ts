/**
 * F-R1 agent-node formatter tail: every optional agent field that
 * normalize/parse admit must survive format -> reparse (doc 14 DSL-01).
 * Before this slice the formatter emitted only
 * agentId/profile/toolset/model/instructions/output.key/output.schemaRef —
 * provider, tools, input, stop, onInvalidOutput, retry, validation, policy
 * and inline output.schema were authored, validated, then silently erased.
 * An inline-schema-only agent even formatted into an INVALID document
 * (output requires schemaRef or schema; neither was emitted).
 */
import { describe, expect, it } from "vitest";
import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import { formatDocumentToDslChecked } from "../src/format-dsl.js";

function agentDoc(
  node: FlowDocumentV1["root"]["nodes"][number]
): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "agent-tail-fixture",
    version: 1,
    root: { type: "sequence", id: "root", nodes: [node] },
  };
}

function expectLossless(document: FlowDocumentV1): string {
  const result = formatDocumentToDslChecked(document);
  if (!result.ok) {
    throw new Error(
      `formatter lost authored fields: ${result.lossPaths.join(
        ", "
      )}\n--- dsl ---\n${result.dsl}`
    );
  }
  return result.dsl;
}

describe("agent-node formatter tail round-trips (DSL-01)", () => {
  it("round-trips the full optional tail", () => {
    const dsl = expectLossless(
      agentDoc({
        type: "agent",
        id: "writer",
        agentId: "docs-writer",
        profile: "balanced",
        toolset: "docs",
        tools: ["fs.read", "fs.write"],
        model: "claude-sonnet",
        provider: "anthropic",
        instructions: "Write the release notes.",
        input: { branch: "main", sections: ["fixes", "features"] },
        stop: { maxIterations: 6, maxToolCalls: 40, requireFinalSchema: true },
        output: { key: "releaseNotes", schemaRef: "schema:release-notes" },
        onInvalidOutput: { retry: 2, repairPrompt: true },
        retry: {
          onToolError: { attempts: 2 },
          onModelUnavailable: { attempts: 1, fallbackProfile: "fast" },
        },
        validation: {
          required: [{ id: "lint", command: "yarn lint" }],
          repair: { maxAttempts: 2 },
        },
        policy: {
          timeoutMs: 60000,
          budgetCents: 250,
          approval: { requiredFor: ["shell"] },
          audit: { captureToolCalls: true },
        },
      })
    );
    for (const key of [
      "provider: anthropic",
      "tools:",
      "input:",
      "stop:",
      "onInvalidOutput:",
      "retry:",
      "validation:",
      "policy:",
    ]) {
      expect(dsl).toContain(key);
    }
  });

  it("round-trips an inline output.schema (previously formatted into an invalid document)", () => {
    const dsl = expectLossless(
      agentDoc({
        type: "agent",
        id: "extractor",
        agentId: "extract-facts",
        instructions: "Extract the facts.",
        output: {
          key: "facts",
          schema: {
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
          },
        },
      })
    );
    expect(dsl).toContain("schema:");
  });
});
