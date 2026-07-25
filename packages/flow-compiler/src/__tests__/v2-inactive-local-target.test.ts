import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import {
  qualifyV2InactiveLocalTarget,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  V2_INACTIVE_LOCAL_TARGET_ID,
} from "../v2-inactive-local-target.js";

const resolver = {
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
        schema: {
          type: "object",
          properties: { digest: { type: "string" } },
          required: ["digest"],
          additionalProperties: false,
        },
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

function fixture() {
  const primitive = multiPortAdapter();
  const registry = extendPrimitiveRegistryV2(
    BUILT_IN_PRIMITIVE_REGISTRY_V2,
    [primitive],
  );
  const source = `
dsl: dzupflow/v2
id: inactive-local-target
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
`;
  return { primitive, registry, source };
}

describe("inactive local V2 target qualification", () => {
  it("qualifies all five capabilities with deterministic zero authority", async () => {
    const { primitive, registry, source } = fixture();
    const compilerOptions = {
      toolResolver: resolver,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    };
    const first = await qualifyV2InactiveLocalTarget({
      source,
      compilerOptions,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: { inputs: { ready: true } },
    });
    const second = await qualifyV2InactiveLocalTarget({
      source,
      compilerOptions,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: { inputs: { ready: true } },
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        schema: "dzupagent.v2InactiveLocalTargetQualification/v1",
        target: V2_INACTIVE_LOCAL_TARGET_ID,
        status: "qualified-inactive",
        coverage: {
          typedConditions: 1,
          policyNarrowings: 1,
          retryPolicies: 1,
          terminalCatches: 1,
          multiPortSaves: 1,
        },
        conditionEvaluations: [
          expect.objectContaining({
            value: true,
            resolvedReferences: ["inputs.ready"],
          }),
        ],
        authority: {
          artifactEmission: false,
          primitiveExecution: false,
          providerDispatch: false,
          stateMutation: false,
          continuation: false,
          deployment: false,
          promotion: false,
          activation: false,
        },
      },
    });
    if (!first.ok) throw new Error("expected qualification receipt");
    expect(first.receipt.primitiveContracts).toHaveLength(4);
    expect(
      first.receipt.primitiveContracts.every(
        (item) =>
          item.contractSha256.startsWith("sha256:") &&
          item.primitiveSemanticHash.startsWith("sha256:"),
      ),
    ).toBe(true);
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.receipt.primitiveContracts)).toBe(true);
  });

  it("requires the exact closed capability set", async () => {
    const { primitive, registry, source } = fixture();
    const compilerOptions = {
      toolResolver: resolver,
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    };
    const missing = await qualifyV2InactiveLocalTarget({
      source,
      compilerOptions,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES.slice(1),
      conditionBindings: { inputs: { ready: true } },
    });
    const widened = await qualifyV2InactiveLocalTarget({
      source,
      compilerOptions,
      hostCapabilities: [
        ...V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
        "provider.dispatch@1",
      ],
      conditionBindings: { inputs: { ready: true } },
    });

    for (const result of [missing, widened]) {
      expect(result).toMatchObject({
        ok: false,
        errors: [
          expect.objectContaining({
            code: "V2_LOCAL_TARGET_EXACT_CAPABILITIES_REQUIRED",
            path: "hostCapabilities",
          }),
        ],
      });
    }
  });

  it("fails closed on missing runtime condition values", async () => {
    const { primitive, registry, source } = fixture();
    const result = await qualifyV2InactiveLocalTarget({
      source,
      compilerOptions: {
        toolResolver: resolver,
        primitiveRegistry: registry,
        primitiveBindings: {
          "adapter.run": {
            ref: primitive.ref,
            semanticHash: primitive.compatibility.semanticHash,
          },
        },
      },
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: {},
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_LOCAL_TARGET_TYPED_CONDITION_FAILED",
          causes: ["TYPED_REFERENCE_MISSING"],
        }),
      ],
    });
  });

  it("requires explicit V2 source and complete capability coverage", async () => {
    const notV2 = await qualifyV2InactiveLocalTarget({
      source: `
dsl: dzupflow/v1
id: legacy
version: 1
steps:
  - complete:
      id: done
      result: done
`,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: {},
      compilerOptions: { toolResolver: resolver },
    });
    expect(notV2).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_LOCAL_TARGET_V2_SOURCE_REQUIRED",
        }),
      ],
    });

    const incomplete = await qualifyV2InactiveLocalTarget({
      source: `
dsl: dzupflow/v2
id: incomplete
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: done
    use: core.complete@1
    when:
      ref: inputs.ready
    with:
      result: done
`,
      hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
      conditionBindings: { inputs: { ready: true } },
      compilerOptions: { toolResolver: resolver },
    });
    expect(incomplete).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_LOCAL_TARGET_COVERAGE_INCOMPLETE",
        }),
      ],
    });
  });

  it("does not weaken generic compiler target gates", async () => {
    const { primitive, registry, source } = fixture();
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
    if (!("errors" in result)) throw new Error("expected generic target gates");
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
