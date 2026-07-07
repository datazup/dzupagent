import { describe, expect, it } from "vitest";

import {
  BUILT_IN_FRAGMENT_REGISTRY,
  BUILT_IN_SDL_FRAGMENT_DEFINITIONS,
} from "../fragments/built-ins.js";
import { parseDslToDocument } from "../parse-dsl.js";

describe("built-in SDLC fragments", () => {
  it("registers the first reusable sdlc fragment set", () => {
    expect(
      BUILT_IN_FRAGMENT_REGISTRY.list("sdlc").map((entry) => entry.id),
    ).toEqual([
      "sdlc.closeout",
      "sdlc.current_truth",
      "sdlc.gated_packet",
      "sdlc.git_truth",
      "sdlc.validation_gate",
    ]);
    expect(BUILT_IN_SDL_FRAGMENT_DEFINITIONS).toHaveLength(5);
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
      { fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY },
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
});
