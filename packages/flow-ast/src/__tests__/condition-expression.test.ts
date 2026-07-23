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

  it("keeps compat-v1 aliases as the default but supports opt-in strict roots", () => {
    expect(validateFlowConditionExpression("ctx.ready === true")).toEqual({
      valid: true,
    });
    expect(
      validateFlowConditionExpression("ctx.ready === true", {
        referencePolicy: "strict",
      }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("DISALLOWED_REFERENCE_ROOT"),
    });
    expect(
      validateFlowConditionExpression("state.ready === true", {
        referencePolicy: "strict",
      }),
    ).toEqual({ valid: true });
  });

  it("fails missing strict bindings when a symbol snapshot is supplied", () => {
    expect(
      validateFlowConditionExpression("inputs.missing === true", {
        referencePolicy: "strict",
        knownBindings: { inputs: ["ready"] },
      }),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("MISSING_REFERENCE"),
    });
  });
});
