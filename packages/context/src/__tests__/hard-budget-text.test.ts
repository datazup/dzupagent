import { describe, it, expect } from "vitest";
import { fitTextToHardBudget } from "../hard-budget-text.js";
import type { TokenMeasurementResult } from "../token-lifecycle.js";

/**
 * Coverage for fitTextToHardBudget (DZUPAGENT-TEST-C-15 floor work).
 *
 * The module is the hard-ceiling fitter: it must never return an adoptable
 * payload it cannot prove fits. The branches that matter are the refusals —
 * heuristic measurement at each of the three measure() sites, a marker that
 * cannot be reserved, and the non-monotonic-encoding fallback — because each
 * one is a path where returning `text` instead of `null` would silently
 * breach the budget the caller believes is enforced.
 */

/** Tokenizer-backed measurement: 1 token per 4 chars, matching the real ratio. */
const exact = (text: string): TokenMeasurementResult => ({
  tokens: Math.ceil(text.length / 4),
  method: "exact",
  model: "test-model",
});

/** A measurement the fitter must refuse to enforce a hard budget against. */
const heuristic = (reason?: string) => (): TokenMeasurementResult => ({
  tokens: 1,
  method: "heuristic",
  ...(reason ? { reason } : {}),
});

describe("fitTextToHardBudget — required prefix invariant", () => {
  it("throws when the text does not start with its required prefix", () => {
    expect(() =>
      fitTextToHardBudget({
        text: "body only",
        tokenBudget: 100,
        marker: "…",
        requiredPrefix: "ID: ",
        measure: exact,
        operation: "test-op",
      })
    ).toThrow(/does not start with its required prefix/);
  });

  it("accepts text when the required prefix is absent (defaults to empty)", () => {
    const result = fitTextToHardBudget({
      text: "short",
      tokenBudget: 100,
      marker: "…",
      measure: exact,
      operation: "test-op",
    });
    expect(result.text).toBe("short");
  });
});

describe("fitTextToHardBudget — text already within budget", () => {
  it("returns the text untouched and reports no truncation", () => {
    const result = fitTextToHardBudget({
      text: "four",
      tokenBudget: 50,
      marker: "…",
      measure: exact,
      operation: "test-op",
    });
    expect(result.text).toBe("four");
    expect(result.hardBudget).toMatchObject({
      limit: 50,
      satisfied: true,
      adoptionSafe: true,
      truncated: false,
      markerIncluded: false,
    });
    expect(result.degradation).toBeUndefined();
  });

  it("treats encoding-fallback as tokenizer-backed, not heuristic", () => {
    const result = fitTextToHardBudget({
      text: "four",
      tokenBudget: 50,
      marker: "…",
      measure: (text) => ({
        tokens: Math.ceil(text.length / 4),
        method: "encoding-fallback",
      }),
      operation: "test-op",
    });
    expect(result.text).toBe("four");
    expect(result.hardBudget.adoptionSafe).toBe(true);
  });
});

describe("fitTextToHardBudget — heuristic measurement is refused", () => {
  it("refuses adoption when the initial measurement is heuristic", () => {
    const result = fitTextToHardBudget({
      text: "anything",
      tokenBudget: 10,
      marker: "…",
      measure: heuristic("no tokenizer available"),
      operation: "test-op",
    });
    expect(result.text).toBeNull();
    expect(result.hardBudget.adoptionSafe).toBe(false);
    expect(result.hardBudget.satisfied).toBe(false);
    expect(result.degradation).toMatchObject({
      stage: "token-measurement",
      adoptionSafe: false,
      reason: "no tokenizer available",
    });
  });

  it("falls back to a synthesised reason when the measurement supplies none", () => {
    const result = fitTextToHardBudget({
      text: "anything",
      tokenBudget: 10,
      marker: "…",
      measure: heuristic(),
      operation: "summarise",
    });
    expect(result.degradation?.reason).toBe(
      "summarise measurement is heuristic"
    );
  });

  it("refuses when only the marker measurement is heuristic", () => {
    // First measure() is exact and over budget; the reserved-text measure is
    // heuristic, so the marker branch is the one that must refuse.
    const result = fitTextToHardBudget({
      text: "x".repeat(400),
      tokenBudget: 5,
      marker: "[cut]",
      measure: (text) =>
        text.includes("[cut]") && text.length < 100
          ? { tokens: 1, method: "heuristic" }
          : exact(text),
      operation: "summarise",
    });
    expect(result.text).toBeNull();
    expect(result.degradation).toMatchObject({ stage: "token-measurement" });
    expect(result.degradation?.reason).toBe(
      "summarise marker measurement is heuristic"
    );
  });

  it("refuses when a mid-search trim measurement goes heuristic", () => {
    let calls = 0;
    const result = fitTextToHardBudget({
      text: "x".repeat(400),
      tokenBudget: 20,
      marker: "[cut]",
      measure: (text) => {
        calls += 1;
        // Let the initial and reserved measurements through, then degrade
        // once the binary search starts probing candidates.
        return calls > 2 ? { tokens: 1, method: "heuristic" } : exact(text);
      },
      operation: "summarise",
    });
    expect(result.text).toBeNull();
    expect(result.degradation?.reason).toBe(
      "summarise trim measurement is heuristic"
    );
  });
});

describe("fitTextToHardBudget — marker cannot be reserved", () => {
  it("refuses when the prefix plus marker alone exceeds the budget", () => {
    const result = fitTextToHardBudget({
      text: "ID-1234: " + "x".repeat(400),
      tokenBudget: 2,
      marker: "[truncated for budget]",
      requiredPrefix: "ID-1234: ",
      measure: exact,
      operation: "summarise",
    });
    expect(result.text).toBeNull();
    expect(result.hardBudget).toMatchObject({
      satisfied: false,
      adoptionSafe: false,
      markerIncluded: false,
    });
    expect(result.degradation?.stage).toBe("hard-budget-marker");
    expect(result.degradation?.reason).toMatch(
      /cannot reserve the \d+-token identity and truncation marker/
    );
  });
});

describe("fitTextToHardBudget — truncation", () => {
  it("trims to fit while keeping the prefix and a complete marker", () => {
    const budget = 20;
    const result = fitTextToHardBudget({
      text: "ID-1234: " + "y".repeat(400),
      tokenBudget: budget,
      marker: "[cut]",
      requiredPrefix: "ID-1234: ",
      measure: exact,
      operation: "summarise",
    });
    expect(result.text).not.toBeNull();
    expect(result.text?.startsWith("ID-1234: ")).toBe(true);
    expect(result.text?.endsWith("[cut]")).toBe(true);
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    });
    // The whole point of the module: the result actually fits.
    expect(exact(result.text as string).tokens).toBeLessThanOrEqual(budget);
  });

  it("falls back to prefix+marker when the encoding is non-monotonic", () => {
    // A measure() that reports every trimmed candidate as over budget drives
    // the search to low=0, so the proven reserved text is the only safe answer.
    const marker = "[cut]";
    const prefix = "ID: ";
    const result = fitTextToHardBudget({
      text: prefix + "z".repeat(400),
      tokenBudget: 10,
      marker,
      requiredPrefix: prefix,
      measure: (text) =>
        text === prefix + marker
          ? { tokens: 3, method: "exact" }
          : { tokens: 999, method: "exact" },
      operation: "summarise",
    });
    expect(result.text).toBe(prefix + marker);
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    });
    expect(result.tokenMeasurement.tokens).toBe(3);
  });

  it("falls back to the reserved measurement when the final re-measured candidate still exceeds budget", () => {
    // The binary search converges to low=0 (every non-empty trimmed
    // candidate reports over budget), so the "final candidate" the search
    // settles on is textually identical to prefix+marker — but this
    // measure() reports a *different*, over-budget token count the first
    // time prefix+marker is measured (line 92's reserved-measurement check,
    // which the search needs to pass to even start) versus the second time
    // the identical string is re-measured as the search's final candidate
    // (line 131). This models a genuinely non-monotonic/non-deterministic
    // encoding where re-measuring identical text can disagree — the exact
    // scenario the trailing fallback exists to survive without adopting an
    // unproven payload.
    const marker = "[cut]";
    const prefix = "ID: ";
    const reservedText = prefix + marker;
    let reservedMeasureCalls = 0;
    const result = fitTextToHardBudget({
      text: prefix + "z".repeat(400),
      tokenBudget: 10,
      marker,
      requiredPrefix: prefix,
      measure: (text) => {
        if (text === reservedText) {
          reservedMeasureCalls += 1;
          // First call (the dedicated reserved-measurement gate) reports a
          // safe, in-budget count; every later call for the same string
          // (the final re-measured candidate) reports over budget.
          return reservedMeasureCalls === 1
            ? { tokens: 3, method: "exact" }
            : { tokens: 999, method: "exact" };
        }
        return { tokens: 999, method: "exact" };
      },
      operation: "summarise",
    });

    expect(result.text).toBe(reservedText);
    expect(result.hardBudget).toMatchObject({
      satisfied: true,
      adoptionSafe: true,
      truncated: true,
      markerIncluded: true,
    });
    // The returned measurement must be the *reserved* one (tokens: 3, from
    // the gate that already proved it fits), not the over-budget
    // re-measurement — proves the fallback uses reservedMeasurement rather
    // than trusting the final candidate's own (possibly stale) reading.
    expect(result.tokenMeasurement.tokens).toBe(3);
  });
});
