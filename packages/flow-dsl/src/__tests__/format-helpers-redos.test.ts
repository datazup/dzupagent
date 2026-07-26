/**
 * Regression guard for a real ReDoS in `quote()`'s YAML-typed-scalar check.
 *
 * The original pattern used `(?:\d+\.?\d*|\.\d+)`. There `\d+` and `\d*` sit
 * adjacent with only an optional `.` between them, so an all-digit run can be
 * split between them many ways. On a near-miss — a long digit run followed by
 * one character that fails the anchor — the engine walked every split before
 * giving up. Measured QUADRATIC: 5k chars 36ms, 10k 144ms, 20k 617ms, 40k
 * 2,514ms (~4.0x per doubling).
 *
 * `quote()` is applied to author-supplied flow content, so that input is
 * reachable. The fix made the alternatives mutually exclusive
 * (`(?:\d+(?:\.\d*)?|\.\d+)`): the first branch requires a leading digit and
 * the second a leading `.`, so at most one can apply and nothing backtracks.
 * The accepted language is unchanged — verified by differential-testing the old
 * and new patterns over 9,261 generated strings with 0 mismatches.
 *
 * These tests pin BOTH properties, because either alone is insufficient: the
 * timing test alone would pass for a regex that rejects everything, and the
 * grammar tests alone would pass for the original quadratic pattern.
 *
 * ## The adversarial input MUST end in `-`, not an arbitrary invalid character
 *
 * `quote()` gates on `/^[A-Za-z0-9_.\/:-]+$/` BEFORE consulting the scalar
 * pattern. A probe ending in `!` therefore fails the cheap gate and the
 * expensive regex is never reached — a first draft of this test used `!` and
 * was VACUOUS: it passed against the old quadratic pattern in ~1ms.
 *
 * `-` is the useful choice because it is inside the gate's class yet fatal to
 * the number branch, so the input reaches the scalar pattern and forces the
 * full near-miss walk. Verified through the public `quote()` API: at 20k chars
 * the old pattern took 1,887ms and the new one 0.07ms. If you change this
 * input, re-confirm the test still FAILS against the old pattern.
 */

import { describe, expect, it } from "vitest";

import { quote } from "../format-nodes/format-helpers.js";

describe("quote() ReDoS regression", () => {
  it("stays fast on the adversarial all-digit near-miss", () => {
    // 40k chars took 2,514ms before the fix and ~0.2ms after. A 2s budget is
    // ~10x the pre-fix figure's order of magnitude below it while staying far
    // above any plausible linear runtime, so this fails loudly on a
    // reintroduced quadratic without flaking on a loaded CI box.
    const adversarial = `${"9".repeat(40_000)}-`;

    const started = performance.now();
    quote(adversarial);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
  });

  it("scales sub-quadratically as the input doubles", () => {
    const timeFor = (len: number): number => {
      const input = `${"9".repeat(len)}-`;
      const started = performance.now();
      quote(input);
      return performance.now() - started;
    };

    // Warm up so JIT compilation is not attributed to the first measurement.
    timeFor(1_000);

    const small = Math.max(timeFor(10_000), 0.01);
    const large = timeFor(40_000);

    // 4x the input. Linear predicts ~4x time; the old quadratic pattern grew
    // ~16x across this range. 10x sits well clear of both.
    expect(large / small).toBeLessThan(10);
  });

  it("still leaves YAML-typed scalars quoted", () => {
    // These must be quoted, otherwise a YAML consumer would reparse them as
    // non-strings. Guards against "fixing" the perf by weakening the pattern.
    for (const value of [
      "1",
      "1.",
      "1.5",
      ".5",
      "+1.5e-3",
      "1e10",
      "-0.0",
      "~",
      "null",
      "true",
      "TRUE",
      "yes",
      "off",
    ]) {
      expect(quote(value)).toBe(JSON.stringify(value));
    }
  });

  it("still leaves plain identifiers unquoted", () => {
    for (const value of ["abc", "1.2.3", "a-b_c", "path/to:thing"]) {
      expect(quote(value)).toBe(value);
    }
  });
});
