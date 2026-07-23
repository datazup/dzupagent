import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  createPrimitiveAuthoringMetadata,
  createPrimitiveRegistryV2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
  type PrimitiveDefinitionV2Input,
} from "../primitives/index.js";

function customPrimitive(
  version = "1",
  overrides: Partial<PrimitiveDefinitionV2Input> = {},
): PrimitiveDefinitionV2 {
  return definePrimitiveV2({
    schema: "dzupagent.primitiveDefinition/v2",
    ref: `primitive://custom.customer_lookup@${version}`,
    namespace: "custom",
    name: "customer_lookup",
    version,
    owner: "test",
    stability: "beta",
    category: "leaf",
    requiresKernel: "dzup.core@1",
    requiresProfiles: [],
    requiresCapabilities: [
      "flow.runtime.custom.customer_lookup@1",
      "flow.runtime.credential.resolve@1",
    ],
    inputSchema: {
      type: "object",
      properties: {
        customer: {
          type: "object",
          properties: {
            email: { type: "string", title: "Customer email" },
          },
          required: ["email"],
          additionalProperties: false,
        },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              token: { type: "string" },
              label: { type: "string", enum: ["primary", "secondary"] },
            },
            required: ["token", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["customer", "records"],
      additionalProperties: false,
    },
    acceptedInputClassifications: [
      "public",
      "internal",
      "sensitive",
      "secret",
    ],
    inputPathClassifications: {
      customer: "internal",
      "customer.email": "sensitive",
      "records.*.label": "public",
    },
    credentialInputs: "handle-only",
    credentialInputPaths: ["records.*.token"],
    credentialResolverCapabilityRef: "flow.runtime.credential.resolve@1",
    outputPorts: {
      result: {
        schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "sensitive",
        persistence: "state",
      },
    },
    errorSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    errors: [{ code: "CUSTOM_LOOKUP_FAILED", retryable: true }],
    effect: {
      classes: ["read"],
      idempotency: "idempotent",
      replay: "safe",
    },
    execution: {
      kind: "host-action",
      handlerRef: "custom.customer_lookup",
      delivery: ["inline"],
      durability: ["durable"],
      maySuspend: false,
      cancellation: "required",
    },
    policy: {
      allowedOverrides: ["timeoutMs"],
      requiredApprovalClasses: [],
      requiresBudgetReservation: false,
    },
    evidence: {
      required: ["provider", "requestDigest"],
      rawContent: "forbidden",
      redactionReceiptRequired: false,
    },
    compatibility: {
      supersedes: [],
      deprecatedAliases: [],
    },
    ...overrides,
  });
}

describe("PrimitiveRegistryV2", () => {
  it("resolves exact refs, versions, aliases, and a deterministic registry hash", () => {
    const v1 = customPrimitive("1");
    const v2 = customPrimitive("2", {
      compatibility: {
        supersedes: [v1.ref],
        deprecatedAliases: ["custom.lookup_customer"],
      },
    });
    const left = createPrimitiveRegistryV2([v2, v1], {
      requireClassifiedLeafInputs: true,
    });
    const right = createPrimitiveRegistryV2([v1, v2], {
      requireClassifiedLeafInputs: true,
    });

    expect(left.registryHash).toBe(right.registryHash);
    expect(left.get(v1.ref)).toEqual(v1);
    expect(left.resolve("custom.customer_lookup")?.ref).toBe(v2.ref);
    expect(left.resolve("custom.customer_lookup", "1")?.ref).toBe(v1.ref);
    expect(left.resolveAlias("custom.lookup_customer")?.ref).toBe(v2.ref);
    expect(Object.isFrozen(left.list())).toBe(true);
  });

  it("extends the built-in registry without permitting duplicate identities", () => {
    const custom = customPrimitive();
    const extended = extendPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2,
      [custom],
    );
    expect(extended.get(custom.ref)).toEqual(custom);
    expect(extended.resolve("http", "1")).toBeDefined();
    expect(() =>
      extendPrimitiveRegistryV2(extended, [custom]),
    ).toThrow(/duplicate primitive V2 ref/);
  });

  it("generates nested typed, classified, credential, and output metadata", () => {
    const metadata = createPrimitiveAuthoringMetadata(customPrimitive());

    expect(metadata.classificationComplete).toBe(true);
    expect(metadata.unclassifiedLeafPaths).toEqual([]);
    expect(metadata.inputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "customer.email",
          valueType: "string",
          required: true,
          classification: "sensitive",
        }),
        expect.objectContaining({
          path: "records.*.label",
          valueType: "string",
          classification: "public",
          enum: ["primary", "secondary"],
        }),
        expect.objectContaining({
          path: "records.*.token",
          valueType: "credential",
          credential: true,
          classification: "secret",
        }),
      ]),
    );
    expect(metadata.outputFields).toEqual([
      expect.objectContaining({
        path: "result",
        valueType: "object",
        classification: "sensitive",
      }),
    ]);
  });

  it("rejects semantic, compatibility, schema-path, and classification drift", () => {
    const v1 = customPrimitive("1");
    expect(() =>
      createPrimitiveRegistryV2([
        {
          ...v1,
          compatibility: {
            ...v1.compatibility,
            semanticHash: `sha256:${"0".repeat(64)}`,
          },
        },
      ]),
    ).toThrow(/semantic hash does not match/);

    expect(() =>
      createPrimitiveRegistryV2([
        customPrimitive("2", {
          compatibility: {
            supersedes: ["primitive://custom.customer_lookup@1"],
            deprecatedAliases: [],
          },
        }),
      ]),
    ).toThrow(/supersedes missing/);

    expect(() =>
      customPrimitive("1", {
        inputPathClassifications: { missing: "internal" },
      }),
    ).toThrow(/unknown input-schema path/);

    expect(() =>
      createPrimitiveRegistryV2(
        [
          customPrimitive("1", {
            inputPathClassifications: {
              "customer.email": "sensitive",
            },
          }),
        ],
        { requireClassifiedLeafInputs: true },
      ),
    ).toThrow(/unclassified input leaves/);
  });

  it("deep-freezes schema content without mutating the caller input", () => {
    const input = customPrimitive();
    const registry = createPrimitiveRegistryV2([input]);
    const stored = registry.get(input.ref);
    expect(stored).not.toBe(input);
    expect(Object.isFrozen(stored?.inputSchema)).toBe(true);
    expect(Object.isFrozen(stored?.outputPorts.result?.schema)).toBe(true);
    expect(input).toEqual(customPrimitive());
  });
});
