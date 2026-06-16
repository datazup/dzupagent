import { describe, expect, it } from "vitest";

describe("implementation orchestration contracts", () => {
  it("exports the implementation orchestration schema version", async () => {
    const implementation = await import("../implementation.js");

    expect(implementation.IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION).toBe(1);
  });
});
