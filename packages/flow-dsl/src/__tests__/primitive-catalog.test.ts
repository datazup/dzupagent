import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PRIMITIVE_DEFINITIONS_V2,
  BUILT_IN_PRIMITIVES,
  exportPrimitiveCatalog,
  exportPrimitiveCatalogV2,
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

  it("exports complete V2 contracts with stable semantic hashes", () => {
    const catalog = exportPrimitiveCatalogV2(
      BUILT_IN_PRIMITIVE_DEFINITIONS_V2,
    );

    expect(catalog.schema).toBe("dzupagent.primitiveCatalog/v2");
    expect(catalog.primitives.map((definition) => definition.ref)).toEqual(
      [...catalog.primitives]
        .map((definition) => definition.ref)
        .sort(),
    );
    expect(
      catalog.primitives.every((definition) =>
        /^sha256:[a-f0-9]{64}$/.test(
          definition.compatibility.semanticHash,
        ),
      ),
    ).toBe(true);
  });
});
