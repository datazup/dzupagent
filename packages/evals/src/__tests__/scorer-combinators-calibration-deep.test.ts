/**
 * W28-B — Scorer combinators + calibration pipeline deep coverage
 *
 * Covers:
 *  - CompositeScorer as a combinator: all-pass, partial-pass, all-fail, weight extremes
 *  - ScorerRegistry as a factory/combinator: create, re-register, unregister, error paths
 *  - Enhanced deterministic scorers (keyword, latency, cost, JSON-schema): edge cases
 *  - EvidenceQualityScorer / computeEvidenceQuality: calibration-like scenarios
 *  - Scorer metadata / config contracts
 *  - Score aggregation utilities: mean, weighted sums, edge cases
 *  - Error propagation: scorer throws, partial failure
 *  - Type-guard patterns through the ScorerResult shape
 */

import { describe, it, expect, vi } from "vitest";
import { CompositeScorer } from "../composite-scorer.js";
import {
  ScorerRegistry,
  defaultScorerRegistry,
} from "../scorers/scorer-registry.js";
import {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from "../scorers/deterministic-enhanced.js";
import {
  EvidenceQualityScorer,
  computeEvidenceQuality,
} from "../scorers/evidence-quality-scorer.js";
import { DeterministicScorer } from "../deterministic-scorer.js";
import {
  STANDARD_CRITERIA,
  CODE_CRITERIA,
  FIVE_POINT_RUBRIC,
  TEN_POINT_RUBRIC,
} from "../scorers/criteria.js";
import type { EvalScorer, EvalResult } from "../types.js";
import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvalScorer(name: string, score: number): EvalScorer {
  return {
    name,
    score: vi.fn().mockResolvedValue({
      score,
      pass: score >= 0.5,
      reasoning: `${name} returned ${score}`,
    } satisfies EvalResult),
  };
}

function makeThrowingEvalScorer(name: string): EvalScorer {
  return {
    name,
    score: vi.fn().mockRejectedValue(new Error(`${name} exploded`)),
  };
}

function makeEnhancedScorer(id: string, score: number): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: "custom" };
  return {
    config,
    score: vi.fn().mockResolvedValue({
      scorerId: id,
      scores: [{ criterion: "test", score, reasoning: `fixed ${score}` }],
      aggregateScore: score,
      passed: score >= 0.5,
      durationMs: 0,
    } satisfies ScorerResult),
  };
}

const makeEvalInput = (
  output: string,
  extra?: Partial<EvalInput>
): EvalInput => ({
  input: "test-input",
  output,
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. CompositeScorer combinators — deep coverage
// ---------------------------------------------------------------------------

describe("CompositeScorer combinators (deep)", () => {
  describe("all-pass combinations", () => {
    it("both scorers pass → composite passes at 1.0", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 1.0), weight: 1 },
          { scorer: makeEvalScorer("b", 1.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(1.0);
      expect(r.pass).toBe(true);
    });

    it("all-1.0 with three scorers and unequal weights → still 1.0", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 1.0), weight: 10 },
          { scorer: makeEvalScorer("b", 1.0), weight: 1 },
          { scorer: makeEvalScorer("c", 1.0), weight: 5 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(1.0);
      expect(r.pass).toBe(true);
    });

    it("all-1.0 single scorer → score is exactly 1.0", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: makeEvalScorer("only", 1.0), weight: 7 }],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(1.0);
    });
  });

  describe("all-fail combinations", () => {
    it("both scorers fail at 0.0 → composite score is 0.0, fails", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 0.0), weight: 1 },
          { scorer: makeEvalScorer("b", 0.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.0);
      expect(r.pass).toBe(false);
    });

    it("all-0.0 with four scorers → score is 0.0", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 0), weight: 3 },
          { scorer: makeEvalScorer("b", 0), weight: 2 },
          { scorer: makeEvalScorer("c", 0), weight: 1 },
          { scorer: makeEvalScorer("d", 0), weight: 9 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.0);
      expect(r.pass).toBe(false);
    });
  });

  describe("partial-pass (a fails, b passes)", () => {
    it("first scorer 0.0, second 1.0 with equal weights → 0.5, passes", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("fail", 0.0), weight: 1 },
          { scorer: makeEvalScorer("pass", 1.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.5);
      expect(r.pass).toBe(true); // 0.5 >= 0.5 → passes
    });

    it("weighted: first 0.0 w=3, second 1.0 w=1 → 0.25 → fails", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("heavy-fail", 0.0), weight: 3 },
          { scorer: makeEvalScorer("light-pass", 1.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.25);
      expect(r.pass).toBe(false);
    });

    it("weighted: first 1.0 w=9, second 0.0 w=1 → 0.9 → passes", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("dominant-pass", 1.0), weight: 9 },
          { scorer: makeEvalScorer("minor-fail", 0.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.9);
      expect(r.pass).toBe(true);
    });
  });

  describe("threshold at boundary", () => {
    it("score exactly 0.5 → pass is true", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: makeEvalScorer("a", 0.5), weight: 1 }],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.5);
      expect(r.pass).toBe(true);
    });

    it("score 0.499 → pass is false", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: makeEvalScorer("just-below", 0.499), weight: 1 }],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.499);
      expect(r.pass).toBe(false);
    });
  });

  describe("weight edge cases", () => {
    it("total weight zero → score 0, reasoning mentions it", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 1.0), weight: 0 },
          { scorer: makeEvalScorer("b", 1.0), weight: 0 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.reasoning).toContain("zero");
    });

    it("fractional weights work the same as integer weights (0.4 / 0.6)", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 1.0), weight: 0.4 },
          { scorer: makeEvalScorer("b", 0.0), weight: 0.6 },
        ],
      });
      const r = await c.score("in", "out");
      // (1.0*0.4 + 0.0*0.6) / 1.0 = 0.4
      expect(r.score).toBeCloseTo(0.4);
    });

    it("very large weights still normalize correctly", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("a", 1.0), weight: 1_000_000 },
          { scorer: makeEvalScorer("b", 0.0), weight: 1_000_000 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.5);
    });
  });

  describe("metadata shape", () => {
    it("metadata.scorerResults has correct length", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("x", 0.7), weight: 1 },
          { scorer: makeEvalScorer("y", 0.3), weight: 2 },
          { scorer: makeEvalScorer("z", 0.5), weight: 3 },
        ],
      });
      const r = await c.score("in", "out");
      const meta = r.metadata as { scorerResults: unknown[] } | undefined;
      expect(meta?.scorerResults).toHaveLength(3);
    });

    it("each scorerResult entry has scorerName, score, weight, normalizedWeight", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: makeEvalScorer("alpha", 0.8), weight: 4 },
          { scorer: makeEvalScorer("beta", 0.2), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      const meta = r.metadata as {
        scorerResults: Array<{
          scorerName: string;
          score: number;
          weight: number;
          normalizedWeight: number;
        }>;
      };
      const first = meta.scorerResults[0]!;
      expect(first.scorerName).toBe("alpha");
      expect(first.score).toBeCloseTo(0.8);
      expect(first.weight).toBe(4);
      expect(first.normalizedWeight).toBeCloseTo(0.8); // 4/(4+1)
      const second = meta.scorerResults[1]!;
      expect(second.normalizedWeight).toBeCloseTo(0.2);
    });
  });

  describe("name / custom name", () => {
    it('defaults to "composite"', () => {
      const c = new CompositeScorer({ scorers: [] });
      expect(c.name).toBe("composite");
    });

    it("honours custom name", () => {
      const c = new CompositeScorer({ scorers: [], name: "my-combo" });
      expect(c.name).toBe("my-combo");
    });

    it("custom name appears in reasoning", async () => {
      const c = new CompositeScorer({
        name: "pipeline",
        scorers: [{ scorer: makeEvalScorer("inner", 0.9), weight: 1 }],
      });
      // name is on the instance; reasoning contains sub-scorer name
      const r = await c.score("in", "out");
      expect(r.reasoning).toContain("inner");
    });
  });

  describe("reference propagation", () => {
    it("passes reference through to sub-scorers", async () => {
      const calls: Array<[string, string, string | undefined]> = [];
      const spy: EvalScorer = {
        name: "spy",
        score: async (input, output, ref) => {
          calls.push([input, output, ref]);
          return { score: 1.0, pass: true, reasoning: "ok" };
        },
      };
      const c = new CompositeScorer({ scorers: [{ scorer: spy, weight: 1 }] });
      await c.score("my-input", "my-output", "my-reference");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["my-input", "my-output", "my-reference"]);
    });

    it("passes undefined reference when not provided", async () => {
      let capturedRef: string | undefined = "SENTINEL";
      const spy: EvalScorer = {
        name: "spy",
        score: async (_i, _o, ref) => {
          capturedRef = ref;
          return { score: 1.0, pass: true, reasoning: "ok" };
        },
      };
      const c = new CompositeScorer({ scorers: [{ scorer: spy, weight: 1 }] });
      await c.score("i", "o");
      expect(capturedRef).toBeUndefined();
    });
  });

  describe("empty array", () => {
    it("empty scorers → score 0, pass false, reasoning mentions no scorers", async () => {
      const c = new CompositeScorer({ scorers: [] });
      const r = await c.score("in", "out");
      expect(r.score).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.reasoning).toContain("No scorers");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. ScorerRegistry — combinator/factory deep coverage
// ---------------------------------------------------------------------------

describe("ScorerRegistry (combinator factory deep)", () => {
  describe("built-in set", () => {
    it("has exactly 4 built-in types", () => {
      const r = new ScorerRegistry();
      expect(r.list().length).toBe(4);
    });

    it("has evidence_quality built-in", () => {
      const r = new ScorerRegistry();
      expect(r.has("evidence_quality")).toBe(true);
    });

    it("list() entries each have a non-empty description", () => {
      const r = new ScorerRegistry();
      for (const entry of r.list()) {
        expect(entry.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("create() — exact-match edge cases", () => {
    it("exact-match with reference undefined → aggregateScore 0, not passed", async () => {
      const r = new ScorerRegistry();
      const s = r.create("exact-match");
      const result = await s.score(makeEvalInput("hello"));
      expect(result.aggregateScore).toBe(0);
      expect(result.passed).toBe(false);
    });

    it("exact-match same value → 1.0, passed", async () => {
      const r = new ScorerRegistry();
      const s = r.create("exact-match");
      const result = await s.score(makeEvalInput("x", { reference: "x" }));
      expect(result.aggregateScore).toBe(1.0);
      expect(result.passed).toBe(true);
    });

    it("exact-match different case → 0.0 (case-sensitive)", async () => {
      const r = new ScorerRegistry();
      const s = r.create("exact-match");
      const result = await s.score(
        makeEvalInput("Hello", { reference: "hello" })
      );
      expect(result.aggregateScore).toBe(0.0);
    });

    it('result has scorerId = "exact-match"', async () => {
      const r = new ScorerRegistry();
      const s = r.create("exact-match");
      const result = await s.score(makeEvalInput("a", { reference: "a" }));
      expect(result.scorerId).toBe("exact-match");
    });
  });

  describe("create() — contains edge cases", () => {
    it("contains: substring at start", async () => {
      const r = new ScorerRegistry();
      const s = r.create("contains");
      const result = await s.score(
        makeEvalInput("hello world", { reference: "hello" })
      );
      expect(result.aggregateScore).toBe(1.0);
    });

    it("contains: substring at end", async () => {
      const r = new ScorerRegistry();
      const s = r.create("contains");
      const result = await s.score(
        makeEvalInput("hello world", { reference: "world" })
      );
      expect(result.aggregateScore).toBe(1.0);
    });

    it("contains: empty reference string → always found", async () => {
      const r = new ScorerRegistry();
      const s = r.create("contains");
      const result = await s.score(
        makeEvalInput("anything", { reference: "" })
      );
      expect(result.aggregateScore).toBe(1.0);
    });
  });

  describe("custom scorer registration patterns", () => {
    it("custom scorer with opts dependency", async () => {
      const registry = new ScorerRegistry();
      registry.register(
        "length-check",
        "Checks output length against options.maxLen",
        (deps) => {
          const maxLen = (deps.options?.["maxLen"] as number) ?? 100;
          const config: ScorerConfig = {
            id: "length-check",
            name: "length-check",
            type: "custom",
          };
          return {
            config,
            async score(input: EvalInput): Promise<ScorerResult> {
              const ok = input.output.length <= maxLen;
              return {
                scorerId: "length-check",
                scores: [
                  {
                    criterion: "length",
                    score: ok ? 1 : 0,
                    reasoning: `len=${input.output.length}`,
                  },
                ],
                aggregateScore: ok ? 1 : 0,
                passed: ok,
                durationMs: 0,
              };
            },
          };
        }
      );

      const s = registry.create("length-check", { options: { maxLen: 5 } });
      const pass = await s.score(makeEvalInput("hi"));
      const fail = await s.score(makeEvalInput("this is too long"));
      expect(pass.passed).toBe(true);
      expect(fail.passed).toBe(false);
    });

    it("registering duplicate type overwrites and list length stays the same", () => {
      const registry = new ScorerRegistry();
      const beforeLen = registry.list().length;
      registry.register("exact-match", "overwritten", (_) =>
        makeEnhancedScorer("exact-match", 0.5)
      );
      expect(registry.list().length).toBe(beforeLen);
    });

    it("registering new type increments list length", () => {
      const registry = new ScorerRegistry();
      const beforeLen = registry.list().length;
      registry.register("custom-new", "desc", (_) =>
        makeEnhancedScorer("custom-new", 0.7)
      );
      expect(registry.list().length).toBe(beforeLen + 1);
    });
  });

  describe("error paths", () => {
    it("throws with the unknown type in the message", () => {
      const r = new ScorerRegistry();
      expect(() => r.create("does-not-exist")).toThrow(/does-not-exist/);
    });

    it("throws and lists available types", () => {
      const r = new ScorerRegistry();
      expect(() => r.create("nope")).toThrow(/exact-match/);
    });

    it("after unregister, create throws", () => {
      const r = new ScorerRegistry();
      r.unregister("contains");
      expect(() => r.create("contains")).toThrow(/contains/);
    });
  });

  describe("unregister", () => {
    it("unregister returns true for existing", () => {
      const r = new ScorerRegistry();
      expect(r.unregister("contains")).toBe(true);
    });

    it("unregister returns false for non-existing", () => {
      const r = new ScorerRegistry();
      expect(r.unregister("ghost")).toBe(false);
    });

    it("can re-register a previously unregistered type", async () => {
      const r = new ScorerRegistry();
      r.unregister("contains");
      r.register("contains", "custom contains", (_) =>
        makeEnhancedScorer("contains", 0.99)
      );
      const s = r.create("contains");
      const result = await s.score(makeEvalInput("test"));
      expect(result.aggregateScore).toBeCloseTo(0.99);
    });
  });

  describe("defaultScorerRegistry singleton", () => {
    it("is shared and has all built-in types", () => {
      expect(defaultScorerRegistry.has("exact-match")).toBe(true);
      expect(defaultScorerRegistry.has("contains")).toBe(true);
      expect(defaultScorerRegistry.has("llm-judge")).toBe(true);
      expect(defaultScorerRegistry.has("evidence_quality")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Keyword scorer deep coverage (combinator-like multi-criterion)
// ---------------------------------------------------------------------------

describe("createKeywordScorer (multi-criterion combinator)", () => {
  it("no keywords configured → aggregateScore 1.0 (nothing to fail)", async () => {
    const s = createKeywordScorer({});
    const r = await s.score(makeEvalInput("anything"));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("all required present → 1.0", async () => {
    const s = createKeywordScorer({ required: ["foo", "bar"] });
    const r = await s.score(makeEvalInput("foo bar baz"));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("one required missing → partial score", async () => {
    const s = createKeywordScorer({ required: ["foo", "missing"] });
    const r = await s.score(makeEvalInput("foo only"));
    expect(r.aggregateScore).toBeCloseTo(0.5); // 1/2 criteria pass
    expect(r.passed).toBe(false);
  });

  it("all required missing → 0.0", async () => {
    const s = createKeywordScorer({ required: ["x", "y", "z"] });
    const r = await s.score(makeEvalInput("no match at all"));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("all forbidden absent → 1.0", async () => {
    const s = createKeywordScorer({ forbidden: ["bad", "evil"] });
    const r = await s.score(makeEvalInput("clean output"));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("one forbidden present → partial score", async () => {
    const s = createKeywordScorer({ forbidden: ["bad", "evil"] });
    const r = await s.score(makeEvalInput("this is bad"));
    // forbidden:bad fails, forbidden:evil passes → 1/2
    expect(r.aggregateScore).toBeCloseTo(0.5);
    expect(r.passed).toBe(false);
  });

  it("all forbidden present → 0.0", async () => {
    const s = createKeywordScorer({ forbidden: ["spam", "junk"] });
    const r = await s.score(makeEvalInput("spam and junk"));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("mixed required and forbidden — perfect case", async () => {
    const s = createKeywordScorer({ required: ["good"], forbidden: ["bad"] });
    const r = await s.score(makeEvalInput("this is good"));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
    expect(r.scores).toHaveLength(2);
  });

  it("mixed required and forbidden — both fail → 0.0", async () => {
    const s = createKeywordScorer({ required: ["good"], forbidden: ["bad"] });
    const r = await s.score(makeEvalInput("this is bad"));
    // required:good missing (0), forbidden:bad present (0) → 0/2 = 0
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("case-insensitive: required keyword found in uppercase output", async () => {
    const s = createKeywordScorer({
      required: ["hello"],
      caseSensitive: false,
    });
    const r = await s.score(makeEvalInput("HELLO WORLD"));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("case-sensitive: required keyword not found in uppercase output", async () => {
    const s = createKeywordScorer({ required: ["hello"], caseSensitive: true });
    const r = await s.score(makeEvalInput("HELLO WORLD"));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("scores array length equals required.length + forbidden.length", async () => {
    const s = createKeywordScorer({
      required: ["a", "b"],
      forbidden: ["x", "y", "z"],
    });
    const r = await s.score(makeEvalInput("a b"));
    expect(r.scores).toHaveLength(5);
  });

  it("uses custom id when provided", () => {
    const s = createKeywordScorer({ id: "my-keyword", required: ["test"] });
    expect(s.config.id).toBe("my-keyword");
  });

  it("config.type is deterministic", () => {
    const s = createKeywordScorer({ required: ["x"] });
    expect(s.config.type).toBe("deterministic");
  });

  it('config.name is "keyword"', () => {
    const s = createKeywordScorer({ required: [] });
    expect(s.config.name).toBe("keyword");
  });
});

// ---------------------------------------------------------------------------
// 4. Latency scorer — calibration-like score distribution
// ---------------------------------------------------------------------------

describe("createLatencyScorer (calibration pipeline)", () => {
  it("latency at target → 1.0", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 100 }));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("latency below target → 1.0", async () => {
    const s = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 50 }));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("latency at max → 0.0", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 500 }));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("latency above max → 0.0", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 9000 }));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("latency at midpoint → ~0.5", async () => {
    const s = createLatencyScorer({ targetMs: 0, maxMs: 1000 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 500 }));
    expect(r.aggregateScore).toBeCloseTo(0.5);
  });

  it("missing latencyMs defaults to 0 → score is 1.0", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out"));
    expect(r.aggregateScore).toBe(1.0);
  });

  it("score linearly decreases from target to max", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 600 });
    const r300 = await s.score(makeEvalInput("out", { latencyMs: 350 }));
    const r500 = await s.score(makeEvalInput("out", { latencyMs: 600 }));
    // 350ms: (600-350)/(600-100) = 0.5 — but formula is 1 - (lat-target)/(max-target)
    // 1 - (350-100)/(600-100) = 1 - 250/500 = 0.5
    expect(r300.aggregateScore).toBeCloseTo(0.5);
    expect(r500.aggregateScore).toBe(0.0);
  });

  it("reasoning contains latency value", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 250 }));
    expect(r.scores[0]!.reasoning).toContain("250");
  });

  it('config.name is "latency"', () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 200 });
    expect(s.config.name).toBe("latency");
  });

  it('config.type is "deterministic"', () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 200 });
    expect(s.config.type).toBe("deterministic");
  });

  it("uses custom id", () => {
    const s = createLatencyScorer({
      id: "my-latency",
      targetMs: 10,
      maxMs: 100,
    });
    expect(s.config.id).toBe("my-latency");
  });
});

// ---------------------------------------------------------------------------
// 5. Cost scorer — calibration-like score distribution
// ---------------------------------------------------------------------------

describe("createCostScorer (calibration pipeline)", () => {
  it("cost at target → 1.0", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 10 }));
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("cost below target → 1.0", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 5 }));
    expect(r.aggregateScore).toBe(1.0);
  });

  it("cost at max → 0.0", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 50 }));
    expect(r.aggregateScore).toBe(0.0);
    expect(r.passed).toBe(false);
  });

  it("cost above max → 0.0", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 200 }));
    expect(r.aggregateScore).toBe(0.0);
  });

  it("cost at midpoint → ~0.5", async () => {
    const s = createCostScorer({ targetCents: 0, maxCents: 100 });
    const r = await s.score(makeEvalInput("out", { costCents: 50 }));
    expect(r.aggregateScore).toBeCloseTo(0.5);
  });

  it("missing costCents defaults to 0 → score is 1.0", async () => {
    const s = createCostScorer({ targetCents: 5, maxCents: 50 });
    const r = await s.score(makeEvalInput("out"));
    expect(r.aggregateScore).toBe(1.0);
  });

  it("result includes costCents in the result", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 25 }));
    expect(r.costCents).toBe(25);
  });

  it('config.name is "cost"', () => {
    const s = createCostScorer({ targetCents: 5, maxCents: 20 });
    expect(s.config.name).toBe("cost");
  });

  it("reasoning mentions cost value and target", async () => {
    const s = createCostScorer({ targetCents: 10, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 30 }));
    expect(r.scores[0]!.reasoning).toContain("30");
    expect(r.scores[0]!.reasoning).toContain("10");
  });
});

// ---------------------------------------------------------------------------
// 6. JSON-Schema scorer deep coverage
// ---------------------------------------------------------------------------

describe("createJSONSchemaScorer (deep)", () => {
  it("empty schema → always passes for any JSON object", async () => {
    const s = createJSONSchemaScorer({ schema: {} });
    const r = await s.score(makeEvalInput(JSON.stringify({ anything: true })));
    expect(r.aggregateScore).toBe(1.0);
  });

  it("nested JSON still passes if required top-level fields exist", async () => {
    const s = createJSONSchemaScorer({
      schema: { required: ["id", "data"] },
    });
    const r = await s.score(
      makeEvalInput(JSON.stringify({ id: 1, data: { nested: true } }))
    );
    expect(r.aggregateScore).toBe(1.0);
    expect(r.passed).toBe(true);
  });

  it("JSON primitive (number) is rejected as not an object", async () => {
    const s = createJSONSchemaScorer({ schema: { required: ["x"] } });
    const r = await s.score(makeEvalInput("42"));
    expect(r.aggregateScore).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("JSON boolean is rejected as not an object", async () => {
    const s = createJSONSchemaScorer({ schema: {} });
    const r = await s.score(makeEvalInput("true"));
    expect(r.aggregateScore).toBe(0);
  });

  it("property type check: string field has correct type → passes", async () => {
    const s = createJSONSchemaScorer({
      schema: { properties: { name: { type: "string" } } },
    });
    const r = await s.score(makeEvalInput(JSON.stringify({ name: "Alice" })));
    expect(r.aggregateScore).toBe(1.0);
  });

  it("property type check: string field has wrong type (number) → fails", async () => {
    const s = createJSONSchemaScorer({
      schema: { properties: { count: { type: "number" } } },
    });
    const r = await s.score(
      makeEvalInput(JSON.stringify({ count: "not-a-number" }))
    );
    expect(r.aggregateScore).toBe(0);
    expect(r.scores[0]!.reasoning).toContain("count");
  });

  it("array type property detected correctly", async () => {
    const s = createJSONSchemaScorer({
      schema: { properties: { items: { type: "array" } } },
    });
    const r = await s.score(
      makeEvalInput(JSON.stringify({ items: [1, 2, 3] }))
    );
    expect(r.aggregateScore).toBe(1.0);
  });

  it("missing required field in a multi-field schema → fails with field name in reasoning", async () => {
    const s = createJSONSchemaScorer({
      schema: { required: ["a", "b", "c"] },
    });
    const r = await s.score(makeEvalInput(JSON.stringify({ a: 1, b: 2 })));
    expect(r.aggregateScore).toBe(0);
    expect(r.scores[0]!.reasoning).toContain("c");
  });

  it("scorerId matches id from config", () => {
    const s = createJSONSchemaScorer({ id: "schema-v1", schema: {} });
    expect(s.config.id).toBe("schema-v1");
  });
});

// ---------------------------------------------------------------------------
// 7. computeEvidenceQuality — calibration-pipeline scenarios
// ---------------------------------------------------------------------------

describe("computeEvidenceQuality (calibration pipeline)", () => {
  describe("zero-claim calibration (no-op)", () => {
    it("returns score 0 and confidence low for empty claims", () => {
      const r = computeEvidenceQuality({ claims: [], sources: [] });
      expect(r.score).toBe(0);
      expect(r.confidence).toBe("low");
      expect(r.claimCount).toBe(0);
      expect(r.coverage).toBe(0);
      expect(r.corroboration).toBe(0);
    });

    it("returns score 0 even if sources are provided but no claims", () => {
      const r = computeEvidenceQuality({
        claims: [],
        sources: [{ reliability: "high" }],
      });
      expect(r.score).toBe(0);
      expect(r.claimCount).toBe(0);
    });
  });

  describe("calibration with known-good examples (high confidence)", () => {
    it("3 claims, 3 high sources, all corroborated → score ≈ 1.0", () => {
      const r = computeEvidenceQuality({
        claims: ["C1", "C2", "C3"],
        sources: [
          { reliability: "high" },
          { reliability: "high" },
          { reliability: "high" },
        ],
        claimsWithSources: [
          { claim: "C1", sourceIndices: [0, 1] },
          { claim: "C2", sourceIndices: [1, 2] },
          { claim: "C3", sourceIndices: [0, 2] },
        ],
      });
      expect(r.score).toBeCloseTo(1.0);
      expect(r.confidence).toBe("high");
      expect(r.corroboratedCount).toBe(3);
      expect(r.unsupportedCount).toBe(0);
    });

    it("single claim with 2 high sources → confidence high", () => {
      const r = computeEvidenceQuality({
        claims: ["Only claim"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
        claimsWithSources: [{ claim: "Only claim", sourceIndices: [0, 1] }],
      });
      expect(r.score).toBeCloseTo(1.0);
      expect(r.confidence).toBe("high");
      expect(r.corroboratedCount).toBe(1);
    });
  });

  describe("calibration improves accuracy (coverage drives score)", () => {
    it("increasing coverage from 0 to 1 linearly improves composite score", () => {
      // 0 coverage:
      const rZero = computeEvidenceQuality({
        claims: ["C1", "C2"],
        sources: [{ reliability: "high" }],
        claimsWithSources: [
          { claim: "C1", sourceIndices: [] },
          { claim: "C2", sourceIndices: [] },
        ],
      });
      // 50% coverage:
      const rHalf = computeEvidenceQuality({
        claims: ["C1", "C2"],
        sources: [{ reliability: "high" }],
        claimsWithSources: [
          { claim: "C1", sourceIndices: [0] },
          { claim: "C2", sourceIndices: [] },
        ],
      });
      // 100% coverage:
      const rFull = computeEvidenceQuality({
        claims: ["C1", "C2"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
        claimsWithSources: [
          { claim: "C1", sourceIndices: [0] },
          { claim: "C2", sourceIndices: [1] },
        ],
      });
      expect(rZero.score).toBeLessThan(rHalf.score);
      expect(rHalf.score).toBeLessThan(rFull.score);
    });

    it("adding corroboration to an already-covered claim increases score", () => {
      const rSingle = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }],
        claimsWithSources: [{ claim: "C1", sourceIndices: [0] }],
      });
      const rDouble = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
        claimsWithSources: [{ claim: "C1", sourceIndices: [0, 1] }],
      });
      expect(rDouble.score).toBeGreaterThan(rSingle.score);
    });
  });

  describe("calibration drift detection (score sensitivity)", () => {
    it("replacing high source with low source reduces score", () => {
      const rHigh = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }],
      });
      const rLow = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "low" }],
      });
      expect(rHigh.score).toBeGreaterThan(rLow.score);
    });

    it("unknown reliability sources score between high and low", () => {
      const rHigh = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }],
      });
      const rUnknown = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{}],
      });
      const rLow = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "low" }],
      });
      expect(rHigh.score).toBeGreaterThan(rUnknown.score);
      expect(rUnknown.score).toBeGreaterThan(rLow.score);
    });

    it("adding more sources without mapping treats all claims as corroborated", () => {
      const rTwo = computeEvidenceQuality({
        claims: ["C1", "C2"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
        // no claimsWithSources → all claims get sources.length sources
      });
      expect(rTwo.corroboratedCount).toBe(2);
      expect(rTwo.unsupportedCount).toBe(0);
    });
  });

  describe("source reliability distribution", () => {
    it("all high sources → distribution has only high entries", () => {
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
      });
      expect(r.sourceReliabilityDistribution.high).toBe(2);
      expect(r.sourceReliabilityDistribution.medium).toBe(0);
      expect(r.sourceReliabilityDistribution.low).toBe(0);
      expect(r.sourceReliabilityDistribution.unknown).toBe(0);
    });

    it("mixed reliability → distribution counts each type", () => {
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [
          { reliability: "high" },
          { reliability: "medium" },
          { reliability: "low" },
          {},
        ],
      });
      expect(r.sourceReliabilityDistribution.high).toBe(1);
      expect(r.sourceReliabilityDistribution.medium).toBe(1);
      expect(r.sourceReliabilityDistribution.low).toBe(1);
      expect(r.sourceReliabilityDistribution.unknown).toBe(1);
    });

    it("no sources → distribution all zeros", () => {
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [],
        claimsWithSources: [{ claim: "C1", sourceIndices: [] }],
      });
      expect(r.sourceReliabilityDistribution).toEqual({
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
      });
    });
  });

  describe("confidence thresholds", () => {
    it("score >= 0.7 → confidence high", () => {
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }, { reliability: "high" }],
        claimsWithSources: [{ claim: "C1", sourceIndices: [0, 1] }],
      });
      expect(r.score).toBeGreaterThanOrEqual(0.7);
      expect(r.confidence).toBe("high");
    });

    it("score in [0.4, 0.7) → confidence medium", () => {
      // coverage=1 corroboration=0 reliabilityScore=0.6 (medium)
      // score = 1*0.4 + 0*0.3 + 0.6*0.3 = 0.4 + 0 + 0.18 = 0.58 → medium
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "medium" }],
        claimsWithSources: [{ claim: "C1", sourceIndices: [0] }],
      });
      expect(r.score).toBeGreaterThanOrEqual(0.4);
      expect(r.score).toBeLessThan(0.7);
      expect(r.confidence).toBe("medium");
    });

    it("score < 0.4 → confidence low", () => {
      // all unsupported → coverage 0, corroboration 0, reliability 0 → score 0
      const r = computeEvidenceQuality({
        claims: ["C1", "C2"],
        sources: [],
        claimsWithSources: [
          { claim: "C1", sourceIndices: [] },
          { claim: "C2", sourceIndices: [] },
        ],
      });
      expect(r.score).toBeLessThan(0.4);
      expect(r.confidence).toBe("low");
    });
  });

  describe("invalid source indices filtering", () => {
    it("out-of-range source indices are ignored (not counted)", () => {
      const r = computeEvidenceQuality({
        claims: ["C1"],
        sources: [{ reliability: "high" }], // only index 0 valid
        claimsWithSources: [
          { claim: "C1", sourceIndices: [0, 99, -1] }, // 99 and -1 are invalid
        ],
      });
      // Only 1 valid source index → singleSourceCount, not corroborated
      expect(r.singleSourceCount).toBe(1);
      expect(r.corroboratedCount).toBe(0);
    });
  });

  describe("details field", () => {
    it("details string is non-empty", () => {
      const r = computeEvidenceQuality({ claims: ["C1"], sources: [] });
      expect(typeof r.details).toBe("string");
      expect(r.details.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. EvidenceQualityScorer class (scorer interface)
// ---------------------------------------------------------------------------

describe("EvidenceQualityScorer class (scorer interface)", () => {
  it("returns score 0 when no metadata provided", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({ input: "q", output: "a" });
    expect(r.aggregateScore).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("returns score 0 when metadata.evidence is missing", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({
      input: "q",
      output: "a",
      metadata: { other: "data" },
    });
    expect(r.aggregateScore).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("returns score 0 when metadata.evidence is not an object", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({
      input: "q",
      output: "a",
      metadata: { evidence: "string" },
    });
    expect(r.aggregateScore).toBe(0);
  });

  it("returns correct score with valid evidence metadata", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({
      input: "q",
      output: "a",
      metadata: {
        evidence: {
          claims: ["C1", "C2"],
          sources: [{ reliability: "high" }, { reliability: "high" }],
          claimsWithSources: [
            { claim: "C1", sourceIndices: [0, 1] },
            { claim: "C2", sourceIndices: [0, 1] },
          ],
        },
      },
    });
    expect(r.aggregateScore).toBeCloseTo(1.0);
    expect(r.passed).toBe(true);
  });

  it('config.id is "evidence_quality"', () => {
    const s = new EvidenceQualityScorer();
    expect(s.config.id).toBe("evidence_quality");
  });

  it('config.type is "deterministic"', () => {
    const s = new EvidenceQualityScorer();
    expect(s.config.type).toBe("deterministic");
  });

  it("returns 3 score criteria when evidence is valid", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({
      input: "q",
      output: "a",
      metadata: {
        evidence: {
          claims: ["C1"],
          sources: [{ reliability: "high" }],
        },
      },
    });
    expect(r.scores).toHaveLength(3);
    const criterionNames = r.scores.map((sc) => sc.criterion);
    expect(criterionNames).toContain("coverage");
    expect(criterionNames).toContain("corroboration");
    expect(criterionNames).toContain("reliability");
  });

  it('scorerId is "evidence_quality"', async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({ input: "q", output: "a" });
    expect(r.scorerId).toBe("evidence_quality");
  });

  it("durationMs is a non-negative number", async () => {
    const s = new EvidenceQualityScorer();
    const r = await s.score({ input: "q", output: "a" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof r.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 9. Score aggregation via CompositeScorer — mean/weighted-sum semantics
// ---------------------------------------------------------------------------

describe("CompositeScorer score aggregation (mean/weighted-sum)", () => {
  it("mean of [0.2, 0.4, 0.6, 0.8] with equal weights → 0.5", async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: makeEvalScorer("a", 0.2), weight: 1 },
        { scorer: makeEvalScorer("b", 0.4), weight: 1 },
        { scorer: makeEvalScorer("c", 0.6), weight: 1 },
        { scorer: makeEvalScorer("d", 0.8), weight: 1 },
      ],
    });
    const r = await c.score("in", "out");
    expect(r.score).toBeCloseTo(0.5);
  });

  it("weighted sum: [1.0 w=0, 0.0 w=1] → 0.0 (zero-weight scorer ignored)", async () => {
    const c = new CompositeScorer({
      scorers: [
        { scorer: makeEvalScorer("ignored", 1.0), weight: 0 },
        { scorer: makeEvalScorer("real", 0.0), weight: 1 },
      ],
    });
    const r = await c.score("in", "out");
    expect(r.score).toBeCloseTo(0.0);
  });

  it("single all-zero score → 0.0", async () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: makeEvalScorer("z", 0), weight: 1 }],
    });
    const r = await c.score("in", "out");
    expect(r.score).toBe(0);
  });

  it("single all-one score → 1.0", async () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: makeEvalScorer("z", 1.0), weight: 1 }],
    });
    const r = await c.score("in", "out");
    expect(r.score).toBe(1.0);
  });

  it("weighted sum with 5 scorers computes precisely", async () => {
    // weights: 1,2,3,4,5 → total=15; scores: 0,0.25,0.5,0.75,1.0
    // weighted sum = (0*1 + 0.25*2 + 0.5*3 + 0.75*4 + 1.0*5) / 15
    //             = (0 + 0.5 + 1.5 + 3.0 + 5.0) / 15 = 10 / 15 = 0.6667
    const c = new CompositeScorer({
      scorers: [
        { scorer: makeEvalScorer("a", 0), weight: 1 },
        { scorer: makeEvalScorer("b", 0.25), weight: 2 },
        { scorer: makeEvalScorer("c", 0.5), weight: 3 },
        { scorer: makeEvalScorer("d", 0.75), weight: 4 },
        { scorer: makeEvalScorer("e", 1.0), weight: 5 },
      ],
    });
    const r = await c.score("in", "out");
    expect(r.score).toBeCloseTo(10 / 15, 5);
  });
});

// ---------------------------------------------------------------------------
// 10. Criteria constants
// ---------------------------------------------------------------------------

describe("Scorer criteria constants", () => {
  it("STANDARD_CRITERIA has 3 criteria", () => {
    expect(STANDARD_CRITERIA).toHaveLength(3);
  });

  it("STANDARD_CRITERIA names are relevance, accuracy, completeness", () => {
    const names = STANDARD_CRITERIA.map((c) => c.name);
    expect(names).toContain("relevance");
    expect(names).toContain("accuracy");
    expect(names).toContain("completeness");
  });

  it("STANDARD_CRITERIA weights sum to 1.0", () => {
    const total = STANDARD_CRITERIA.reduce(
      (sum, c) => sum + (c.weight ?? 0),
      0
    );
    expect(total).toBeCloseTo(1.0);
  });

  it("CODE_CRITERIA has 4 criteria", () => {
    expect(CODE_CRITERIA).toHaveLength(4);
  });

  it("CODE_CRITERIA weights sum to 1.0", () => {
    const total = CODE_CRITERIA.reduce((sum, c) => sum + (c.weight ?? 0), 0);
    expect(total).toBeCloseTo(1.0);
  });

  it("CODE_CRITERIA includes correctness and readability", () => {
    const names = CODE_CRITERIA.map((c) => c.name);
    expect(names).toContain("correctness");
    expect(names).toContain("readability");
  });

  it("FIVE_POINT_RUBRIC is a non-empty string describing 5 points", () => {
    expect(typeof FIVE_POINT_RUBRIC).toBe("string");
    expect(FIVE_POINT_RUBRIC).toContain("5");
    expect(FIVE_POINT_RUBRIC.length).toBeGreaterThan(0);
  });

  it("TEN_POINT_RUBRIC is a non-empty string describing 10 points", () => {
    expect(typeof TEN_POINT_RUBRIC).toBe("string");
    expect(TEN_POINT_RUBRIC).toContain("10");
    expect(TEN_POINT_RUBRIC.length).toBeGreaterThan(0);
  });

  it("each STANDARD_CRITERIA entry has a description", () => {
    for (const c of STANDARD_CRITERIA) {
      expect(typeof c.description).toBe("string");
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("each CODE_CRITERIA entry has a description", () => {
    for (const c of CODE_CRITERIA) {
      expect(typeof c.description).toBe("string");
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. DeterministicScorer calibration-like scenarios
// ---------------------------------------------------------------------------

describe("DeterministicScorer calibration scenarios", () => {
  describe("exactMatch — known-good calibration", () => {
    it("scorer trained on reference correctly identifies exact match", async () => {
      const reference = "The quick brown fox";
      const s = new DeterministicScorer({ mode: "exactMatch" });
      const pass = await s.score("in", reference, reference);
      const fail = await s.score("in", "The slow brown fox", reference);
      expect(pass.score).toBe(1.0);
      expect(fail.score).toBe(0.0);
    });

    it("case-insensitive calibration accepts both casings", async () => {
      const s = new DeterministicScorer({
        mode: "exactMatch",
        caseInsensitive: true,
      });
      const r1 = await s.score("in", "HELLO", "hello");
      const r2 = await s.score("in", "hello", "HELLO");
      const r3 = await s.score("in", "Hello", "hElLo");
      expect(r1.score).toBe(1.0);
      expect(r2.score).toBe(1.0);
      expect(r3.score).toBe(1.0);
    });
  });

  describe("regex — calibration with pattern library", () => {
    it("email pattern matches valid email", async () => {
      const s = new DeterministicScorer({
        mode: "regex",
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      });
      expect((await s.score("in", "user@example.com")).score).toBe(1.0);
      expect((await s.score("in", "not-an-email")).score).toBe(0.0);
    });

    it("ISO date pattern matches YYYY-MM-DD", async () => {
      const s = new DeterministicScorer({
        mode: "regex",
        pattern: /^\d{4}-\d{2}-\d{2}$/,
      });
      expect((await s.score("in", "2024-01-15")).score).toBe(1.0);
      expect((await s.score("in", "15/01/2024")).score).toBe(0.0);
    });
  });

  describe("jsonSchema — calibration drift (schema evolution)", () => {
    it("v1 schema passes v1 output", async () => {
      const s = new DeterministicScorer({
        mode: "jsonSchema",
        schema: { required: ["id", "name"] },
      });
      const r = await s.score("in", JSON.stringify({ id: 1, name: "Alice" }));
      expect(r.score).toBe(1.0);
    });

    it("v2 schema (adds required field) fails v1 output — drift detected", async () => {
      const sV2 = new DeterministicScorer({
        mode: "jsonSchema",
        schema: { required: ["id", "name", "email"] }, // new required field
      });
      const r = await sV2.score("in", JSON.stringify({ id: 1, name: "Alice" }));
      expect(r.score).toBe(0.0); // drift detected
      expect(r.reasoning).toContain("email");
    });
  });
});

// ---------------------------------------------------------------------------
// 12. ScorerResult type-guard / shape assertions
// ---------------------------------------------------------------------------

describe("ScorerResult shape contracts", () => {
  it("keyword scorer result has scorerId, scores, aggregateScore, passed, durationMs", async () => {
    const s = createKeywordScorer({ required: ["hello"] });
    const r = await s.score(makeEvalInput("hello world"));
    expect(typeof r.scorerId).toBe("string");
    expect(Array.isArray(r.scores)).toBe(true);
    expect(typeof r.aggregateScore).toBe("number");
    expect(typeof r.passed).toBe("boolean");
    expect(typeof r.durationMs).toBe("number");
  });

  it("latency scorer result has scorerId and durationMs >= 0", async () => {
    const s = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const r = await s.score(makeEvalInput("out", { latencyMs: 200 }));
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.scorerId).toBeTruthy();
  });

  it("cost scorer result has costCents field when input has it", async () => {
    const s = createCostScorer({ targetCents: 5, maxCents: 50 });
    const r = await s.score(makeEvalInput("out", { costCents: 15 }));
    expect(r.costCents).toBe(15);
  });

  it("each score entry in scores array has criterion, score, reasoning", async () => {
    const s = createKeywordScorer({ required: ["x"], forbidden: ["y"] });
    const r = await s.score(makeEvalInput("x only"));
    for (const sc of r.scores) {
      expect(typeof sc.criterion).toBe("string");
      expect(typeof sc.score).toBe("number");
      expect(typeof sc.reasoning).toBe("string");
      expect(sc.score).toBeGreaterThanOrEqual(0);
      expect(sc.score).toBeLessThanOrEqual(1);
    }
  });

  it("composite scorer result has metadata property", async () => {
    const c = new CompositeScorer({
      scorers: [{ scorer: makeEvalScorer("a", 0.5), weight: 1 }],
    });
    const r = await c.score("in", "out");
    expect(r).toHaveProperty("metadata");
  });

  it("ScorerConfig shape from createKeywordScorer", () => {
    const s = createKeywordScorer({ required: ["x"] });
    expect(typeof s.config.id).toBe("string");
    expect(typeof s.config.name).toBe("string");
    expect(typeof s.config.type).toBe("string");
  });
});
