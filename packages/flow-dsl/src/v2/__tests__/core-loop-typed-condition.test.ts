import { FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW } from "@dzupagent/flow-ast/expressions";
import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../../index.js";

/**
 * DZA-DSL-V2-EXECUTOR-S5-20261008-L1 (S5-L slice 1): `core.loop@1` accepts a
 * typed `with.condition`, lowering to a loop whose `typedCondition` carries the
 * semantics and whose legacy string is the fail-closed shadow. That is the
 * shape the `pipeline` target lowers to a real `LoopNode`.
 */

/** `withLines` are the loop's extra `with:` entries, indented by six spaces. */
function source(withLines: string): string {
  return `
dsl: dzupflow/v2
id: typed-loop
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        again: true
  - id: rounds
    use: core.loop@1
    with:
${withLines}
      body:
        - id: tick
          use: core.set@1
          with:
            assign:
              again: false
`;
}

function loweredLoop(withLines: string) {
  const result = parseDslToDocument(source(withLines));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
  const root = result.document.root as unknown as {
    nodes: Record<string, unknown>[];
  };
  return root.nodes[1]!;
}

function diagnosticsFor(withLines: string) {
  const result = parseDslToDocument(source(withLines));
  expect(result.ok).toBe(false);
  return result.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    path: diagnostic.path,
  }));
}

describe("core.loop@1 typed with.condition (S5-L1)", () => {
  it("lowers a typed condition to typedCondition with the fail-closed shadow", () => {
    const loop = loweredLoop(`      condition:
        eq:
          - ref: state.again
          - true
      maxIterations: 3
      onExhausted: continue`);
    expect(loop).toMatchObject({
      type: "loop",
      id: "rounds",
      condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
      typedCondition: {
        schema: "dzupagent.flowTypedCondition/v1",
        expression: {
          op: "eq",
          left: { op: "ref", path: "state.again" },
          right: { op: "literal", value: true },
        },
      },
      maxIterations: 3,
      onExhausted: "continue",
    });
    expect((loop.body as unknown[]).length).toBe(1);
  });

  it("keeps a string condition on the legacy lowering", () => {
    const loop = loweredLoop("      condition: state.again");
    expect(loop).toMatchObject({ type: "loop", condition: "state.again" });
    expect(loop).not.toHaveProperty("typedCondition");
  });

  it("refuses nondeterministic and invalid typed operators at with.condition", () => {
    expect(
      diagnosticsFor(`      condition:
        random: true`),
    ).toContainEqual({
      code: "V2_NONDETERMINISTIC_CONDITION",
      path: "root.steps[1].with.condition.random",
    });
    expect(
      diagnosticsFor(`      condition:
        eq:
          - true`),
    ).toContainEqual({
      code: "V2_INVALID_TYPED_CONDITION",
      path: "root.steps[1].with.condition.eq",
    });
  });

  it("still refuses a condition that is neither a string nor a typed expression", () => {
    for (const withLines of [
      "      maxIterations: 2",
      '      condition: ""',
      "      condition: 7",
      "      condition:\n        - state.again",
    ]) {
      expect(
        diagnosticsFor(withLines).some(
          (diagnostic) => diagnostic.path === "root.steps[1].with.condition",
        ),
      ).toBe(true);
    }
  });
});
