import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  createPrimitiveRegistry,
  createPrimitiveRegistryV2,
  expandRegisteredComposites,
  expandRegisteredCompositesDetailed,
  type PrimitiveDefinition,
} from "../primitives/index.js";
import { BUILT_IN_FRAGMENT_REGISTRY } from "../fragments/built-ins.js";
import {
  readV2SourceLineage,
  withV2SourceLineage,
} from "../v2/source-lineage.js";

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
      {
        complete: {
          id: "custom_step",
          result: "custom",
          meta: { primitive: "custom.workflow@1" },
        },
      },
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

  it("records exact semantic lineage for a pinned composite expansion", () => {
    const result = expandRegisteredCompositesDetailed(
      {
        uses: { collab: "dzup.collab@1" },
        steps: [
          {
            "collab.review_loop": {
              id: "review",
              task: { kind: "implementation" },
              proposer: { executionProviderId: "codex" },
              critic: { executionProviderId: "claude" },
            },
          },
        ],
      },
      { requirePrimitiveLineage: true },
    );
    const definition = BUILT_IN_PRIMITIVE_REGISTRY_V2.get(
      "primitive://collab.review_loop@1",
    );

    expect(result.primitiveExpansions).toEqual([
      {
        ref: "primitive://collab.review_loop@1",
        semanticHash: definition?.compatibility.semanticHash,
        invocationPath: "steps[0]",
        expandedPaths: [
          "steps[0].expanded[0]",
          "steps[0].expanded[1]",
          "steps[0].expanded[2]",
        ],
        childPrimitiveRefs: [],
      },
    ]);
    expect(
      result.primitiveExpansions[0]?.semanticHash,
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.primitiveExpansions[0])).toBe(true);
    expect(Object.isFrozen(result.primitiveExpansions[0]?.expandedPaths)).toBe(
      true,
    );
  });

  it("fails closed when strict lineage has no exact V2 contract", () => {
    const registry = createPrimitiveRegistry([versionedComposite("1")]);

    expect(() =>
      expandRegisteredCompositesDetailed(
        {
          uses: { custom: "dzup.custom@1" },
          steps: [{ "custom.workflow": { id: "untracked" } }],
        },
        {
          primitiveRegistry: registry,
          primitiveRegistryV2: createPrimitiveRegistryV2([]),
          requirePrimitiveLineage: true,
        },
      ),
    ).toThrow(
      /custom\.workflow@1 requires an exact V2 definition for expansion lineage/i,
    );
  });

  it("propagates derived v2 lineage through generated fragment steps", () => {
    const marker = {
      authoredPath: "root.steps[0]",
      loweredPath: "steps[0]",
      use: "custom.fragment_composite@1",
      generated: false,
    } as const;
    const result = expandRegisteredCompositesDetailed(
      {
        steps: [
          {
            "sdlc.validation_gate": withV2SourceLineage(
              {
                id: "validation",
                cwd: "packages/flow-dsl",
                command: "yarn test",
              },
              marker,
            ),
          },
        ],
      },
      { fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY },
    );
    const steps = (result.raw as {
      steps: Array<Record<string, Record<string, unknown>>>;
    }).steps;

    expect(steps).toHaveLength(2);
    for (const wrapper of steps) {
      const body = Object.values(wrapper)[0];
      expect(readV2SourceLineage(body)).toEqual({
        ...marker,
        generated: true,
      });
    }
    expect(result.fragmentExpansions).toEqual([
      expect.objectContaining({
        id: "sdlc.validation_gate",
        invocationPath: "steps[0]",
      }),
    ]);
  });
});
