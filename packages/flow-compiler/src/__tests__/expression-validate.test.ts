import { describe, expect, it } from "vitest";

import { analyzeFlowExpression } from "../stages/expression-validate.js";

describe("analyzeFlowExpression", () => {
  it("extracts unique refs from nested deterministic expressions", () => {
    const result = analyzeFlowExpression({
      op: "and",
      args: [
        {
          op: "eq",
          left: { op: "ref", path: "state.status" },
          right: { op: "literal", value: "passed" },
        },
        {
          op: "exists",
          arg: { op: "ref", path: "params.cwd" },
        },
        {
          op: "eq",
          left: { op: "ref", path: "state.status" },
          right: { op: "literal", value: "passed" },
        },
      ],
    });

    expect(result).toEqual({
      deterministic: true,
      refs: ["state.status", "params.cwd"],
      warnings: [],
    });
  });

  it("marks raw JavaScript expressions as non-deterministic", () => {
    expect(analyzeFlowExpression({ exprJs: "state.count > Math.random()" })).toEqual({
      deterministic: false,
      refs: [],
      warnings: ["RAW_JS_EXPRESSION"],
    });
  });

  it("treats literals as deterministic expressions with no refs", () => {
    expect(analyzeFlowExpression({ op: "literal", value: true })).toEqual({
      deterministic: true,
      refs: [],
      warnings: [],
    });
  });

  it("marks malformed nested expressions as non-deterministic", () => {
    expect(
      analyzeFlowExpression({
        op: "and",
        args: [{ op: "ref", path: "state.ready" }, { bad: true } as never],
      }),
    ).toEqual({
      deterministic: false,
      refs: ["state.ready"],
      warnings: ["INVALID_EXPRESSION_NODE"],
    });
  });

  it("marks unknown expression ops as invalid", () => {
    expect(analyzeFlowExpression({ op: "bogus" } as never)).toEqual({
      deterministic: false,
      refs: [],
      warnings: ["INVALID_EXPRESSION_NODE"],
    });
  });

  it("marks malformed known expression ops as invalid", () => {
    expect(analyzeFlowExpression({ op: "and" } as never)).toEqual({
      deterministic: false,
      refs: [],
      warnings: ["INVALID_EXPRESSION_NODE"],
    });
  });
});
