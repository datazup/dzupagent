import { describe, expect, it } from "vitest";

import type { NodeStateWritePolicy } from "../definition.js";
import { PipelineNodeSchema } from "../schema.js";

// DZA-DSL-V2-EXECUTOR-S5-20261008-SW1: exact-port state writes are a
// persisted, optional part of a pipeline node.
function toolNode(stateWrites: unknown): Record<string, unknown> {
  return {
    id: "adapter_0",
    type: "tool",
    toolName: "dzup.runtime.adapter.run",
    arguments: {},
    stateWrites,
  };
}

function parses(stateWrites: unknown): boolean {
  return PipelineNodeSchema.safeParse(toolNode(stateWrites)).success;
}

describe("PipelineNodeBase.stateWrites", () => {
  it("admits one, optional and many bindings", () => {
    const policy: NodeStateWritePolicy = {
      bindings: [
        { port: "draft", key: "draft", cardinality: "one" },
        { port: "notes", key: "reviewNotes", cardinality: "optional" },
        { port: "tags", key: "tags_2", cardinality: "many" },
      ],
    };
    const parsed = PipelineNodeSchema.safeParse(toolNode(policy));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.stateWrites : undefined).toEqual(policy);
  });

  it("refuses empty policies, empty ports, invalid keys and unknown cardinalities", () => {
    const binding = { port: "draft", key: "draft", cardinality: "one" };
    expect(parses({ bindings: [] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, port: "" }] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, key: "" }] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, key: "state.draft" }] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, key: "1draft" }] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, cardinality: "some" }] })).toBe(false);
    expect(parses({ bindings: [{ ...binding, extra: 1 }] })).toBe(false);
    expect(parses({ bindings: [binding], extra: 1 })).toBe(false);
  });

  it("refuses more than 32 bindings", () => {
    const bindings = Array.from({ length: 33 }, (_, index) => ({
      port: `p${index}`,
      key: `k${index}`,
      cardinality: "one",
    }));
    expect(parses({ bindings: bindings.slice(0, 32) })).toBe(true);
    expect(parses({ bindings })).toBe(false);
  });

  it("refuses a key or a port bound twice", () => {
    expect(
      parses({
        bindings: [
          { port: "a", key: "same", cardinality: "one" },
          { port: "b", key: "same", cardinality: "one" },
        ],
      }),
    ).toBe(false);
    expect(
      parses({
        bindings: [
          { port: "same", key: "a", cardinality: "one" },
          { port: "same", key: "b", cardinality: "one" },
        ],
      }),
    ).toBe(false);
  });

  it("keeps nodes without the field valid", () => {
    expect(
      PipelineNodeSchema.safeParse({
        id: "adapter_0",
        type: "tool",
        toolName: "dzup.runtime.adapter.run",
      }).success,
    ).toBe(true);
  });
});
