import { describe, expect, it } from "vitest";

import {
  createFlowSchemaRegistry,
  createPrimitiveAuthoringMetadata,
  createPrimitiveRegistryV2,
  defineFlowSchema,
  definePrimitiveV2,
  resolveFlowSchema,
  type FlowSchemaDefinition,
  type FlowSchemaDefinitionInput,
} from "../index.js";

function schema(
  ref: `schema://${string}@${string}`,
  jsonSchema: Record<string, unknown>,
  overrides: Partial<FlowSchemaDefinitionInput> = {},
): FlowSchemaDefinition {
  return defineFlowSchema({
    schema: "dzupagent.schemaDefinition/v1",
    ref,
    owner: "test",
    trust: "reviewed",
    jsonSchema,
    compatibility: { supersedes: [] },
    ...overrides,
  });
}

const address = schema("schema://test/address@1", {
  type: "object",
  properties: {
    city: { type: "string" },
    postalCode: { type: "string" },
  },
  required: ["city"],
  additionalProperties: false,
});

const customer = schema("schema://test/customer@1", {
  type: "object",
  properties: {
    name: { type: "string" },
    address: { $ref: address.ref },
  },
  required: ["name", "address"],
  additionalProperties: false,
});

describe("FlowSchemaRegistry", () => {
  it("resolves pinned nested refs with deterministic hashes and an exact lock", () => {
    const left = createFlowSchemaRegistry([customer, address]);
    const right = createFlowSchemaRegistry([address, customer]);
    const resolved = resolveFlowSchema(customer.ref, left);

    expect(left.registryHash).toBe(right.registryHash);
    expect(resolved).toMatchObject({
      schema: "dzupagent.resolvedSchema/v1",
      root: {
        ref: customer.ref,
        semanticHash: customer.compatibility.semanticHash,
      },
      registryHash: left.registryHash,
    });
    expect(resolved.bindings).toEqual([
      {
        ref: address.ref,
        semanticHash: address.compatibility.semanticHash,
      },
      {
        ref: customer.ref,
        semanticHash: customer.compatibility.semanticHash,
      },
    ]);
    expect(resolved.jsonSchema).toMatchObject({
      properties: {
        address: {
          properties: {
            city: { type: "string" },
          },
        },
      },
    });
    expect(Object.isFrozen(resolved.jsonSchema)).toBe(true);
    expect(left.list("test")).toHaveLength(2);
  });

  it("fails closed on trust, identity, digest, missing refs, and cycles", () => {
    const local = schema("schema://test/local@1", { type: "string" }, {
      trust: "local",
    });
    expect(() => createFlowSchemaRegistry([local])).toThrow(
      /trust "local" is not accepted/,
    );
    expect(() =>
      createFlowSchemaRegistry([local], { acceptedTrust: ["local"] }),
    ).not.toThrow();
    expect(() =>
      schema("schema://test/unpinned" as `schema://${string}@${string}`, {
        type: "string",
      }),
    ).toThrow(/must be exact/);
    expect(() =>
      createFlowSchemaRegistry([
        {
          ...address,
          compatibility: {
            ...address.compatibility,
            semanticHash: `sha256:${"0".repeat(64)}`,
          },
        },
      ]),
    ).toThrow(/semantic hash does not match/);
    expect(() =>
      createFlowSchemaRegistry([
        schema("schema://test/missing@1", {
          $ref: "schema://test/absent@1",
        }),
      ]),
    ).toThrow(/does not contain schema:\/\/test\/absent@1/);

    const cycleA = schema("schema://test/cycle-a@1", {
      $ref: "schema://test/cycle-b@1",
    });
    const cycleB = schema("schema://test/cycle-b@1", {
      $ref: cycleA.ref,
    });
    expect(() => createFlowSchemaRegistry([cycleA, cycleB])).toThrow(
      /schema reference cycle/,
    );
  });

  it("validates duplicate identities and explicit version lineage", () => {
    expect(() => createFlowSchemaRegistry([address, address])).toThrow(
      /duplicate schema ref/,
    );
    expect(() => createFlowSchemaRegistry([], { acceptedTrust: [] })).toThrow(
      /accept at least one trust class/,
    );

    const addressV2 = schema(
      "schema://test/address@2",
      address.jsonSchema as Record<string, unknown>,
      { compatibility: { supersedes: [address.ref] } },
    );
    expect(() => createFlowSchemaRegistry([address, addressV2])).not.toThrow();
    expect(() => createFlowSchemaRegistry([addressV2])).toThrow(
      /supersedes missing/,
    );

    const unrelated = schema(
      "schema://test/customer-address@2",
      address.jsonSchema as Record<string, unknown>,
      { compatibility: { supersedes: [address.ref] } },
    );
    expect(() => createFlowSchemaRegistry([address, unrelated])).toThrow(
      /cannot supersede a different schema identity/,
    );
  });

  it("resolves external primitive schemas into deep classified authoring metadata", () => {
    const registry = createFlowSchemaRegistry([address, customer]);
    const primitive = definePrimitiveV2({
      schema: "dzupagent.primitiveDefinition/v2",
      ref: "primitive://test.customer.create@1",
      namespace: "test",
      name: "create",
      version: "1",
      owner: "test",
      stability: "beta",
      category: "leaf",
      requiresKernel: "dzup.core@1",
      requiresProfiles: [],
      requiresCapabilities: ["flow.runtime.test.customer.create@1"],
      inputSchema: customer.ref,
      acceptedInputClassifications: ["public", "internal", "sensitive"],
      inputPathClassifications: {
        name: "internal",
        address: "internal",
        "address.city": "internal",
        "address.postalCode": "sensitive",
      },
      credentialInputs: "forbidden",
      credentialInputPaths: [],
      outputPorts: {
        result: {
          schema: { type: "string" },
          cardinality: "one",
          classification: "internal",
          persistence: "state",
        },
      },
      errorSchema: { type: "object" },
      errors: [],
      effect: {
        classes: ["network_write"],
        idempotency: "idempotent",
        replay: "deduplicated",
      },
      execution: {
        kind: "host-action",
        handlerRef: "test.customer.create",
        delivery: ["inline"],
        durability: ["durable"],
        maySuspend: false,
        cancellation: "required",
      },
      policy: {
        allowedOverrides: [],
        requiredApprovalClasses: [],
        requiresBudgetReservation: false,
      },
      evidence: {
        required: ["requestDigest"],
        rawContent: "forbidden",
        redactionReceiptRequired: false,
      },
      compatibility: {
        supersedes: [],
        deprecatedAliases: [],
      },
    });

    const metadata = createPrimitiveAuthoringMetadata(primitive, {
      schemaRegistry: registry,
    });
    expect(metadata.schemaRegistryHash).toBe(registry.registryHash);
    expect(metadata.schemaBindings).toHaveLength(2);
    expect(metadata.classificationComplete).toBe(true);
    expect(metadata.inputFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "address.city",
          required: true,
          classification: "internal",
        }),
        expect.objectContaining({
          path: "address.postalCode",
          classification: "sensitive",
        }),
      ]),
    );
    expect(() =>
      createPrimitiveRegistryV2([primitive], {
        requireClassifiedLeafInputs: true,
        schemaRegistry: registry,
      }),
    ).not.toThrow();
  });
});
