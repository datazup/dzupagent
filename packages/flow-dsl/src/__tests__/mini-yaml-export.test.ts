import { describe, expect, it } from "vitest";

import { parseYamlSubset } from "../index.js";

describe("flow-dsl parser exports", () => {
  it("exports parseYamlSubset for scripts bridge loaders", () => {
    const result = parseYamlSubset("id: bridge");

    expect(result).toEqual({ ok: true, value: { id: "bridge" } });
  });
});
