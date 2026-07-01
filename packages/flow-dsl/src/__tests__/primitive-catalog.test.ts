import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PRIMITIVES,
  exportPrimitiveCatalog,
} from "../primitives/index.js";

describe("primitive catalog export", () => {
  it("exports stable primitive catalog entries", () => {
    const catalog = exportPrimitiveCatalog(BUILT_IN_PRIMITIVES);

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.generatedFrom).toBe("flow-dsl");
    expect(catalog.primitives.some((entry) => entry.kind === "collab.review_loop")).toBe(
      true,
    );
    expect(catalog.primitives.every((entry) => entry.version.length > 0)).toBe(
      true,
    );
  });
});
