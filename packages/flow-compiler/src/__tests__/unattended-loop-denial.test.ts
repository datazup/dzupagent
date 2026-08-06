import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const LOOP_DSL = [
  "dsl: dzupflow/v1",
  "id: unattended-loop",
  "version: 1",
  "steps:",
  "  - loop:",
  "      id: retry",
  '      condition: "true"',
  "      max_iterations: 3",
  "      body:",
  "        - complete:",
  "            id: done",
  "            result: complete",
].join("\n");

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

describe("unattended loop admission", () => {
  it("preserves interactive authoring compilation with partial-support evidence", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(
      LOOP_DSL,
    );

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    expect(result.requirements.partialNodeKinds).toContain("loop");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PARTIAL_NODE_SUPPORT" }),
      ]),
    );
  });

  it("denies runtime-owned loop conditions for unattended compilation with a source span", async () => {
    const result = await createFlowCompiler({
      toolResolver,
      referencePolicy: "strict",
      admissionProfile: "unattended",
    }).compileDsl(LOOP_DSL);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    const diagnostic = result.errors.find(
      (item) => item.code === "FLOW_LOOP_CONDITION_RUNTIME_ONLY",
    );
    expect(diagnostic).toMatchObject({
      stage: 3,
      category: "policy",
      nodePath: "root.nodes[0].condition",
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected an authored loop-condition source span");
    }
    expect(
      LOOP_DSL.slice(diagnostic.span.start, diagnostic.span.end),
    ).toBe("true");
  });
});
