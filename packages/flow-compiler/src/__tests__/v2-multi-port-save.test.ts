import { type ToolResolver } from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import {
  FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
} from "@dzupagent/flow-dsl/v2-multi-port-save";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

const resolver: ToolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

function multiPortAdapter(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://adapter.run@2",
    version: "2",
    owner: "test.external",
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: { type: "object" },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
}

describe("V2 primitive multi-port save target gate", () => {
  it("blocks generic emission at the exact authored save envelope", async () => {
    const primitive = multiPortAdapter();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [primitive],
    );
    const source = `
dsl: dzupflow/v2
id: multi-save
version: 2.0.0
steps:
  - id: run
    use: adapter.run@2
    with:
      provider: codex
      instructions: Draft.
    save:
      result: state.result
      receipt: state.receipt
`;
    const result = await createFlowCompiler({
      toolResolver: resolver,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    }).compileDsl(source);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected save target gate");
    const diagnostic = result.errors.find(
      (item) => item.code === "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
    );
    if (diagnostic === undefined) {
      throw new Error(JSON.stringify(result.errors, null, 2));
    }
    expect(diagnostic).toMatchObject({
      stage: 4,
      nodePath: "root.steps[0].save",
      category: "lowering",
      message: expect.stringContaining(
        FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
      ),
      span: { kind: "source-offsets" },
    });
    if (diagnostic?.span?.kind !== "source-offsets") {
      throw new Error("expected exact authored save span");
    }
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(
      "receipt: state.receipt",
    );
  });

  it("does not gate the legacy single-port compatibility path", async () => {
    const result = await createFlowCompiler({
      toolResolver: resolver,
    }).compileDsl(`
dsl: dzupflow/v2
id: single-save
version: 2.0.0
steps:
  - id: run
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    save:
      result: state.result
`);

    if ("errors" in result) {
      expect(result.errors.map((error) => error.code)).not.toContain(
        "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
      );
    }
  });

  it("accumulates every current V2 target obligation", async () => {
    const primitive = multiPortAdapter();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [primitive],
    );
    const result = await createFlowCompiler({
      toolResolver: resolver,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    }).compileDsl(`
dsl: dzupflow/v2
id: all-v2-target-gates
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: run
    use: adapter.run@2
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
        action: continue
    save:
      result: state.result
      receipt: state.receipt
`);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected V2 target gates");
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "TYPED_CONDITION_TARGET_UNSUPPORTED",
        "V2_POLICY_TARGET_UNSUPPORTED",
        "V2_RETRY_TARGET_UNSUPPORTED",
        "V2_CATCH_TARGET_UNSUPPORTED",
        "V2_MULTI_SAVE_TARGET_UNSUPPORTED",
      ]),
    );
  });
});
