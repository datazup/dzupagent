import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../parse-dsl.js";
import {
  BUILT_IN_PRIMITIVES,
  createPrimitiveRegistry,
  type PrimitiveDefinition,
} from "../primitives/index.js";

const syntheticV2: PrimitiveDefinition = {
  kind: "collab.review_loop",
  version: "2",
  namespace: "collab",
  category: "composite",
  schema: { type: "object" },
  expandsTo: ["complete"],
  expand: () => [{ complete: { id: "synthetic_v2", result: "v2" } }],
};
const registryWithSyntheticV2 = createPrimitiveRegistry([
  ...BUILT_IN_PRIMITIVES,
  syntheticV2,
]);

const WITH_GATES = `
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
`;

const WITHOUT_GATES = `
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
`;

const MALFORMED = `
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
`;

function expectPinnedV1Golden(source: string): void {
  expect(
    parseDslToDocument(source, { primitiveRegistry: registryWithSyntheticV2 }),
  ).toEqual(parseDslToDocument(source));
}

describe("registered collab.review_loop expansion", () => {
  it("expands review loop through primitive expansion and preserves provenance", () => {
    const result = parseDslToDocument(WITH_GATES);

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
    const result = parseDslToDocument(WITHOUT_GATES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.document.root.nodes.map((node) => node.type);
    expect(types).toEqual(["adapter.run", "adapter.run", "branch"]);
  });

  it("reports malformed collab inputs during parse expansion", () => {
    const result = parseDslToDocument(MALFORMED);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toMatch(
      /proposer\.executionProviderId is required/i
    );
  });

  it("keeps all existing pinned v1 fixtures byte-for-byte compatible when v2 is registered", () => {
    for (const source of [WITH_GATES, WITHOUT_GATES, MALFORMED]) {
      expectPinnedV1Golden(source);
    }
  });

  it("reports an unknown pinned composite version before normalization", () => {
    const result = parseDslToDocument(
      WITH_GATES.replace("dzup.collab@1", "dzup.collab@3"),
      { primitiveRegistry: registryWithSyntheticV2 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        phase: "normalize",
        code: "INVALID_COMPOSITE_PRIMITIVE",
        message: expect.stringMatching(
          /collab\.review_loop is pinned by uses\.collab to dzup\.collab@3, but collab\.review_loop@3 is not registered as a composite/i,
        ),
      }),
    ]);
  });
});
