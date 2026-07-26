import { type ToolResolver } from "@dzupagent/flow-ast";
import {
  FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-policy-narrowing";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const resolver: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

describe("V2 policy narrowing target gate", () => {
  it("blocks artifact emission with exact authored policy span", async () => {
    const source = `
dsl: dzupflow/v2
id: narrowed
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
      requireApproval: true
    save:
      result: state.draft
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected target gate");
    const diagnostic = result.errors.find(
      (item) => item.code === "V2_POLICY_TARGET_UNSUPPORTED",
    );
    expect(diagnostic).toMatchObject({
      stage: 4,
      nodePath: "root.steps[0].policy",
      category: "lowering",
      message: expect.stringContaining(
        FLOW_PRIMITIVE_POLICY_NARROWING_CAPABILITY,
      ),
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected exact authored policy span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
      "timeoutMs: 30000",
    );
  });

  it("reports policy and typed-condition adoption gates together", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(`
dsl: dzupflow/v2
id: guarded-narrowing
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: draft
    use: adapter.run@1
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
    save:
      result: state.draft
`);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected V2 target gates");
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "TYPED_CONDITION_TARGET_UNSUPPORTED",
        "V2_POLICY_TARGET_UNSUPPORTED",
      ]),
    );
  });
});
