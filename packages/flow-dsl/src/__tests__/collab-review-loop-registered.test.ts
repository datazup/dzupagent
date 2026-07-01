import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../parse-dsl.js";

describe("registered collab.review_loop expansion", () => {
  it("expands review loop through primitive expansion and preserves provenance", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: collab-demo
version: 1
uses:
  collab: dzup.collab@1
steps:
  - collab.review_loop:
      id: implement
      task:
        kind: code
        risk: medium
      proposer:
        executionProviderId: codex
      critic:
        executionProviderId: claude
      gates:
        commands:
          - command: node --test scripts/mpco/*.test.mjs
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.document.root.nodes.map((node) => node.type);
    expect(types).toContain("adapter.run");
    expect(types).toContain("validate");
    expect(types).toContain("branch");
    expect(result.document.root.nodes[0]?.meta?.collabExpansion).toBe(
      "implement"
    );
    expect(result.document.root.nodes[0]?.meta?.primitive).toBe(
      "collab.review_loop@1"
    );
  });

  it("omits validate when no gate commands are provided", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: collab-no-gates
version: 1
uses:
  collab: dzup.collab@1
steps:
  - collab.review_loop:
      id: implement
      task:
        kind: code
      proposer:
        executionProviderId: codex
      critic:
        executionProviderId: claude
`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.document.root.nodes.map((node) => node.type);
    expect(types).toEqual(["adapter.run", "adapter.run", "branch"]);
  });

  it("reports malformed collab inputs during parse expansion", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: bad-collab
version: 1
uses:
  collab: dzup.collab@1
steps:
  - collab.review_loop:
      id: implement
      task:
        kind: code
      critic:
        executionProviderId: claude
`);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /proposer\.executionProviderId is required/i
    );
  });
});
