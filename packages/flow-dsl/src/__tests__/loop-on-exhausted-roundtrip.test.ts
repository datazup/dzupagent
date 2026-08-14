/** F-R4 — loop.onExhausted survives the V1 authoring codec. */
import type { FlowDocumentV1, LoopNode } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { canonicalizeDsl } from "../canonicalize-dsl.js";
import { formatDocumentToDsl } from "../format-dsl.js";
import { normalizeDslDocument } from "../normalize.js";

const loop: LoopNode = {
  type: "loop",
  id: "poll",
  condition: "${running}",
  maxIterations: 5,
  onExhausted: "continue",
  iterationTimeoutMs: 2500,
  iterationBudgetCents: 12.5,
  body: [{ type: "complete", id: "done" }],
};

const document: FlowDocumentV1 = {
  dsl: "dzupflow/v1",
  id: "loop-exhaustion",
  version: 1,
  root: { type: "sequence", id: "root", nodes: [loop] },
};

describe("F-R4 — loop.onExhausted DSL codec", () => {
  it("format -> canonicalize retains continue exactly", () => {
    const result = canonicalizeDsl(formatDocumentToDsl(document));

    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    expect(result.document?.root.nodes[0]).toEqual(loop);
  });

  it("normalizer reports an invalid enum instead of dropping it", () => {
    const result = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "loop-exhaustion",
      version: 1,
      steps: [
        {
          loop: {
            id: "poll",
            condition: "${running}",
            maxIterations: 5,
            onExhausted: "branch",
            body: [{ complete: { id: "done" } }],
          },
        },
      ],
    });

    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "INVALID_ENUM_VALUE" &&
          diagnostic.path?.endsWith(".onExhausted")
      ),
      JSON.stringify(result.diagnostics)
    ).toBe(true);
  });

  it("normalizer reports an invalid per-iteration timeout", () => {
    const result = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "loop-timeout",
      version: 1,
      steps: [
        {
          loop: {
            id: "poll",
            condition: "${running}",
            iterationTimeoutMs: 0,
            body: [{ complete: { id: "done" } }],
          },
        },
      ],
    });

    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.path?.endsWith(".iterationTimeoutMs")
      ),
      JSON.stringify(result.diagnostics)
    ).toBe(true);
  });

  it("normalizer reports an invalid per-iteration budget", () => {
    const result = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "loop-budget",
      version: 1,
      steps: [
        {
          loop: {
            id: "poll",
            condition: "${running}",
            iterationBudgetCents: 0,
            body: [{ complete: { id: "done" } }],
          },
        },
      ],
    });

    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.path?.endsWith(".iterationBudgetCents")
      ),
      JSON.stringify(result.diagnostics)
    ).toBe(true);
  });
});
