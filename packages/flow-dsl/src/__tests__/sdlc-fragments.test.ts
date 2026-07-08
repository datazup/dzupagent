import { describe, expect, it } from "vitest";

import {
  BUILT_IN_FRAGMENT_REGISTRY,
  BUILT_IN_SDL_FRAGMENT_DEFINITIONS,
} from "../fragments/built-ins.js";
import { parseDslToDocument } from "../parse-dsl.js";

describe("built-in SDLC fragments", () => {
  it("registers the first reusable sdlc fragment set", () => {
    expect(
      BUILT_IN_FRAGMENT_REGISTRY.list("sdlc").map((entry) => entry.id)
    ).toEqual([
      "sdlc.closeout",
      "sdlc.batch_validation",
      "sdlc.current_truth",
      "sdlc.gated_packet",
      "sdlc.git_truth",
      "sdlc.packet_fanout",
      "sdlc.validation_gate",
    ]);
    expect(BUILT_IN_SDL_FRAGMENT_DEFINITIONS).toHaveLength(7);
  });

  it("expands sdlc.validation_gate through the built-in registry", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: sdlc-library-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.validation_gate:
      id: validation
      cwd: packages/flow-dsl
      command: yarn test
`,
      { fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY }
    );

    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes.map((node) => node.id)).toEqual([
      "validation__run_validation",
      "validation__classify_validation",
    ]);
    expect(result.document?.meta?.fragmentUses).toEqual({
      sdlc: "dzup.sdlc@1",
    });
  });

  it("expands built-in SDLC fragments through the default parser registry", () => {
    const result = parseDslToDocument(`
dsl: dzupflow/v1
id: default-sdlc-library-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.validation_gate:
      id: validation
      cwd: packages/flow-dsl
      command: yarn test
`);

    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes.map((node) => node.id)).toEqual([
      "validation__run_validation",
      "validation__classify_validation",
    ]);
    expect(result.document?.meta?.fragmentUses).toEqual({
      sdlc: "dzup.sdlc@1",
    });
  });

  it("expands sdlc.validation_gate with built-in registry in strict unattended mode", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: sdlc-library-strict-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.validation_gate:
      id: validation
      cwd: packages/flow-dsl
      command: yarn test
`,
      {
        fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
        requirePinnedFragmentUses: true,
      }
    );

    expect(result.ok).toBe(true);
    expect(result.document?.root.nodes.map((node) => node.id)).toEqual([
      "validation__run_validation",
      "validation__classify_validation",
    ]);
  });

  it("expands sdlc.batch_validation as a for_each collect fragment", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: sdlc-batch-validation-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.batch_validation:
      id: batch
      itemsKey: validationItems
      output: validationStatuses
`,
      {
        fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
        requirePinnedFragmentUses: true,
      },
    );

    expect(result.ok).toBe(true);
    const loop = result.document?.root.nodes.find(
      (node) => node.id === "batch__validate_each",
    );
    expect(loop).toMatchObject({
      type: "for_each",
      id: "batch__validate_each",
      source: "validationItems",
      as: "validationItem",
      collect: {
        from: "batch__validationStatus",
        into: "batch__validationStatuses",
      },
      body: [
        {
          type: "validate.schema",
          id: "batch__classify_validation",
          source: "{{ state.validationItem.result }}",
          schema: "dzup.sdlc.validation-result@1",
          output: "batch__validationStatus",
        },
      ],
    });
    expect(result.document?.root.nodes.map((node) => node.id)).toContain(
      "batch__export_statuses",
    );
  });

  it("expands sdlc.packet_fanout by composing gated_packet with for_each collect", () => {
    const result = parseDslToDocument(
      `
dsl: dzupflow/v1
id: sdlc-packet-fanout-demo
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.packet_fanout:
      id: fanout
      packetsKey: packetItems
      output: packetStatuses
`,
      {
        fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
        requirePinnedFragmentUses: true,
      },
    );

    expect(result.ok).toBe(true);
    const loop = result.document?.root.nodes.find(
      (node) => node.id === "fanout__dispatch_each_packet",
    );
    expect(loop).toMatchObject({
      type: "for_each",
      id: "fanout__dispatch_each_packet",
      source: "packetItems",
      as: "packetItem",
      collect: {
        from: "fanout__each_packet__packetStatus",
        into: "fanout__packetStatuses",
      },
      body: [
        {
          type: "worker.dispatch",
          id: "fanout__each_packet__dispatch_packet",
          dispatchId: "sdlc.implement_packet",
          provider: "codex",
          instructions:
            "Implement SDLC packet {{ state.packetItem.ref }} and report gate status.",
          input: { packetRef: "{{ state.packetItem.ref }}" },
          outputKey: "fanout__each_packet__packetStatus",
          commandSurface: "none",
          resultFormat: "text",
        },
      ],
    });
    expect(result.document?.root.nodes.map((node) => node.id)).toContain(
      "fanout__export_statuses",
    );
  });
});
