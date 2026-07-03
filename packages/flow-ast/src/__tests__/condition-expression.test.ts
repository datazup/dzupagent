import { describe, expect, it } from "vitest";

import {
  resolveFlowConditionExpression,
  resolveFlowTemplateExpression,
  validateFlowConditionExpression,
} from "../condition-expression.js";

describe("flow condition expressions", () => {
  const state = {
    ready: true,
    count: 3,
    verify: { passed: true },
    repair: { strategy: "patch" },
  };

  it("resolves state, ctx, and bare path aliases against runtime state", () => {
    expect(resolveFlowConditionExpression("state.verify.passed", state)).toBe(true);
    expect(resolveFlowConditionExpression("ctx.verify.passed", state)).toBe(true);
    expect(resolveFlowConditionExpression("ready", state)).toBe(true);
  });

  it("evaluates whole-template, partial-template, and comparison predicates", () => {
    expect(resolveFlowTemplateExpression("repair: {{ state.repair.strategy }}", state)).toBe("repair: patch");
    expect(resolveFlowConditionExpression("{{ state.verify.passed }}", state)).toBe(true);
    expect(resolveFlowConditionExpression("{{ state.verify.passed }} === true", state)).toBe(true);
    expect(resolveFlowConditionExpression("state.count >= 3", state)).toBe(true);
    expect(resolveFlowConditionExpression("state.count < 3", state)).toBe(false);
    expect(resolveFlowConditionExpression("state.repair.strategy === 'patch'", state)).toBe(true);
  });

  it("validates the same safe expression subset the runtime resolves", () => {
    expect(validateFlowConditionExpression("ctx.ready === true")).toEqual({ valid: true });
    expect(validateFlowConditionExpression("state.count >= 3")).toEqual({ valid: true });
    expect(validateFlowConditionExpression("{{ state.verify.passed }} === true")).toEqual({ valid: true });

    expect(validateFlowConditionExpression("state.count + 1 > 3")).toMatchObject({
      valid: false,
      reason: expect.stringContaining("unsupported"),
    });
    expect(validateFlowConditionExpression('eval("state.ready")')).toMatchObject({
      valid: false,
      reason: expect.stringContaining("disallowed"),
    });
  });
});
