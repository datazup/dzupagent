import { describe, expect, it } from "vitest";

import {
  createPrimitiveRegistry,
  expandRegisteredComposites,
  type PrimitiveDefinition,
} from "../primitives/index.js";

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
});
