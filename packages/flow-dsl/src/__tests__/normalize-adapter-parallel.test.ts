/**
 * DSL normalization + round-trip coverage for the `adapter.parallel` wrapper
 * (adapter-DSL study Phase 3.2 / SPEC-IMPL-1, spec §5.2). Fans the same prompt
 * out to ≥2 providers concurrently and merges per `merge` (default `all`).
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { canonicalizeDsl } from "../canonicalize-dsl.js";
import type { AdapterParallelNode, FlowDocumentV1 } from "@dzupagent/flow-ast";

function makeRaw(steps: unknown[]): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "parallel-flow",
    version: 1,
    steps,
  };
}

function parallelStep(node: Record<string, unknown>): Record<string, unknown> {
  return { "adapter.parallel": node };
}

describe("normalizeDslDocument — adapter.parallel wrapper", () => {
  it("round-trips a full adapter.parallel node with all fields", () => {
    const raw = makeRaw([
      parallelStep({
        id: "fanout",
        providers: ["claude", "codex", "gemini"],
        merge: "all",
        model: "claude-opus-4-8",
        systemPrompt: "You draft",
        instructions: "Draft: {{ input.brief }}",
        input: { brief: "x" },
        persona: "drafter",
        reasoning: "medium",
        outputSchema: "drafts.v1",
        promptPrep: "auto",
        idempotency: "idempotent",
        policy: { timeoutMs: 45000 },
        output: "drafts",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterParallelNode | undefined;
    expect(node?.type).toBe("adapter.parallel");
    expect(node?.providers).toEqual(["claude", "codex", "gemini"]);
    expect(node?.merge).toBe("all");
    expect(node?.output).toBe("drafts");
  });

  it("accepts each valid merge mode", () => {
    for (const merge of ["first-wins", "all", "best-of-n"]) {
      const raw = makeRaw([
        parallelStep({
          id: "p1",
          providers: ["claude", "codex"],
          merge,
          instructions: "Run",
          output: "out",
        }),
      ]);
      const { document, diagnostics } = normalizeDslDocument(raw);
      expect(diagnostics).toEqual([]);
      const node = document?.root.nodes[0] as AdapterParallelNode | undefined;
      expect(node?.merge).toBe(merge);
    }
  });

  it("reports INVALID_ENUM_VALUE for an invalid merge mode", () => {
    const raw = makeRaw([
      parallelStep({
        id: "p1",
        providers: ["claude", "codex"],
        merge: "zip",
        instructions: "Run",
        output: "out",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".merge")
      )
    ).toBe(true);
  });

  it("reports INVALID_NODE_SHAPE for fewer than 2 providers", () => {
    const raw = makeRaw([
      parallelStep({
        id: "p1",
        providers: ["claude"],
        instructions: "Run",
        output: "out",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "INVALID_NODE_SHAPE" && d.path?.endsWith(".providers")
      )
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing output", () => {
    const raw = makeRaw([
      parallelStep({
        id: "p1",
        providers: ["claude", "codex"],
        instructions: "Run",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".output")
      )
    ).toBe(true);
  });
});

describe("adapter.parallel — YAML round-trip", () => {
  it("format -> parse preserves a full adapter.parallel node", () => {
    const original: AdapterParallelNode = {
      type: "adapter.parallel",
      id: "fanout",
      providers: ["claude", "codex"],
      merge: "best-of-n",
      model: "claude-opus-4-8",
      systemPrompt: "You draft",
      instructions: "Draft the feature",
      input: { brief: "x" },
      persona: "drafter",
      reasoning: "medium",
      outputSchema: "drafts.v1",
      promptPrep: "auto",
      idempotency: "idempotent",
      output: "drafts",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "parallel-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });

  it("format -> parse preserves a minimal adapter.parallel node (no merge)", () => {
    const original: AdapterParallelNode = {
      type: "adapter.parallel",
      id: "p1",
      providers: ["claude", "gemini"],
      instructions: "Fan out",
      output: "results",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "parallel-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });
});
