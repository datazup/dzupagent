import { describe, expect, it } from "vitest";
import type { Measurable } from "../eval-types.js";

/**
 * `Measurable` exists so the vacuity flag has ONE definition.
 *
 * The same defect — a scorer with nothing to check returning its top score, and
 * a consumer counting that as a clean pass — was fixed independently in
 * @dzupagent/evals and @dzupagent/subagents. Both are layer 2 with
 * `allowSameLayerEdges: false`, so the second copy was written by hand from the
 * first with nothing to keep them honest.
 *
 * These tests pin the two properties consumers actually depend on: that the
 * flag is OPTIONAL (so "omitted means measured" holds and existing producers
 * stay valid), and that `measured !== false` is the correct consumer filter.
 */
describe("Measurable", () => {
  it("treats an omitted flag as measured", () => {
    // The common case: a producer that always checks something says nothing.
    const result: Measurable = {};

    expect(result.measured).toBeUndefined();
    // The documented consumer rule. `measured === true` would wrongly drop
    // every result that simply omitted the flag.
    expect(result.measured !== false).toBe(true);
  });

  it("lets a producer explicitly declare it measured nothing", () => {
    const vacuous: Measurable = { measured: false };

    expect(vacuous.measured !== false).toBe(false);
  });

  it("filters vacuous entries out of an aggregate", () => {
    // The shape every consumer of this contract implements: exclude unmeasured
    // rows, then require at least one survivor before reporting a result.
    const rows: Array<Measurable & { score: number }> = [
      { score: 0 },
      { score: 1, measured: false },
    ];

    const measured = rows.filter((r) => r.measured !== false);
    const aggregate =
      measured.length === 0
        ? 0
        : measured.reduce((s, r) => s + r.score, 0) / measured.length;

    expect(measured).toHaveLength(1);
    // Averaging the vacuous 1.0 in would report 0.5 for a set whose only real
    // measurement scored 0.
    expect(aggregate).toBe(0);
  });
});
