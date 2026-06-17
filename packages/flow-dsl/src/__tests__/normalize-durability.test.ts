/**
 * P0 — DSL Durability Contract (flow-dsl round-trip).
 *
 * The top-level `durability` block must survive normalization onto
 * FlowDocumentV1. Deep field validation lives in flow-ast; flow-dsl only
 * carries the block through and rejects a non-object.
 */
import { describe, it, expect } from "vitest";
import { normalizeDslDocument } from "../normalize.js";

function makeRaw(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "durability-flow",
    version: 1,
    steps: [{ action: { id: "step1", ref: "skill:do", input: {} } }],
    ...overrides,
  };
}

describe("normalizeDslDocument — durability", () => {
  it("round-trips a durability block onto the document", () => {
    const { ok, document, diagnostics } = normalizeDslDocument(
      makeRaw({
        durability: {
          mode: "durable",
          checkpoint: { strategy: "after_each_node" },
          resume: { onProcessRestart: "resume_from_checkpoint" },
        },
      }),
    );
    expect(ok).toBe(true);
    expect(diagnostics).toHaveLength(0);
    expect(document?.durability?.mode).toBe("durable");
    expect(document?.durability?.checkpoint?.strategy).toBe("after_each_node");
    expect(document?.durability?.resume?.onProcessRestart).toBe(
      "resume_from_checkpoint",
    );
  });

  it("leaves durability absent when not declared (backward compatible)", () => {
    const { ok, document } = normalizeDslDocument(makeRaw());
    expect(ok).toBe(true);
    expect(document?.durability).toBeUndefined();
  });

  it("does not flag durability as an unsupported top-level field", () => {
    const { diagnostics } = normalizeDslDocument(
      makeRaw({ durability: { mode: "checkpointed" } }),
    );
    expect(
      diagnostics.some((d) => /Unsupported top-level field/.test(d.message)),
    ).toBe(false);
  });

  it("emits a diagnostic when durability is not an object", () => {
    const { ok, diagnostics } = normalizeDslDocument(
      makeRaw({ durability: "durable" }),
    );
    expect(ok).toBe(false);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
