import { describe, expect, it } from "vitest";

import {
  createPrimitiveRegistry,
  expandRegisteredComposites,
  expandRegisteredCompositesDetailed,
  type PrimitiveDefinition,
} from "../primitives/index.js";

function versionedComposite(version: string): PrimitiveDefinition {
  return {
    kind: "custom.workflow",
    version,
    namespace: "custom",
    category: "composite",
    schema: { type: "object" },
    expandsTo: ["complete"],
    expand: (raw, context) => {
      const input = raw as { id?: string };
      return [
        {
          complete: {
            id: input.id ?? "custom_done",
            result: `v${version}`,
            meta: { primitive: `${context.kind}@${context.version}` },
          },
        },
      ];
    },
  };
}

describe("registry-backed composite expansion", () => {
  it("expands composite primitives through the supplied registry", () => {
    const customComposite: PrimitiveDefinition = {
      kind: "custom.workflow",
      version: "1",
      namespace: "custom",
      category: "composite",
      schema: { type: "object" },
      expandsTo: ["complete"],
      expand: (raw) => {
        const input = raw as { id?: string };
        return [
          {
            complete: {
              id: input.id ?? "custom_done",
              result: "custom",
            },
          },
        ];
      },
    };
    const registry = createPrimitiveRegistry([customComposite]);

    const output = expandRegisteredComposites(
      {
        steps: [{ "custom.workflow": { id: "custom_step" } }],
      },
      registry
    ) as { steps: Array<Record<string, unknown>> };

    expect(output.steps).toEqual([
      { complete: { id: "custom_step", result: "custom" } },
    ]);
  });

  it("returns the original object when no registered composite is present", () => {
    const registry = createPrimitiveRegistry([]);
    const input = { steps: [{ complete: { id: "done", result: "ok" } }] };

    expect(expandRegisteredComposites(input, registry)).toBe(input);
  });

  it("does not expand wrapper-shaped data inside node payloads", () => {
    const customComposite: PrimitiveDefinition = {
      kind: "custom.workflow",
      version: "1",
      namespace: "custom",
      category: "composite",
      schema: { type: "object" },
      expandsTo: ["complete"],
      expand: (raw) => {
        const input = raw as { id?: string };
        return [{ complete: { id: input.id ?? "custom_done", result: "custom" } }];
      },
    };
    const registry = createPrimitiveRegistry([customComposite]);
    const input = {
      steps: [
        {
          action: {
            id: "inspect_payload",
            ref: "payload.inspect",
            input: {
              examples: [{ "custom.workflow": { id: "payload_data" } }],
            },
          },
        },
      ],
    };

    expect(expandRegisteredComposites(input, registry)).toEqual(input);
  });

  it("selects each namespace-pinned composite version before expansion", () => {
    const registry = createPrimitiveRegistry([
      versionedComposite("1"),
      versionedComposite("2"),
    ]);
    for (const version of ["1", "2"]) {
      const pinned = expandRegisteredComposites(
        {
          uses: { custom: `dzup.custom@${version}` },
          steps: [{ "custom.workflow": { id: `pinned_v${version}` } }],
        },
        registry,
      ) as { steps: Array<{ complete: Record<string, unknown> }> };

      expect(pinned.steps[0]?.complete).toMatchObject({
        result: `v${version}`,
        meta: { primitive: `custom.workflow@${version}` },
      });
    }
  });

  it("keeps latest-version behavior for unpinned composites with selected-version provenance", () => {
    const registry = createPrimitiveRegistry([
      versionedComposite("1"),
      versionedComposite("2"),
    ]);
    const unpinned = expandRegisteredComposites(
      { steps: [{ "custom.workflow": { id: "unpinned" } }] },
      registry,
    ) as { steps: Array<{ complete: Record<string, unknown> }> };

    expect(unpinned.steps[0]?.complete).toMatchObject({
      result: "v2",
      meta: { primitive: "custom.workflow@2" },
    });
  });

  it("rejects an invoked composite pinned to an unregistered version", () => {
    const registry = createPrimitiveRegistry([versionedComposite("1")]);

    expect(() =>
      expandRegisteredComposites(
        {
          uses: { custom: "dzup.custom@2" },
          steps: [{ "custom.workflow": { id: "unknown" } }],
        },
        registry,
      ),
    ).toThrow(
      /custom\.workflow is pinned by uses\.custom to dzup\.custom@2, but custom\.workflow@2 is not registered as a composite/i,
    );
  });

  it("preserves version selection for nested composites and fragment options", () => {
    const registry = createPrimitiveRegistry([
      versionedComposite("1"),
      versionedComposite("2"),
    ]);
    const output = expandRegisteredCompositesDetailed(
      {
        uses: { custom: "dzup.custom@1" },
        steps: [
          {
            if: {
              id: "nested",
              condition: "{{ state.ready }}",
              then: [{ "custom.workflow": { id: "nested_composite" } }],
            },
          },
        ],
      },
      { primitiveRegistry: registry, requirePinnedFragmentUses: true },
    ).raw as {
      steps: Array<{ if: { then: Array<{ complete: Record<string, unknown> }> } }>;
    };

    expect(output.steps[0]?.if.then[0]?.complete).toMatchObject({
      result: "v1",
      meta: { primitive: "custom.workflow@1" },
    });
  });
});
