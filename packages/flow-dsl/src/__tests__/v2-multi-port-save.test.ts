import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  createPrimitiveRegistryV2,
  definePrimitiveV2,
  parseDslToDocument,
  toPrimitiveRegistryV1,
  type PrimitiveDefinitionV2,
} from "../index.js";
import {
  evaluatePrimitiveMultiPortSave,
  FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY,
} from "../v2-multi-port-save.js";

const ADAPTER_RUN = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
  "adapter.run",
  "1",
)!;

function multiPortAdapter(): PrimitiveDefinitionV2 {
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = ADAPTER_RUN;
  return definePrimitiveV2({
    ...contract,
    outputPorts: {
      result: ADAPTER_RUN.outputPorts.result!,
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
      supersedes: [],
      deprecatedAliases: [],
    },
  });
}

describe(FLOW_PRIMITIVE_MULTI_PORT_SAVE_CAPABILITY, () => {
  it("retains exact port and typed destination evidence deterministically", () => {
    const primitive = multiPortAdapter();
    const result = evaluatePrimitiveMultiPortSave(
      primitive,
      {
        result: "state.result",
        receipt: "state.receipt",
      },
      { guarded: true, terminalCatchContinues: true },
    );

    expect(result).toMatchObject({
      ok: true,
      contract: {
        bindings: [
          {
            port: "receipt",
            target: "state.receipt",
            source: {
              cardinality: "one",
              classification: "internal",
              persistence: "state",
            },
            destination: {
              kind: "state",
              key: "receipt",
            },
            availability: {
              producedOn: "primitive-success",
              guarded: true,
              unavailableOnTerminalCatchContinue: true,
            },
          },
          {
            port: "result",
            target: "state.result",
          },
        ],
      },
    });
    if (!result.ok) throw new Error("expected valid multi-port save");
    expect(Object.isFrozen(result.contract)).toBe(true);
    expect(Object.isFrozen(result.contract.bindings)).toBe(true);
    expect(
      Object.isFrozen(result.contract.bindings[0]?.source.schema),
    ).toBe(true);
  });

  it("rejects unknown ports, duplicate destinations, and invalid targets", () => {
    const primitive = multiPortAdapter();
    const result = evaluatePrimitiveMultiPortSave(primitive, {
      missing: "state.same",
      receipt: "state.same",
      result: "artifact.result",
    });

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_MULTI_SAVE_UNKNOWN_PORT",
          field: "missing",
        }),
        expect.objectContaining({
          code: "V2_MULTI_SAVE_TARGET_INVALID",
          field: "result",
        }),
      ]),
    });
    expect(
      evaluatePrimitiveMultiPortSave(primitive, {
        receipt: "state.same",
        result: "state.same",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_MULTI_SAVE_TARGET_DUPLICATE",
          field: "result",
        }),
      ],
    });
  });

  it("rejects state destinations for non-state output persistence", () => {
    const primitive = multiPortAdapter();
    const {
      compatibility: { semanticHash: _semanticHash, ...compatibility },
      ...contract
    } = primitive;
    const artifactPrimitive = definePrimitiveV2({
      ...contract,
      outputPorts: {
        ...primitive.outputPorts,
        receipt: {
          ...primitive.outputPorts.receipt!,
          persistence: "artifact",
        },
      },
      compatibility: {
        ...compatibility,
      },
    });
    const result = evaluatePrimitiveMultiPortSave(artifactPrimitive, {
      receipt: "state.receipt",
      result: "state.result",
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_MULTI_SAVE_PERSISTENCE_MISMATCH",
          field: "receipt",
        }),
      ],
    });
  });

  it("binds full metadata and only a deterministic V1 compatibility anchor", () => {
    const primitive = multiPortAdapter();
    const registry = createPrimitiveRegistryV2(
      BUILT_IN_PRIMITIVE_REGISTRY_V2.list().map((definition) =>
        definition.ref === primitive.ref ? primitive : definition,
      ),
    );
    const parsed = parseDslToDocument(
      `
dsl: dzupflow/v2
id: multi-save
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: run
    use: adapter.run@1
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
    save:
      result: state.result
      receipt: state.receipt
`,
      {
        primitiveRegistryV2: registry,
        primitiveRegistry: toPrimitiveRegistryV1(registry),
      },
    );

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
    }
    expect(parsed.frontend?.multiPortSaves).toEqual([
      expect.objectContaining({
        authoredPath: "root.steps[0]",
        primitiveRef: primitive.ref,
        primitiveSemanticHash: primitive.compatibility.semanticHash,
        save: {
          bindings: expect.arrayContaining([
            expect.objectContaining({
              port: "result",
              availability: {
                producedOn: "primitive-success",
                guarded: true,
                unavailableOnTerminalCatchContinue: true,
              },
            }),
          ]),
        },
      }),
    ]);
    const lowered = JSON.stringify(parsed.document.root.nodes[0]);
    expect(lowered).toContain('"output":"result"');
    expect(lowered).not.toContain('"outputVar"');
    expect(lowered).not.toContain('"receipt":"receipt"');
  });

  it("preserves the established single-port compatibility path", () => {
    const parsed = parseDslToDocument(`
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

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
    }
    expect(parsed.frontend?.multiPortSaves).toEqual([]);
    expect(JSON.stringify(parsed.document.root.nodes[0])).toContain(
      '"output":"result"',
    );
  });
});
