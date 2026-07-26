import { type ToolResolver } from "@dzupagent/flow-ast";
import {
  FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-terminal-catch";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const resolver: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

describe("V2 primitive terminal-catch target gate", () => {
  it("blocks generic artifact emission at the authored catch envelope", async () => {
    const source = `
dsl: dzupflow/v2
id: caught-terminal
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: fail
        code: adapter.cancelled
    save:
      result: state.draft
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(source);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected catch target gate");
    const diagnostic = result.errors.find(
      (item) => item.code === "V2_CATCH_TARGET_UNSUPPORTED",
    );
    expect(diagnostic).toMatchObject({
      stage: 4,
      nodePath: "root.steps[0].catch",
      category: "lowering",
      message: expect.stringContaining(
        FLOW_PRIMITIVE_TERMINAL_CATCH_CAPABILITY,
      ),
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected exact authored catch span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
      "ADAPTER_CANCELLED",
    );
  });

  it("accumulates typed-control, policy, retry, and catch target gaps", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(`
dsl: dzupflow/v2
id: guarded-recovery
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
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: fail
        code: adapter.cancelled
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
        "V2_CATCH_TARGET_UNSUPPORTED",
      ]),
    );
  });
});
