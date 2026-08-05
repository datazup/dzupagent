/**
 * Regression tests for DSL-06: loop.progressKey is declared on the type and
 * read by the normalizer, but was silently dropped by BOTH the parse and the
 * validate boundary. Exact-equality assertions so a dropped field fails.
 */
import { describe, expect, it } from "vitest";

import { parseFlow } from "../index.js";
import { flowNodeSchema } from "../validate.js";

const loop = {
  type: "loop",
  condition: "${running}",
  body: [{ type: "complete" }],
  maxIterations: 5,
  progressKey: "collector-step",
};

describe("loop.progressKey crosses both boundaries", () => {
  it("parseFlow keeps progressKey on the loop node", () => {
    const result = parseFlow(loop);
    expect(result.errors).toEqual([]);
    // Exact equality: a silently dropped field fails this assertion.
    expect(result.ast).toEqual(loop);
  });

  it("flowNodeSchema keeps progressKey on the validated node", () => {
    const result = flowNodeSchema.safeParse(loop);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        progressKey: "collector-step",
        maxIterations: 5,
      });
    }
  });

  it("ignores a non-string progressKey without failing the parse", () => {
    const result = parseFlow({ ...loop, progressKey: 7 });
    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual({
      type: "loop",
      condition: "${running}",
      body: [{ type: "complete" }],
      maxIterations: 5,
    });
  });
});
