/**
 * DSL normalization + round-trip coverage for the `adapter.run` wrapper
 * (adapter-DSL study Phase 1.2 / SPEC-IMPL-1). An `adapter.run` node hands a
 * single routed in-process agent-adapter call to the runtime, selecting the
 * adapter by explicit `provider` or by capability `tags`.
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { canonicalizeDsl } from "../canonicalize-dsl.js";
import type { AdapterRunNode, FlowDocumentV1 } from "@dzupagent/flow-ast";

function makeRaw(
  steps: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "adapter-flow",
    version: 1,
    steps,
    ...extra,
  };
}

function adapterStep(node: Record<string, unknown>): Record<string, unknown> {
  return { "adapter.run": node };
}

describe("normalizeDslDocument — adapter.run wrapper", () => {
  it("round-trips a full explicit-provider adapter.run node with all fields", () => {
    const raw = makeRaw([
      adapterStep({
        id: "summarize",
        provider: "claude",
        model: "claude-opus-4-8",
        systemPrompt: "You are a careful reviewer",
        instructions: "Summarize: {{ state.verifyOutput }}",
        input: { ctx: "diff" },
        persona: "reviewer",
        reasoning: "high",
        outputSchema: "summary.v1",
        promptPrep: "auto",
        idempotency: "idempotent",
        policy: { timeoutMs: 30000 },
        output: "summary",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterRunNode | undefined;
    expect(node?.type).toBe("adapter.run");
    expect(node?.provider).toBe("claude");
    expect(node?.model).toBe("claude-opus-4-8");
    expect(node?.systemPrompt).toBe("You are a careful reviewer");
    expect(node?.instructions).toBe("Summarize: {{ state.verifyOutput }}");
    expect(node?.input).toEqual({ ctx: "diff" });
    expect(node?.persona).toBe("reviewer");
    expect(node?.reasoning).toBe("high");
    expect(node?.outputSchema).toBe("summary.v1");
    expect(node?.promptPrep).toBe("auto");
    expect(node?.idempotency).toBe("idempotent");
    expect(node?.policy).toEqual({ timeoutMs: 30000 });
    expect(node?.output).toBe("summary");
  });

  it("normalizes a tags-routed adapter.run node without an explicit provider", () => {
    const raw = makeRaw([
      adapterStep({
        id: "route",
        tags: ["reasoning", "long-context"],
        instructions: "Plan the work",
        output: "plan",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterRunNode | undefined;
    expect(node?.type).toBe("adapter.run");
    expect(node?.tags).toEqual(["reasoning", "long-context"]);
    expect(node?.provider).toBeUndefined();
  });

  it("accepts every supported provider value", () => {
    for (const provider of [
      "claude",
      "codex",
      "gemini",
      "openai",
      "openrouter",
      "qwen",
      "goose",
      "crush",
    ] as const) {
      const raw = makeRaw([
        adapterStep({
          id: `a-${provider}`,
          provider,
          instructions: "Run",
          output: "result",
        }),
      ]);
      const { document, diagnostics } = normalizeDslDocument(raw);
      expect(diagnostics).toEqual([]);
      const node = document?.root.nodes[0] as AdapterRunNode | undefined;
      expect(node?.provider).toBe(provider);
    }
  });

  it("reports MISSING_REQUIRED_FIELD when neither provider nor tags is given", () => {
    const raw = makeRaw([
      adapterStep({ id: "a1", instructions: "Run", output: "result" }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".provider")
      )
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing instructions", () => {
    const raw = makeRaw([
      adapterStep({ id: "a1", provider: "claude", output: "result" }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path?.endsWith(".instructions")
      )
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing output", () => {
    const raw = makeRaw([
      adapterStep({ id: "a1", provider: "claude", instructions: "Run" }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".output")
      )
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown provider", () => {
    const raw = makeRaw([
      adapterStep({
        id: "a1",
        provider: "cursor",
        instructions: "Run",
        output: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".provider")
      )
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown reasoning level", () => {
    const raw = makeRaw([
      adapterStep({
        id: "a1",
        provider: "claude",
        instructions: "Run",
        output: "result",
        reasoning: "extreme",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".reasoning")
      )
    ).toBe(true);
  });

  it("reports INVALID_ENUM_VALUE for an unknown idempotency mode", () => {
    const raw = makeRaw([
      adapterStep({
        id: "a1",
        provider: "claude",
        instructions: "Run",
        output: "result",
        idempotency: "maybe-once",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_ENUM_VALUE" && d.path?.endsWith(".idempotency")
      )
    ).toBe(true);
  });

  it("reports UNSUPPORTED_FIELD for an unknown field", () => {
    const raw = makeRaw([
      adapterStep({
        id: "a1",
        provider: "claude",
        instructions: "Run",
        output: "result",
        nonsense: true,
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "UNSUPPORTED_FIELD" && d.path?.endsWith(".nonsense")
      )
    ).toBe(true);
  });
});

describe("adapter.run — YAML round-trip", () => {
  it("format -> parse preserves a full explicit-provider adapter.run node", () => {
    const original: AdapterRunNode = {
      type: "adapter.run",
      id: "summarize",
      provider: "claude",
      model: "claude-opus-4-8",
      systemPrompt: "You are a careful reviewer",
      instructions: "Summarize the diff",
      input: { ctx: "diff" },
      persona: "reviewer",
      reasoning: "high",
      outputSchema: "summary.v1",
      promptPrep: "auto",
      idempotency: "idempotent",
      output: "summary",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "adapter-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const yaml = formatDocumentToDsl(document);
    const result = canonicalizeDsl(yaml);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });

  it("format -> parse preserves a minimal tags-routed adapter.run node", () => {
    const original: AdapterRunNode = {
      type: "adapter.run",
      id: "route",
      tags: ["reasoning"],
      instructions: "Plan it",
      output: "plan",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "adapter-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });
});
