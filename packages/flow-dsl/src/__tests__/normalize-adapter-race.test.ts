/**
 * DSL normalization + round-trip coverage for the `adapter.race` wrapper
 * (adapter-DSL study Phase 3.1 / SPEC-IMPL-1, spec §5.1). An `adapter.race`
 * node races the same prompt across ≥2 providers; the first successful result
 * wins.
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { canonicalizeDsl } from "../canonicalize-dsl.js";
import type { AdapterRaceNode, FlowDocumentV1 } from "@dzupagent/flow-ast";

function makeRaw(steps: unknown[]): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "race-flow",
    version: 1,
    steps,
  };
}

function raceStep(node: Record<string, unknown>): Record<string, unknown> {
  return { "adapter.race": node };
}

describe("normalizeDslDocument — adapter.race wrapper", () => {
  it("round-trips a full adapter.race node with all fields", () => {
    const raw = makeRaw([
      raceStep({
        id: "race-impl",
        providers: ["claude", "codex"],
        model: "claude-opus-4-8",
        systemPrompt: "You are an implementer",
        instructions: "Implement: {{ input.featureSpec }}",
        input: { spec: "x" },
        persona: "implementer",
        reasoning: "high",
        outputSchema: "impl.v1",
        promptPrep: "auto",
        idempotency: "idempotent",
        policy: { timeoutMs: 60000 },
        output: "bestImpl",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterRaceNode | undefined;
    expect(node?.type).toBe("adapter.race");
    expect(node?.providers).toEqual(["claude", "codex"]);
    expect(node?.instructions).toBe("Implement: {{ input.featureSpec }}");
    expect(node?.output).toBe("bestImpl");
    expect(node?.reasoning).toBe("high");
    expect(node?.idempotency).toBe("idempotent");
    expect(node?.policy).toEqual({ timeoutMs: 60000 });
  });

  it("reports INVALID_NODE_SHAPE for fewer than 2 providers", () => {
    const raw = makeRaw([
      raceStep({
        id: "r1",
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

  it("reports INVALID_NODE_SHAPE for an unknown provider in the list", () => {
    const raw = makeRaw([
      raceStep({
        id: "r1",
        providers: ["claude", "cursor"],
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

  it("reports MISSING_REQUIRED_FIELD for missing instructions", () => {
    const raw = makeRaw([
      raceStep({ id: "r1", providers: ["claude", "codex"], output: "out" }),
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
      raceStep({
        id: "r1",
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

  it("reports UNSUPPORTED_FIELD for an unknown field", () => {
    const raw = makeRaw([
      raceStep({
        id: "r1",
        providers: ["claude", "codex"],
        instructions: "Run",
        output: "out",
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

describe("adapter.race — YAML round-trip", () => {
  it("format -> parse preserves a full adapter.race node", () => {
    const original: AdapterRaceNode = {
      type: "adapter.race",
      id: "race-impl",
      providers: ["claude", "codex"],
      model: "claude-opus-4-8",
      systemPrompt: "You are an implementer",
      instructions: "Implement the feature",
      input: { spec: "x" },
      persona: "implementer",
      reasoning: "high",
      outputSchema: "impl.v1",
      promptPrep: "auto",
      idempotency: "idempotent",
      output: "bestImpl",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "race-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });

  it("format -> parse preserves a minimal adapter.race node", () => {
    const original: AdapterRaceNode = {
      type: "adapter.race",
      id: "r1",
      providers: ["claude", "gemini"],
      instructions: "Race it",
      output: "winner",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "race-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });
});
