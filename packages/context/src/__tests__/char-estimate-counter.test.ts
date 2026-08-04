import { describe, expect, it } from "vitest";
import { CharEstimateCounter } from "../char-estimate-counter.js";

/**
 * No test file previously existed for this counter, despite it being the
 * TokenCounter fallback used throughout the package when no tokenizer is
 * injected — `count()` in particular was never called by any test (only
 * `countDetailed()` was exercised indirectly through other modules), so a
 * regression that desynced the two (e.g. `count()` returning a different
 * value than `countDetailed().tokens`) would have gone unnoticed.
 */
describe("CharEstimateCounter", () => {
  const counter = new CharEstimateCounter();

  describe("count()", () => {
    it("estimates ceil(length / 4) tokens for ASCII text", () => {
      expect(counter.count("12345678")).toBe(2); // 8 chars / 4 = 2
      expect(counter.count("123456789")).toBe(3); // 9 chars / 4 -> ceil = 3
    });

    it("returns 0 for an empty string", () => {
      expect(counter.count("")).toBe(0);
    });

    it("stays in sync with countDetailed().tokens for the same input", () => {
      const text =
        "a fairly ordinary sentence with some punctuation, and more.";
      expect(counter.count(text)).toBe(counter.countDetailed(text).tokens);
    });
  });

  describe("countDetailed()", () => {
    it('reports method "heuristic" with a fixed reason', () => {
      const result = counter.countDetailed("hello world");
      expect(result.method).toBe("heuristic");
      expect(result.reason).toBe("chars-per-token estimate");
    });

    it("omits the model field when no model is passed", () => {
      const result = counter.countDetailed("hello world");
      expect(result.model).toBeUndefined();
    });

    it("includes the model field when a model is passed", () => {
      const result = counter.countDetailed("hello world", "gpt-4o");
      expect(result.model).toBe("gpt-4o");
    });

    it("rounds up fractional token counts rather than truncating", () => {
      // 5 chars / 4 = 1.25 -> ceil = 2, not floor = 1.
      expect(counter.countDetailed("12345").tokens).toBe(2);
    });
  });
});
