import { describe, expect, it } from "vitest";

import {
  createFlowSchemaRegistry,
  createPrimitiveRegistryV2,
  createVersionMigrationRegistry,
  defineFlowSchema,
  definePrimitiveV2,
  defineVersionMigration,
  previewVersionMigration,
  qualifyVersionMigration,
  type FlowSchemaDefinition,
  type PrimitiveDefinitionV2,
  type VersionMigrationDefinition,
  type VersionMigrationDefinitionInput,
} from "../index.js";

function schemaVersion(
  version: "1" | "2",
): FlowSchemaDefinition {
  return defineFlowSchema({
    schema: "dzupagent.schemaDefinition/v1",
    ref: `schema://test/customer@${version}`,
    owner: "test",
    trust: "reviewed",
    jsonSchema:
      version === "1"
        ? {
            type: "object",
            properties: { fullName: { type: "string" } },
            required: ["fullName"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
    compatibility: {
      supersedes:
        version === "2" ? ["schema://test/customer@1"] : [],
    },
  });
}

function primitiveVersion(
  version: "1" | "2",
): PrimitiveDefinitionV2 {
  return definePrimitiveV2({
    schema: "dzupagent.primitiveDefinition/v2",
    ref: `primitive://test.lookup@${version}`,
    namespace: "test",
    name: "lookup",
    version,
    owner: "test",
    stability: "beta",
    category: "leaf",
    requiresKernel: "dzup.core@1",
    requiresProfiles: [],
    requiresCapabilities: ["flow.runtime.test.lookup@1"],
    inputSchema: { type: "object" },
    acceptedInputClassifications: ["public"],
    credentialInputs: "forbidden",
    credentialInputPaths: [],
    outputPorts: {
      result: {
        schema: { type: "string" },
        cardinality: "one",
        classification: "public",
        persistence: "state",
      },
    },
    errorSchema: { type: "object" },
    errors: [],
    effect: {
      classes: ["read"],
      idempotency: "idempotent",
      replay: "safe",
    },
    execution: {
      kind: "host-action",
      handlerRef: "test.lookup",
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
      supersedes:
        version === "2" ? ["primitive://test.lookup@1"] : [],
      deprecatedAliases: [],
    },
  });
}

const schemaV1 = schemaVersion("1");
const schemaV2 = schemaVersion("2");
const primitiveV1 = primitiveVersion("1");
const primitiveV2 = primitiveVersion("2");
const schemaRegistry = createFlowSchemaRegistry([schemaV1, schemaV2]);
const primitiveRegistry = createPrimitiveRegistryV2([
  primitiveV1,
  primitiveV2,
]);

function schemaMigration(
  overrides: Partial<VersionMigrationDefinitionInput> = {},
): VersionMigrationDefinition {
  return defineVersionMigration({
    schema: "dzupagent.versionMigrationDefinition/v1",
    ref: "migration://schema/test/customer@1-to-2",
    owner: "test",
    fromRef: schemaV1.ref,
    toRef: schemaV2.ref,
    fromSemanticHash: schemaV1.compatibility.semanticHash,
    toSemanticHash: schemaV2.compatibility.semanticHash,
    classification: "equivalent",
    transformRef: "test.customer.v1-to-v2",
    semanticProjectionRef: "test.customer.semantic",
    rollback: {
      kind: "exact",
      transformRef: "test.customer.v2-to-v1",
    },
    ...overrides,
  });
}

function primitiveMigration(): VersionMigrationDefinition {
  return defineVersionMigration({
    schema: "dzupagent.versionMigrationDefinition/v1",
    ref: "migration://primitive/test.lookup@1-to-2",
    owner: "test",
    fromRef: primitiveV1.ref,
    toRef: primitiveV2.ref,
    fromSemanticHash: primitiveV1.compatibility.semanticHash,
    toSemanticHash: primitiveV2.compatibility.semanticHash,
    classification: "compatible",
    transformRef: "test.lookup.v1-to-v2",
    rollback: {
      kind: "manual",
      instructions: "Restore the removed optional field from retained source.",
    },
  });
}

const handlers = {
  transforms: {
    "test.customer.v1-to-v2": (value: unknown) => {
      const input = value as { fullName: string };
      return { name: input.fullName };
    },
    "test.customer.v2-to-v1": (value: unknown) => {
      const input = value as { name: string };
      return { fullName: input.name };
    },
    "test.lookup.v1-to-v2": (value: unknown) => value,
  },
  projections: {
    "test.customer.semantic": (value: unknown) => {
      const input = value as { fullName?: string; name?: string };
      return { customerName: input.name ?? input.fullName };
    },
  },
} as const;

describe("version migration contracts", () => {
  it("builds an immutable order-independent registry bound to exact catalogs", () => {
    const left = createVersionMigrationRegistry(
      [schemaMigration(), primitiveMigration()],
      { schemaRegistry, primitiveRegistry },
    );
    const right = createVersionMigrationRegistry(
      [primitiveMigration(), schemaMigration()],
      { schemaRegistry, primitiveRegistry },
    );

    expect(left.registryHash).toBe(right.registryHash);
    expect(
      left.find(schemaV1.ref, schemaV2.ref)?.ref,
    ).toBe("migration://schema/test/customer@1-to-2");
    expect(left.list()).toHaveLength(2);
    expect(Object.isFrozen(left.list())).toBe(true);
    expect(Object.isFrozen(left.list()[0])).toBe(true);
  });

  it("previews deterministic equivalent transformation and exact rollback", () => {
    const registry = createVersionMigrationRegistry([schemaMigration()], {
      schemaRegistry,
    });
    const input = Object.freeze({ fullName: "Ada Lovelace" });
    const preview = previewVersionMigration(
      "migration://schema/test/customer@1-to-2",
      input,
      registry,
      handlers,
    );

    expect(preview).toMatchObject({
      status: "previewed",
      classification: "equivalent",
      changed: true,
      semanticEquivalent: true,
      output: { name: "Ada Lovelace" },
      rollback: { kind: "exact", restoresInput: true },
    });
    expect(input).toEqual({ fullName: "Ada Lovelace" });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.output)).toBe(true);
  });

  it("qualifies a hash-pinned fixture set and reports semantic drift", () => {
    const registry = createVersionMigrationRegistry([schemaMigration()], {
      schemaRegistry,
    });
    const ready = qualifyVersionMigration(
      "migration://schema/test/customer@1-to-2",
      [
        {
          id: "named-customer",
          input: { fullName: "Grace Hopper" },
          expectedOutput: { name: "Grace Hopper" },
        },
      ],
      registry,
      handlers,
    );
    expect(ready.ready).toBe(true);
    expect(ready.results[0]).toMatchObject({
      passed: true,
      diagnostics: [],
    });
    expect(ready.fixtureSetHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reordered = qualifyVersionMigration(
      "migration://schema/test/customer@1-to-2",
      [
        {
          id: "second-customer",
          input: { fullName: "Ada Lovelace" },
          expectedOutput: { name: "Ada Lovelace" },
        },
        {
          id: "named-customer",
          input: { fullName: "Grace Hopper" },
          expectedOutput: { name: "Grace Hopper" },
        },
      ],
      registry,
      handlers,
    );
    const reverseOrder = qualifyVersionMigration(
      "migration://schema/test/customer@1-to-2",
      [...reordered.results]
        .reverse()
        .map((result) =>
          result.id === "named-customer"
            ? {
                id: result.id,
                input: { fullName: "Grace Hopper" },
                expectedOutput: { name: "Grace Hopper" },
              }
            : {
                id: result.id,
                input: { fullName: "Ada Lovelace" },
                expectedOutput: { name: "Ada Lovelace" },
              },
        ),
      registry,
      handlers,
    );
    expect(reordered.fixtureSetHash).toBe(reverseOrder.fixtureSetHash);

    const drifted = qualifyVersionMigration(
      "migration://schema/test/customer@1-to-2",
      [
        {
          id: "wrong-expectation",
          input: { fullName: "Grace Hopper" },
          expectedOutput: { name: "Different" },
        },
      ],
      registry,
      handlers,
    );
    expect(drifted.ready).toBe(false);
    expect(drifted.results[0]?.diagnostics).toContain(
      "MIGRATION_EXPECTED_OUTPUT_MISMATCH",
    );
  });

  it("fails closed on route, catalog, semantic-hash, and handler drift", () => {
    expect(() =>
      schemaMigration({
        ref: "migration://schema/test/customer@2-to-1",
      }),
    ).toThrow(/does not match its exact route/);
    expect(() =>
      createVersionMigrationRegistry([schemaMigration()], {}),
    ).toThrow(/cannot resolve schema:\/\/test\/customer@1/);
    expect(() =>
      createVersionMigrationRegistry(
        [
          {
            ...schemaMigration(),
            fromSemanticHash: `sha256:${"0".repeat(64)}`,
          },
        ],
        { schemaRegistry },
      ),
    ).toThrow(/hash does not match|semantic hash drift/);

    const registry = createVersionMigrationRegistry([schemaMigration()], {
      schemaRegistry,
    });
    expect(() =>
      previewVersionMigration(
        "migration://schema/test/customer@1-to-2",
        { fullName: "Ada" },
        registry,
        { transforms: {} },
      ),
    ).toThrow(/handler .* is not registered/);
    expect(() =>
      previewVersionMigration(
        "migration://schema/test/customer@1-to-2",
        { fullName: "Ada" },
        registry,
        {
          ...handlers,
          transforms: {
            ...handlers.transforms,
            "test.customer.v1-to-v2": () => ({ random: Math.random() }),
          },
        },
      ),
    ).toThrow(/nondeterministic/);
  });

  it("blocks incompatible routes and rejects non-JSON preview inputs", () => {
    const incompatible = defineVersionMigration({
      schema: "dzupagent.versionMigrationDefinition/v1",
      ref: "migration://schema/test/customer@1-to-2",
      owner: "test",
      fromRef: schemaV1.ref,
      toRef: schemaV2.ref,
      fromSemanticHash: schemaV1.compatibility.semanticHash,
      toSemanticHash: schemaV2.compatibility.semanticHash,
      classification: "incompatible",
      rollback: { kind: "unavailable", reason: "Manual recreation required." },
    });
    const registry = createVersionMigrationRegistry([incompatible], {
      schemaRegistry,
    });
    expect(
      previewVersionMigration(
        incompatible.ref,
        { fullName: "Ada" },
        registry,
        { transforms: {} },
      ),
    ).toMatchObject({
      status: "blocked-incompatible",
      changed: false,
      rollback: {
        kind: "unavailable",
        detail: "Manual recreation required.",
      },
    });
    expect(
      qualifyVersionMigration(
        incompatible.ref,
        [{ id: "blocked", input: { fullName: "Ada" } }],
        registry,
        { transforms: {} },
      ),
    ).toMatchObject({
      ready: false,
      results: [
        {
          passed: false,
          diagnostics: ["MIGRATION_INCOMPATIBLE"],
        },
      ],
    });

    const equivalentRegistry = createVersionMigrationRegistry(
      [schemaMigration()],
      { schemaRegistry },
    );
    expect(() =>
      previewVersionMigration(
        schemaMigration().ref,
        { fullName: Number.NaN },
        equivalentRegistry,
        handlers,
      ),
    ).toThrow(/finite JSON data/);
  });
});
