import { describe, expect, it } from "vitest";

import {
  parseDslToDocument,
} from "../index.js";
import {
  createDslSourceMap,
  resolveDslSourceSpan,
} from "../dsl-source-map.js";

describe("DzupFlow absolute source maps", () => {
  it("composes nested canonical branch paths with quoted and inline JSON values", () => {
    const source = `dsl: dzupflow/v1
id: source_map
version: 1
inputs:
  goal: string
steps:
  - if:
      id: choose
      condition: inputs.goal == "ship"
      then:
        - action:
            id: run
            ref: known.tool
            input: { "prompt": "Implement {{ inputs.missing }}" }
      else:
        - complete:
            id: stop
            result: skipped
`;
    const parsed = parseDslToDocument(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid source");

    const sourceMap = createDslSourceMap(source, parsed.document);
    expect(sourceMap?.schema).toBe("dzupagent.dslSourceMap/v1");
    const value = "Implement {{ inputs.missing }}";
    const relativeStart = value.indexOf("inputs.missing");
    const span = sourceMap === undefined
      ? undefined
      : resolveDslSourceSpan(
          sourceMap,
          "root.nodes[0].then[0].input.prompt",
          {
            start: relativeStart,
            end: relativeStart + "inputs.missing".length,
          },
        );

    expect(span).toEqual(
      expect.objectContaining({
        start: expect.any(Number),
        end: expect.any(Number),
        lineStart: 14,
        lineEnd: 14,
      }),
    );
    expect(source.slice(span?.start, span?.end)).toBe("inputs.missing");
    expect(
      sourceMap?.entries["root.nodes[0].then[0].toolRef"]?.authoredPath,
    ).toBe("root.steps[0].if.then[0].action.ref");
  });

  it("maps literal-block reference offsets through indentation", () => {
    const source = `dsl: dzupflow/v1
id: literal_map
version: 1
inputs:
  goal: string
steps:
  - action:
      id: run
      ref: known.tool
      input:
        prompt: |
          Implement {{ inputs.goal }}
          with evidence
`;
    const parsed = parseDslToDocument(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid source");
    const sourceMap = createDslSourceMap(source, parsed.document);
    const value = "Implement {{ inputs.goal }}\nwith evidence";
    const relativeStart = value.indexOf("inputs.goal");
    const span = sourceMap === undefined
      ? undefined
      : resolveDslSourceSpan(
          sourceMap,
          "root.nodes[0].input.prompt",
          {
            start: relativeStart,
            end: relativeStart + "inputs.goal".length,
          },
        );

    expect(source.slice(span?.start, span?.end)).toBe("inputs.goal");
    expect(span).toEqual(
      expect.objectContaining({ lineStart: 12, lineEnd: 12 }),
    );
  });
});
