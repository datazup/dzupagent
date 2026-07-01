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
});
