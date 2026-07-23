import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_DEFINITIONS_V2,
  BUILT_IN_PRIMITIVES,
  definePrimitiveV2,
  primitiveKind,
  validatePrimitiveDefinitionV2,
} from "../primitives/index.js";

describe("PrimitiveDefinitionV2", () => {
  it("is complete and deterministically hashed for every built-in", () => {
    expect(BUILT_IN_PRIMITIVE_DEFINITIONS_V2).toHaveLength(9);
    for (const definition of BUILT_IN_PRIMITIVE_DEFINITIONS_V2) {
      expect(definition.schema).toBe("dzupagent.primitiveDefinition/v2");
      expect(definition.compatibility.semanticHash).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      expect(Object.keys(definition.outputPorts).length).toBeGreaterThan(0);
      expect(definition.effect.classes.length).toBeGreaterThan(0);
      expect(definition.execution.delivery.length).toBeGreaterThan(0);
      expect(definition.execution.durability.length).toBeGreaterThan(0);
      expect(() => validatePrimitiveDefinitionV2(definition)).not.toThrow();
    }
  });

  it("generates the legacy registry view without identity drift", () => {
    expect(
      BUILT_IN_PRIMITIVE_DEFINITIONS_V2.map(primitiveKind),
    ).toEqual(BUILT_IN_PRIMITIVES.map((definition) => definition.kind));
    expect(
      BUILT_IN_PRIMITIVE_DEFINITIONS_V2.map(
        (definition) => definition.namespace,
      ),
    ).toEqual(BUILT_IN_PRIMITIVES.map((definition) => definition.namespace));
    expect(
      BUILT_IN_PRIMITIVES.find(
        (definition) => definition.kind === "collab.review_loop",
      )?.expand,
    ).toBeTypeOf("function");
  });

  it("changes the semantic hash when a semantic field changes", () => {
    const source = BUILT_IN_PRIMITIVE_DEFINITIONS_V2[0]!;
    const {
      semanticHash: _semanticHash,
      ...compatibility
    } = source.compatibility;
    const changed = definePrimitiveV2({
      ...source,
      owner: "different-owner",
      compatibility,
    });

    expect(changed.compatibility.semanticHash).not.toBe(
      source.compatibility.semanticHash,
    );
  });

  it("rejects an executable definition without output ports", () => {
    const source = BUILT_IN_PRIMITIVE_DEFINITIONS_V2[0]!;
    expect(() =>
      validatePrimitiveDefinitionV2({ ...source, outputPorts: {} }),
    ).toThrow(/at least one output port/);
  });

  it("rejects a semantic hash that does not match the contract", () => {
    const source = BUILT_IN_PRIMITIVE_DEFINITIONS_V2[0]!;
    expect(() =>
      validatePrimitiveDefinitionV2({
        ...source,
        compatibility: {
          ...source.compatibility,
          semanticHash: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).toThrow(/does not match/);
  });

  it("binds required redaction evidence to the canonical receipt schema", () => {
    const evidenceWrite = BUILT_IN_PRIMITIVE_DEFINITIONS_V2.find(
      (definition) => primitiveKind(definition) === "evidence.write",
    )!;
    expect(evidenceWrite.evidence).toEqual(
      expect.objectContaining({
        redactionReceiptRequired: true,
        redactionReceiptSchema: "dzupagent.flowRedactionReceipt/v1",
      }),
    );
    expect(() =>
      validatePrimitiveDefinitionV2({
        ...evidenceWrite,
        evidence: {
          ...evidenceWrite.evidence,
          redactionReceiptSchema: undefined,
        },
      }),
    ).toThrow(/canonical redaction receipt schema/);
  });

  it("requires handle-only primitives to declare their resolver capability", () => {
    const adapterRun = BUILT_IN_PRIMITIVE_DEFINITIONS_V2.find(
      (definition) => primitiveKind(definition) === "adapter.run",
    )!;
    expect(adapterRun.credentialResolverCapabilityRef).toBe(
      "flow.runtime.credential.resolve@1",
    );
    expect(adapterRun.requiresCapabilities).toContain(
      adapterRun.credentialResolverCapabilityRef,
    );
    expect(() =>
      validatePrimitiveDefinitionV2({
        ...adapterRun,
        credentialResolverCapabilityRef: undefined,
      }),
    ).toThrow(/credential resolver capability/);
  });

  it("declares HTTP auth as one opaque handle slot with classified output", () => {
    const http = BUILT_IN_PRIMITIVE_DEFINITIONS_V2.find(
      (definition) => primitiveKind(definition) === "http",
    )!;
    expect(http).toEqual(
      expect.objectContaining({
        credentialInputs: "handle-only",
        credentialInputPaths: ["auth.credential"],
        credentialResolverCapabilityRef:
          "flow.runtime.credential.resolve@1",
        acceptedInputClassifications: ["public", "internal"],
        outputPorts: {
          response: expect.objectContaining({
            classification: "sensitive",
          }),
        },
      }),
    );
  });
});
