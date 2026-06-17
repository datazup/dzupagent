/**
 * DSL normalization + round-trip coverage for the `adapter.supervisor` wrapper
 * (adapter-DSL study Phase 3.3 / SPEC-IMPL-1, spec §5.3). Decomposes a `goal`
 * into subtasks (LLM-driven, resolving OQ-1) and delegates to specialists.
 */
import { describe, expect, it } from "vitest";

import { normalizeDslDocument } from "../normalize.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { canonicalizeDsl } from "../canonicalize-dsl.js";
import type {
  AdapterSupervisorNode,
  FlowDocumentV1,
} from "@dzupagent/flow-ast";

function makeRaw(steps: unknown[]): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1alpha-agent",
    id: "supervisor-flow",
    version: 1,
    steps,
  };
}

function supervisorStep(
  node: Record<string, unknown>
): Record<string, unknown> {
  return { "adapter.supervisor": node };
}

describe("normalizeDslDocument — adapter.supervisor wrapper", () => {
  it("round-trips a full adapter.supervisor node with all fields", () => {
    const raw = makeRaw([
      supervisorStep({
        id: "ship",
        goal: "Ship: {{ input.spec }}",
        specialists: ["claude", "codex", "reasoning"],
        model: "claude-opus-4-8",
        systemPrompt: "You coordinate",
        input: { spec: "x" },
        persona: "lead",
        reasoning: "high",
        outputSchema: "result.v1",
        promptPrep: "auto",
        idempotency: "idempotent",
        policy: { timeoutMs: 90000 },
        output: "result",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterSupervisorNode | undefined;
    expect(node?.type).toBe("adapter.supervisor");
    expect(node?.goal).toBe("Ship: {{ input.spec }}");
    expect(node?.specialists).toEqual(["claude", "codex", "reasoning"]);
    expect(node?.output).toBe("result");
    expect(node?.idempotency).toBe("idempotent");
  });

  it("normalizes a supervisor without specialists (registry routing)", () => {
    const raw = makeRaw([
      supervisorStep({
        id: "s1",
        goal: "Decompose and ship",
        output: "result",
      }),
    ]);
    const { document, diagnostics } = normalizeDslDocument(raw);
    expect(diagnostics).toEqual([]);
    const node = document?.root.nodes[0] as AdapterSupervisorNode | undefined;
    expect(node?.specialists).toBeUndefined();
  });

  it("reports MISSING_REQUIRED_FIELD for missing goal", () => {
    const raw = makeRaw([supervisorStep({ id: "s1", output: "result" })]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) => d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".goal")
      )
    ).toBe(true);
  });

  it("reports MISSING_REQUIRED_FIELD for missing output", () => {
    const raw = makeRaw([supervisorStep({ id: "s1", goal: "Do it" })]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" && d.path?.endsWith(".output")
      )
    ).toBe(true);
  });

  it("reports INVALID_NODE_SHAPE for non-string specialists", () => {
    const raw = makeRaw([
      supervisorStep({
        id: "s1",
        goal: "Do it",
        specialists: ["claude", 9],
        output: "result",
      }),
    ]);
    const { diagnostics } = normalizeDslDocument(raw);
    expect(
      diagnostics.some(
        (d) =>
          d.code === "INVALID_NODE_SHAPE" && d.path?.endsWith(".specialists")
      )
    ).toBe(true);
  });

  it("reports UNSUPPORTED_FIELD for an unknown field", () => {
    const raw = makeRaw([
      supervisorStep({
        id: "s1",
        goal: "Do it",
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

describe("adapter.supervisor — YAML round-trip", () => {
  it("format -> parse preserves a full adapter.supervisor node", () => {
    const original: AdapterSupervisorNode = {
      type: "adapter.supervisor",
      id: "ship",
      goal: "Ship the feature",
      specialists: ["claude", "codex"],
      model: "claude-opus-4-8",
      systemPrompt: "You coordinate",
      input: { spec: "x" },
      persona: "lead",
      reasoning: "high",
      outputSchema: "result.v1",
      promptPrep: "auto",
      idempotency: "idempotent",
      output: "result",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "supervisor-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });

  it("format -> parse preserves a minimal supervisor (no specialists)", () => {
    const original: AdapterSupervisorNode = {
      type: "adapter.supervisor",
      id: "s1",
      goal: "Decompose and deliver",
      output: "result",
    };
    const document: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "supervisor-flow",
      version: 1,
      root: { type: "sequence", id: "root", nodes: [original] },
    };

    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes[0]).toEqual(original);
  });
});
