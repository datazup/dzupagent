import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../parse-dsl.js";

describe("primitive imports", () => {
  it("accepts top-level uses namespace imports and preserves them in metadata", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: uses-demo
version: 1
uses:
  collab: dzup.collab@1
steps:
  - complete:
      id: done
      result: ok
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.meta?.primitiveUses).toEqual({
      collab: "dzup.collab@1",
    });
  });

  it("rejects malformed uses entries", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: bad-uses
version: 1
uses:
  collab: 123
steps:
  - complete:
      id: done
      result: ok
`);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /uses\.collab must be a primitive package reference/i,
    );
  });

  it("rejects package refs for namespaces that are not registered", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: unknown-uses
version: 1
uses:
  unknown: dzup.unknown@1
steps:
  - complete:
      id: done
      result: ok
`);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /uses\.unknown references an unregistered primitive namespace/i,
    );
  });
});
