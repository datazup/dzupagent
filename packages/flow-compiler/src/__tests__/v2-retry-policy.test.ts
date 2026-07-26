import { type ToolResolver } from "@dzupagent/flow-ast";
import {
  FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-retry-policy";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const resolver: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

describe("V2 primitive retry target gate", () => {
  it("blocks generic artifact emission at the authored retry envelope", async () => {
    const source = `
dsl: dzupflow/v2
id: retry-aware
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 3
      backoff:
        strategy: exponential
        initialMs: 500
        maxMs: 5000
        jitter: full
    save:
      result: state.draft
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected retry target gate");
    const diagnostic = result.errors.find(
      (item) => item.code === "V2_RETRY_TARGET_UNSUPPORTED",
    );
    expect(diagnostic).toMatchObject({
      stage: 4,
      nodePath: "root.steps[0].retry",
      category: "lowering",
      message: expect.stringContaining(
        FLOW_PRIMITIVE_RETRY_POLICY_CAPABILITY,
      ),
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected exact authored retry span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
      "ADAPTER_FAILED",
    );
  });

  it("reports retry, policy, and typed-condition gates together", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(`
dsl: dzupflow/v2
id: guarded-retry
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
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
    save:
      result: state.draft
`);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected V2 target gates");
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "TYPED_CONDITION_TARGET_UNSUPPORTED",
        "V2_POLICY_TARGET_UNSUPPORTED",
        "V2_RETRY_TARGET_UNSUPPORTED",
      ]),
    );
  });
});
