import { describe, expect, it } from "vitest";
import {
  createPrimitiveRegistry,
  BUILT_IN_PRIMITIVES,
  type PrimitiveDefinition,
} from "../primitives/index.js";

describe("primitive registry", () => {
  it("resolves built-in primitives by kind and version", () => {
    const registry = createPrimitiveRegistry(BUILT_IN_PRIMITIVES);
    const adapterRun = registry.get("adapter.run", "1");

    expect(adapterRun?.kind).toBe("adapter.run");
    expect(adapterRun?.version).toBe("1");
    expect(adapterRun?.category).toBe("leaf");
    expect(adapterRun?.effectClass).toBe("llm");
  });

  it("rejects duplicate kind/version registrations", () => {
    const primitive: PrimitiveDefinition = {
      kind: "test.echo",
      version: "1",
      namespace: "test",
      category: "leaf",
      schema: { type: "object" },
    };

    expect(() => createPrimitiveRegistry([primitive, primitive])).toThrow(
      /duplicate primitive test\.echo@1/i,
    );
  });

  it("registers collab.review_loop with a composite expander", () => {
    const registry = createPrimitiveRegistry(BUILT_IN_PRIMITIVES);
    const reviewLoop = registry.get("collab.review_loop", "1");

    expect(reviewLoop?.category).toBe("composite");
    expect(reviewLoop?.expandsTo).toEqual([
      "adapter.run",
      "validate",
      "if",
      "approval",
      "complete",
    ]);
    expect(typeof reviewLoop?.expand).toBe("function");
  });
});
