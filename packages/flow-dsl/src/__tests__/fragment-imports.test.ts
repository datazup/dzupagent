import { describe, expect, it } from "vitest";

import { createFragmentRegistry } from "../fragments/registry.js";
import { parseDslToDocument } from "../parse-dsl.js";

const fragmentRegistry = createFragmentRegistry([
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.validation_gate",
    version: 1,
    root: {
      type: "sequence",
      nodes: [{ type: "complete", id: "done", result: "ok" }],
    },
  },
]);

describe("fragment imports", () => {
  it("accepts top-level uses namespace imports backed by fragments", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: fragment-uses-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - complete:
      id: done
      result: ok
`,
      { fragmentRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.meta?.fragmentUses).toEqual({
      sdlc: "dzup.sdlc@1",
    });
  });

  it("rejects fragment namespace mismatches", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: bad-fragment-uses
version: 1
uses:
  sdlc: dzup.other@1
steps:
  - complete:
      id: done
      result: ok
`,
      { fragmentRegistry },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /uses\.sdlc must reference dzup\.sdlc@1/i,
    );
  });

  it("requires pinned fragment uses in strict unattended mode", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: unpinned-fragment-use
version: 1
steps:
  - sdlc.validation_gate:
      id: validation
`,
      { fragmentRegistry, requirePinnedFragmentUses: true },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /requires pinned uses entry "sdlc: dzup\.sdlc@1"/i,
    );
  });

  it("accepts pinned fragment invocations in strict unattended mode", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: pinned-fragment-use
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.validation_gate:
      id: validation
`,
      { fragmentRegistry, requirePinnedFragmentUses: true },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects invalid pinned fragment versions clearly", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: invalid-fragment-version
version: 1
uses:
  sdlc: dzup.sdlc@2
steps:
  - sdlc.validation_gate:
      id: validation
`,
      { fragmentRegistry, requirePinnedFragmentUses: true },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /requires pinned uses entry "sdlc: dzup\.sdlc@1".*found "dzup\.sdlc@2"/i,
    );
  });
});
