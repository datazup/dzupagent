/**
 * Gap-filling tests for merge-strategies.ts.
 * Covers isMergeStrategyName (type-guard) and concatMerge separator detail.
 */
import { describe, it, expect } from "vitest";
import {
  isMergeStrategyName,
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
} from "../merge-strategies.js";

describe("isMergeStrategyName", () => {
  it("returns true for all known strategy names", () => {
    expect(isMergeStrategyName("concat")).toBe(true);
    expect(isMergeStrategyName("vote")).toBe(true);
    expect(isMergeStrategyName("numbered")).toBe(true);
    expect(isMergeStrategyName("json")).toBe(true);
  });

  it("returns false for unknown names", () => {
    expect(isMergeStrategyName("unknown")).toBe(false);
    expect(isMergeStrategyName("")).toBe(false);
    expect(isMergeStrategyName("CONCAT")).toBe(false);
  });

  it("returns false for prototype-pollution probes", () => {
    expect(isMergeStrategyName("constructor")).toBe(false);
    expect(isMergeStrategyName("__proto__")).toBe(false);
    expect(isMergeStrategyName("hasOwnProperty")).toBe(false);
  });
});

describe("concatMerge separator detail", () => {
  it("uses exactly '\\n\\n---\\n\\n' as separator between items", () => {
    const result = concatMerge(["a", "b"]);
    expect(result).toBe("a\n\n---\n\nb");
  });

  it("does not add a trailing separator", () => {
    const result = concatMerge(["x", "y", "z"]);
    expect(result.endsWith("z")).toBe(true);
    expect(result.startsWith("x")).toBe(true);
  });
});

describe("voteMerge strict majority", () => {
  it("returns the winner when one value has strict majority", () => {
    expect(voteMerge(["a", "a", "b"])).toBe("a");
  });

  it("handles all-identical inputs", () => {
    expect(voteMerge(["x", "x", "x"])).toBe("x");
  });
});

describe("numberedMerge index correctness", () => {
  it("uses 1-based indices", () => {
    const result = numberedMerge(["alpha", "beta"]);
    expect(result.startsWith("1.")).toBe(true);
    expect(result).toContain("2.");
  });
});

describe("jsonArrayMerge round-trip", () => {
  it("preserves insertion order in the parsed array", () => {
    const parsed = JSON.parse(jsonArrayMerge(["c", "a", "b"]));
    expect(parsed).toEqual(["c", "a", "b"]);
  });
});
