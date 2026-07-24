import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  createPrimitiveRegistryV2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import {
  createFlowCompiler,
  resolvePrimitiveRegistryReadiness,
  validateCompilerPrimitiveRegistry,
  type FlowPrimitiveBinding,
} from "../index.js";

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

function customValidateV2(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
    "validate.schema",
    "1",
  );
  if (base === undefined) throw new Error("missing validate.schema@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://validate.schema@2",
    version: "2",
    owner: "test.external",
    requiresCapabilities: [
      ...base.requiresCapabilities,
      "flow.runtime.custom.validation@2",
    ],
    outputPorts: {
      ...base.outputPorts,
      result: {
        ...base.outputPorts.result!,
        classification: "sensitive",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: ["custom.validate.schema"],
    },
  });
}

function customComposite(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
    "collab.review_loop",
    "1",
  );
  if (base === undefined) throw new Error("missing collab.review_loop@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://custom.audit@1",
    namespace: "custom",
    name: "audit",
    version: "1",
    owner: "test.external",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    acceptedInputClassifications: ["public", "internal"],
    inputPathClassifications: { id: "internal" },
    credentialInputs: "forbidden",
    credentialInputPaths: [],
    outputPorts: {
      result: {
        schema: { type: "object" },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    requiresCapabilities: ["flow.runtime.custom.audit@1"],
    execution: {
      ...base.execution,
      expansionRef: "custom.audit@1",
      expandsTo: ["validate.schema", "complete"],
    },
    compatibility: {
      ...compatibility,
      supersedes: [],
      deprecatedAliases: [],
    },
  });
}

function flow() {
  return {
    type: "sequence" as const,
    id: "root",
    nodes: [
      {
        type: "validate.schema" as const,
        id: "checked",
        source: "candidate",
        schema: { type: "object" },
        output: "validationResult",
      },
      {
        type: "complete" as const,
        id: "finish",
        result: "done",
      },
    ],
  };
}

describe("custom PrimitiveRegistryV2 compiler admission", () => {
  it("selects only an exact ref/hash binding and binds it into requirements and envelopes", async () => {
    const custom = customValidateV2();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    const binding: FlowPrimitiveBinding = {
      ref: custom.ref,
      semanticHash: custom.compatibility.semanticHash,
    };
    const compiler = createFlowCompiler({
      toolResolver,
      primitiveRegistry: registry,
      primitiveBindings: { "validate.schema": binding },
    });
    const result = await compiler.compile(flow());

    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected compile success");
    expect(result.requirements.requiredCapabilities).toContain(
      "flow.runtime.custom.validation@2",
    );
    expect(result.classificationEnvelope?.semanticHash).toBe(
      result.requirements.semanticHash,
    );
    expect(result.classificationEnvelope?.primitives).toContainEqual(
      expect.objectContaining({
        nodeId: "checked",
        primitiveRef: custom.ref,
        outputs: [
          expect.objectContaining({
            port: "result",
            expectedClassification: "sensitive",
          }),
        ],
      }),
    );
  });

  it("does not select an external latest version without an exact binding", async () => {
    const custom = customValidateV2();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    const result = await createFlowCompiler({
      toolResolver,
      primitiveRegistry: registry,
    }).compile(flow());

    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected compile success");
    expect(result.classificationEnvelope?.primitives).toContainEqual(
      expect.objectContaining({
        nodeId: "checked",
        primitiveRef: "primitive://validate.schema@1",
      }),
    );
    expect(result.requirements.requiredCapabilities).not.toContain(
      "flow.runtime.custom.validation@2",
    );
  });

  it("rejects missing built-ins, missing refs, kind drift, and hash drift at construction", () => {
    const custom = customValidateV2();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    expect(
      validateCompilerPrimitiveRegistry(
        extendPrimitiveRegistryV2(
          BUILT_IN_PRIMITIVE_REGISTRY_V2,
          [custom],
        ),
      ).valid,
    ).toBe(true);
    expect(() =>
      createFlowCompiler({
        toolResolver,
        primitiveRegistry: registry,
        primitiveBindings: {
          "validate.schema": {
            ref: custom.ref,
            semanticHash: `sha256:${"0".repeat(64)}`,
          },
        },
      }),
    ).toThrow(/semantic hash does not match/);
    expect(() =>
      createFlowCompiler({
        toolResolver,
        primitiveRegistry: registry,
        primitiveBindings: {
          validate: {
            ref: custom.ref,
            semanticHash: custom.compatibility.semanticHash,
          },
        },
      }),
    ).toThrow(/different primitive kind/);
    expect(() =>
      createFlowCompiler({
        toolResolver,
        primitiveBindings: {
          "validate.schema": {
            ref: custom.ref,
            semanticHash: custom.compatibility.semanticHash,
          },
        },
      }),
    ).toThrow(/requires an additive primitiveRegistry/);
    expect(() =>
      createFlowCompiler({
        toolResolver,
        primitiveRegistry: createPrimitiveRegistryV2([customComposite()]),
      }),
    ).toThrow(/missing built-in primitive/);
  });

  it("explains selected identities and missing host capabilities", () => {
    const custom = customValidateV2();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    const readiness = resolvePrimitiveRegistryReadiness({
      root: flow(),
      registry,
      bindings: {
        "validate.schema": {
          ref: custom.ref,
          semanticHash: custom.compatibility.semanticHash,
        },
      },
      availableCapabilities: [],
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.selected).toContainEqual({
      kind: "validate.schema",
      ref: custom.ref,
      semanticHash: custom.compatibility.semanticHash,
    });
    expect(readiness.missingCapabilities).toContain(
      "flow.runtime.custom.validation@2",
    );
  });

  it("compiles a pinned external composite and rejects the same expansion without a hash binding", async () => {
    const custom = customComposite();
    const registry = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    const source = `
dsl: dzupflow/v1
id: custom_registry_compile
version: 1
uses:
  custom: dzup.custom@1
steps:
  - custom.audit:
      id: audit
`;
    const expansionHandlers = {
      "custom.audit@1": (raw: unknown) => {
        const id =
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { id?: unknown }).id === "string"
            ? (raw as { id: string }).id
            : "audit";
        return [
          {
            "validate.schema": {
              id: `${id}__validate`,
              source: "candidate",
              schema: { type: "object" },
              output: "validationResult",
            },
          },
          { complete: { id: `${id}__complete`, result: "done" } },
        ];
      },
    };
    const admitted = await createFlowCompiler({
      toolResolver,
      primitiveRegistry: registry,
      primitiveBindings: {
        "custom.audit": {
          ref: custom.ref,
          semanticHash: custom.compatibility.semanticHash,
        },
      },
      primitiveExpansionHandlers: expansionHandlers,
    }).compileDsl(source);
    const rejected = await createFlowCompiler({
      toolResolver,
      primitiveRegistry: registry,
      primitiveExpansionHandlers: expansionHandlers,
    }).compileDsl(source);

    expect("errors" in admitted).toBe(false);
    if ("errors" in admitted) throw new Error("expected custom compile success");
    expect(admitted.requirements.requiredCapabilities).toContain(
      "flow.runtime.custom.audit@1",
    );
    expect("errors" in rejected).toBe(true);
    if (!("errors" in rejected)) throw new Error("expected binding failure");
    expect(rejected.errors).toContainEqual(
      expect.objectContaining({
        stage: 3,
        code: "PRIMITIVE_REGISTRY_BINDING_REQUIRED",
        category: "registry",
        message: expect.stringContaining("requires an exact ref"),
      }),
    );
  });
});
