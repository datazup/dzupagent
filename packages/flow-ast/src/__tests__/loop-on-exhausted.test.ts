/** F-R4 — loop exhaustion policy crosses both hand-written AST boundaries. */
import { describe, expect, it } from "vitest";

import { parseFlow } from "../index.js";
import { flowNodeSchema } from "../validate.js";

const loop = {
  type: "loop",
  condition: "${running}",
  body: [{ type: "complete" }],
  maxIterations: 5,
  onExhausted: "continue",
} as const;

describe("F-R4 — loop.onExhausted AST admission", () => {
  it("parseFlow retains the authored value", () => {
    const result = parseFlow(loop);

    expect(result.errors).toEqual([]);
    expect(result.ast).toEqual(loop);
  });

  it("flowNodeSchema retains the authored value", () => {
    const result = flowNodeSchema.safeParse(loop);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ onExhausted: "continue" });
    }
  });

  it("both boundaries reject an unknown exhaustion policy", () => {
    const invalid = { ...loop, onExhausted: "branch" };
    const parsed = parseFlow(invalid);

    expect(
      parsed.errors.some((error) =>
        error.pointer?.endsWith("/onExhausted")
      )
    ).toBe(true);
    expect(flowNodeSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps the fail-closed default implicit when the field is absent", () => {
    const { onExhausted: _omitted, ...withoutPolicy } = loop;
    const parsed = parseFlow(withoutPolicy);

    expect(parsed.errors).toEqual([]);
    expect(parsed.ast).toEqual(withoutPolicy);
    expect(flowNodeSchema.safeParse(withoutPolicy).success).toBe(true);
  });
});
