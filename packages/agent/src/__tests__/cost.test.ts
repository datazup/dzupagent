import { describe, it, expect } from "vitest";
import {
  CHARS_PER_TOKEN,
  INPUT_COST_PER_1K_CENTS,
  OUTPUT_COST_PER_1K_CENTS,
  estimateTokens,
  estimateCostCents,
  estimateCostCentsFromChars,
} from "../self-correction/cost.js";

describe("self-correction/cost", () => {
  it("exposes the canonical split pricing constants", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(INPUT_COST_PER_1K_CENTS).toBe(0.025);
    expect(OUTPUT_COST_PER_1K_CENTS).toBe(0.125);
  });

  it("estimates tokens by rounding chars up to the nearest token", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(4000)).toBe(1000);
  });

  it("estimates cost from input + output tokens using the split model", () => {
    // 1000 input tokens @ 0.025 + 1000 output tokens @ 0.125 = 0.15 cents
    expect(estimateCostCents(1000, 1000)).toBeCloseTo(0.15, 10);
    // input-only: 2000 tokens @ 0.025 = 0.05 cents
    expect(estimateCostCents(2000, 0)).toBeCloseTo(0.05, 10);
    // output-only: 2000 tokens @ 0.125 = 0.25 cents
    expect(estimateCostCents(0, 2000)).toBeCloseTo(0.25, 10);
    expect(estimateCostCents(0, 0)).toBe(0);
  });

  it("estimates cost from raw char counts by converting to tokens first", () => {
    // 4000 input chars -> 1000 tokens @ 0.025 = 0.025
    // 4000 output chars -> 1000 tokens @ 0.125 = 0.125
    expect(estimateCostCentsFromChars(4000, 4000)).toBeCloseTo(0.15, 10);
    // char->token rounding: 5 chars -> 2 tokens on each side
    const expected =
      (2 / 1000) * INPUT_COST_PER_1K_CENTS +
      (2 / 1000) * OUTPUT_COST_PER_1K_CENTS;
    expect(estimateCostCentsFromChars(5, 5)).toBeCloseTo(expected, 12);
  });
});
