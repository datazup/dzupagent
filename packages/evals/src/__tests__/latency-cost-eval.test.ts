/**
 * Latency & Cost Eval Tests
 *
 * Covers: token cost scoring, latency percentile targets,
 * budget-aware grading, and edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  createLatencyScorer,
  createCostScorer,
} from "../scorers/deterministic-enhanced.js";
import { CompositeScorer } from "../composite-scorer.js";
import type { EvalInput } from "../types.js";
import type { EvalScorer, EvalResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<EvalInput> = {}): EvalInput {
  return {
    input: "test input",
    output: "test output",
    latencyMs: 0,
    costCents: 0,
    ...overrides,
  };
}

/**
 * Compute token cost in cents given usage breakdown.
 * inputPricePerK  – price per 1 000 input tokens in cents
 * outputPricePerK – price per 1 000 output tokens in cents
 * cachedPricePerK – price per 1 000 cached tokens in cents (defaults to 10% of inputPrice)
 */
function computeTokenCostCents(params: {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  inputPricePerK: number;
  outputPricePerK: number;
  cachedPricePerK?: number;
}): number {
  const {
    inputTokens,
    outputTokens,
    cachedTokens = 0,
    inputPricePerK,
    outputPricePerK,
    cachedPricePerK = inputPricePerK * 0.1,
  } = params;
  return (
    (inputTokens / 1000) * inputPricePerK +
    (outputTokens / 1000) * outputPricePerK +
    (cachedTokens / 1000) * cachedPricePerK
  );
}

/**
 * Return the p-th percentile value (0-100) from a sorted or unsorted array.
 * Uses the "nearest rank" method.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1]!;
}

// ---------------------------------------------------------------------------
// Token cost scoring
// ---------------------------------------------------------------------------

describe("Token cost scoring", () => {
  it("total tokens * price_per_token = cost cents", () => {
    const inputTokens = 1000;
    const outputTokens = 500;
    const inputPricePerK = 0.3; // $0.003 per 1K = 0.3 cents
    const outputPricePerK = 1.5; // $0.015 per 1K = 1.5 cents
    const cost = computeTokenCostCents({
      inputTokens,
      outputTokens,
      inputPricePerK,
      outputPricePerK,
    });
    expect(cost).toBeCloseTo(1.05); // 0.3 + 0.75
  });

  it("zero tokens → cost = 0", () => {
    const cost = computeTokenCostCents({
      inputTokens: 0,
      outputTokens: 0,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    expect(cost).toBe(0);
  });

  it("input tokens priced differently than output tokens", () => {
    const inputCost = computeTokenCostCents({
      inputTokens: 1000,
      outputTokens: 0,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    const outputCost = computeTokenCostCents({
      inputTokens: 0,
      outputTokens: 1000,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    expect(inputCost).toBeCloseTo(0.3);
    expect(outputCost).toBeCloseTo(1.5);
    expect(inputCost).not.toBeCloseTo(outputCost);
  });

  it("cached tokens cost less than uncached input tokens", () => {
    const uncachedCost = computeTokenCostCents({
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 0,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    const cachedCost = computeTokenCostCents({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 1000,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
      cachedPricePerK: 0.03, // 10% of input price
    });
    expect(cachedCost).toBeLessThan(uncachedCost);
    expect(cachedCost).toBeCloseTo(0.03);
  });

  it("cached token discount reflected in total cost", () => {
    // 500 regular input + 500 cached → cheaper than 1000 regular input
    const mixedCost = computeTokenCostCents({
      inputTokens: 500,
      outputTokens: 0,
      cachedTokens: 500,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
      cachedPricePerK: 0.03,
    });
    const allUncachedCost = computeTokenCostCents({
      inputTokens: 1000,
      outputTokens: 0,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    expect(mixedCost).toBeLessThan(allUncachedCost);
    // mixed = (500/1000)*0.3 + (500/1000)*0.03 = 0.15 + 0.015 = 0.165
    expect(mixedCost).toBeCloseTo(0.165);
  });
});

// ---------------------------------------------------------------------------
// Cost scorer — budget-based scoring
// ---------------------------------------------------------------------------

describe("createCostScorer — budget-based scoring", () => {
  it("cost under budget → score 1.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 5 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("cost at budget boundary → score 1.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 10 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("cost above budget but below max → score proportionally lower", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    // costCents = 15, midpoint between target(10) and max(20)
    // score = 1 - (15 - 10) / (20 - 10) = 0.5
    const result = await scorer.score(makeInput({ costCents: 15 }));
    expect(result.aggregateScore).toBeCloseTo(0.5);
    expect(result.passed).toBe(true); // score > 0
  });

  it("cost at maxCents → score 0.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 20 }));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it("cost exceeds maxCents → score 0.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 100 }));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it("zero cost → score 1.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 0 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("missing costCents defaults to 0 → score 1.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: undefined }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("cost scorer config is reflected in ScorerConfig name", () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 10 });
    expect(scorer.config.name).toBe("cost");
    expect(scorer.config.type).toBe("deterministic");
  });

  it("custom id is honored in cost scorer", () => {
    const scorer = createCostScorer({
      id: "my-cost",
      targetCents: 5,
      maxCents: 10,
    });
    expect(scorer.config.id).toBe("my-cost");
  });

  it("ScorerResult includes costCents field", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 7 }));
    expect(result.costCents).toBe(7);
  });

  it("score linearly penalizes between target and max", async () => {
    const scorer = createCostScorer({ targetCents: 0, maxCents: 100 });
    const at25 = await scorer.score(makeInput({ costCents: 25 }));
    const at75 = await scorer.score(makeInput({ costCents: 75 }));
    expect(at25.aggregateScore).toBeCloseTo(0.75);
    expect(at75.aggregateScore).toBeCloseTo(0.25);
    expect(at25.aggregateScore).toBeGreaterThan(at75.aggregateScore);
  });

  it("durationMs is present and non-negative", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 5 }));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('scores array contains exactly one entry with criterion "cost"', async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 5 }));
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]!.criterion).toBe("cost");
  });

  it("reasoning mentions cost value", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: 8 }));
    expect(result.scores[0]!.reasoning).toContain("8");
  });
});

// ---------------------------------------------------------------------------
// Latency scorer
// ---------------------------------------------------------------------------

describe("createLatencyScorer — latency target scoring", () => {
  it("latency at or below targetMs → score 1.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 200 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("latency below targetMs → score 1.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 50 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("latency above targetMs → score proportionally lower", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    // latency = 600, midpoint between 200 and 1000
    // score = 1 - (600 - 200) / (1000 - 200) = 1 - 0.5 = 0.5
    const result = await scorer.score(makeInput({ latencyMs: 600 }));
    expect(result.aggregateScore).toBeCloseTo(0.5);
    expect(result.passed).toBe(true); // score > 0
  });

  it("latency at maxMs → score 0.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 1000 }));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it("latency exceeds maxMs → score 0.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 5000 }));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it("zero latency → score 1.0 (handled gracefully)", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 0 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("missing latencyMs defaults to 0 → score 1.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: undefined }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('latency scorer config name is "latency"', () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    expect(scorer.config.name).toBe("latency");
    expect(scorer.config.type).toBe("deterministic");
  });

  it("custom id is honored in latency scorer", () => {
    const scorer = createLatencyScorer({
      id: "my-latency",
      targetMs: 100,
      maxMs: 500,
    });
    expect(scorer.config.id).toBe("my-latency");
  });

  it("score linearly penalizes between target and max", async () => {
    const scorer = createLatencyScorer({ targetMs: 0, maxMs: 1000 });
    const at250 = await scorer.score(makeInput({ latencyMs: 250 }));
    const at750 = await scorer.score(makeInput({ latencyMs: 750 }));
    expect(at250.aggregateScore).toBeCloseTo(0.75);
    expect(at750.aggregateScore).toBeCloseTo(0.25);
    expect(at250.aggregateScore).toBeGreaterThan(at750.aggregateScore);
  });

  it('scores array contains exactly one entry with criterion "latency"', async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 100 }));
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]!.criterion).toBe("latency");
  });

  it("reasoning mentions latency value", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 150 }));
    expect(result.scores[0]!.reasoning).toContain("150");
  });

  it("durationMs is present and non-negative", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 50 }));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Latency percentile targets (multi-run aggregation)
// ---------------------------------------------------------------------------

describe("Latency percentile targets (multi-run aggregation)", () => {
  const latencies = [
    100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380,
    400, 420, 440, 460, 480,
  ];

  it("p50 target: median latency computes correctly", () => {
    const p50 = percentile(latencies, 50);
    // 20 values → rank = ceil(50/100 * 20) = 10 → sorted[9] = 280
    expect(p50).toBe(280);
  });

  it("p95 target: 95th percentile computes correctly", () => {
    const p95 = percentile(latencies, 95);
    // rank = ceil(95/100 * 20) = 19 → sorted[18] = 460
    expect(p95).toBe(460);
  });

  it("p99 target: 99th percentile computes correctly", () => {
    const p99 = percentile(latencies, 99);
    // rank = ceil(99/100 * 20) = 20 → sorted[19] = 480
    expect(p99).toBe(480);
  });

  it("p50 below target → latency scorer passes", async () => {
    const p50 = percentile(latencies, 50);
    const scorer = createLatencyScorer({ targetMs: 300, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: p50 }));
    expect(result.passed).toBe(true);
    expect(result.aggregateScore).toBe(1.0);
  });

  it("p95 above tight target → latency scorer penalizes", async () => {
    const p95 = percentile(latencies, 95);
    // targetMs=100 is well below p95=460
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput({ latencyMs: p95 }));
    expect(result.aggregateScore).toBeLessThan(1.0);
  });

  it("p99 at or above maxMs → latency scorer scores 0.0", async () => {
    const p99 = percentile(latencies, 99);
    // maxMs = p99 (480)
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: p99 });
    const result = await scorer.score(makeInput({ latencyMs: p99 }));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it("multi-run latency scores aggregate: all under target → all pass", async () => {
    const scorer = createLatencyScorer({ targetMs: 500, maxMs: 2000 });
    const results = await Promise.all(
      latencies.map((ms) => scorer.score(makeInput({ latencyMs: ms }))),
    );
    expect(results.every((r) => r.passed)).toBe(true);
    expect(results.every((r) => r.aggregateScore === 1.0)).toBe(true);
  });

  it("multi-run latency average score decreases as latency increases", async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 600 });
    const scores = await Promise.all(
      [200, 300, 400, 500].map((ms) =>
        scorer.score(makeInput({ latencyMs: ms })),
      ),
    );
    const aggScores = scores.map((r) => r.aggregateScore);
    // Must be strictly decreasing
    for (let i = 1; i < aggScores.length; i++) {
      expect(aggScores[i]).toBeLessThan(aggScores[i - 1]!);
    }
  });

  it("single-element latency array → p50 = that value", () => {
    expect(percentile([250], 50)).toBe(250);
    expect(percentile([250], 95)).toBe(250);
    expect(percentile([250], 99)).toBe(250);
  });

  it("empty latency array → percentile returns 0", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Budget-aware grading (combined cost + latency)
// ---------------------------------------------------------------------------

describe("Budget-aware grading (combined cost + latency)", () => {
  /**
   * Wrap enhanced Scorer<EvalInput> in the EvalScorer interface so CompositeScorer
   * (which expects EvalScorer = { name, score(input, output, ref?) }) can use it.
   */
  function wrapAsEvalScorer(
    name: string,
    costCents: number,
    latencyMs: number,
    latencyConfig: { targetMs: number; maxMs: number },
    costConfig: { targetCents: number; maxCents: number },
  ): { latencyEvalScorer: EvalScorer; costEvalScorer: EvalScorer } {
    const latencyEnhanced = createLatencyScorer(latencyConfig);
    const costEnhanced = createCostScorer(costConfig);

    const latencyEvalScorer: EvalScorer = {
      name: `${name}-latency`,
      async score(_input: string, _output: string): Promise<EvalResult> {
        const r = await latencyEnhanced.score(makeInput({ latencyMs }));
        return {
          score: r.aggregateScore,
          pass: r.passed,
          reasoning: r.scores[0]?.reasoning ?? "",
        };
      },
    };

    const costEvalScorer: EvalScorer = {
      name: `${name}-cost`,
      async score(_input: string, _output: string): Promise<EvalResult> {
        const r = await costEnhanced.score(makeInput({ costCents }));
        return {
          score: r.aggregateScore,
          pass: r.passed,
          reasoning: r.scores[0]?.reasoning ?? "",
        };
      },
    };

    return { latencyEvalScorer, costEvalScorer };
  }

  it("equal-weight composite: both pass → composite score 1.0", async () => {
    const { latencyEvalScorer, costEvalScorer } = wrapAsEvalScorer(
      "test",
      5, // costCents under target 10
      100, // latencyMs under target 200
      { targetMs: 200, maxMs: 1000 },
      { targetCents: 10, maxCents: 20 },
    );
    const composite = new CompositeScorer({
      scorers: [
        { scorer: latencyEvalScorer, weight: 1 },
        { scorer: costEvalScorer, weight: 1 },
      ],
    });
    const result = await composite.score("in", "out");
    expect(result.score).toBeCloseTo(1.0);
    expect(result.pass).toBe(true);
  });

  it("equal-weight composite: both fail → composite score 0.0", async () => {
    const { latencyEvalScorer, costEvalScorer } = wrapAsEvalScorer(
      "test",
      20, // at maxCents
      1000, // at maxMs
      { targetMs: 200, maxMs: 1000 },
      { targetCents: 10, maxCents: 20 },
    );
    const composite = new CompositeScorer({
      scorers: [
        { scorer: latencyEvalScorer, weight: 1 },
        { scorer: costEvalScorer, weight: 1 },
      ],
    });
    const result = await composite.score("in", "out");
    expect(result.score).toBeCloseTo(0.0);
    expect(result.pass).toBe(false);
  });

  it("equal-weight composite: one passes, one fails → score ≈ 0.5", async () => {
    const { latencyEvalScorer, costEvalScorer } = wrapAsEvalScorer(
      "test",
      20, // at maxCents → score 0.0
      100, // under target → score 1.0
      { targetMs: 200, maxMs: 1000 },
      { targetCents: 10, maxCents: 20 },
    );
    const composite = new CompositeScorer({
      scorers: [
        { scorer: latencyEvalScorer, weight: 1 },
        { scorer: costEvalScorer, weight: 1 },
      ],
    });
    const result = await composite.score("in", "out");
    expect(result.score).toBeCloseTo(0.5);
  });

  it("cost-heavy composite (weight 3:1): cost dominates the final score", async () => {
    const { latencyEvalScorer, costEvalScorer } = wrapAsEvalScorer(
      "test",
      15, // midpoint → cost score 0.5
      100, // under target → latency score 1.0
      { targetMs: 200, maxMs: 1000 },
      { targetCents: 10, maxCents: 20 },
    );
    const composite = new CompositeScorer({
      scorers: [
        { scorer: costEvalScorer, weight: 3 },
        { scorer: latencyEvalScorer, weight: 1 },
      ],
    });
    const result = await composite.score("in", "out");
    // (0.5*3 + 1.0*1) / 4 = 1.5/4 + 1/4 = 2.5/4 = 0.625
    expect(result.score).toBeCloseTo(0.625);
  });

  it("latency-heavy composite (weight 1:3): latency dominates the final score", async () => {
    const { latencyEvalScorer, costEvalScorer } = wrapAsEvalScorer(
      "test",
      15, // midpoint → cost score 0.5
      100, // under target → latency score 1.0
      { targetMs: 200, maxMs: 1000 },
      { targetCents: 10, maxCents: 20 },
    );
    const composite = new CompositeScorer({
      scorers: [
        { scorer: costEvalScorer, weight: 1 },
        { scorer: latencyEvalScorer, weight: 3 },
      ],
    });
    const result = await composite.score("in", "out");
    // (0.5*1 + 1.0*3) / 4 = 3.5/4 = 0.875
    expect(result.score).toBeCloseTo(0.875);
  });

  it("budget-aware: score is higher when cost is lower for same latency", async () => {
    const buildComposite = (costCents: number) => {
      const latencyEnhanced = createLatencyScorer({
        targetMs: 200,
        maxMs: 1000,
      });
      const costEnhanced = createCostScorer({ targetCents: 10, maxCents: 20 });

      const latencyScorer: EvalScorer = {
        name: "latency",
        async score() {
          const r = await latencyEnhanced.score(makeInput({ latencyMs: 100 }));
          return { score: r.aggregateScore, pass: r.passed, reasoning: "" };
        },
      };
      const costScorer: EvalScorer = {
        name: "cost",
        async score() {
          const r = await costEnhanced.score(makeInput({ costCents }));
          return { score: r.aggregateScore, pass: r.passed, reasoning: "" };
        },
      };
      return new CompositeScorer({
        scorers: [
          { scorer: latencyScorer, weight: 1 },
          { scorer: costScorer, weight: 1 },
        ],
      });
    };

    const cheapResult = await buildComposite(5).score("in", "out"); // cost under target
    const priceyResult = await buildComposite(18).score("in", "out"); // cost above target
    expect(cheapResult.score).toBeGreaterThan(priceyResult.score);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("latency scorer: very high targetMs clamps score to 1.0 for any realistic latency", async () => {
    const scorer = createLatencyScorer({
      targetMs: 1_000_000,
      maxMs: 2_000_000,
    });
    const result = await scorer.score(makeInput({ latencyMs: 9999 }));
    expect(result.aggregateScore).toBe(1.0);
  });

  it("cost scorer: very high targetCents clamps score to 1.0 for any realistic cost", async () => {
    const scorer = createCostScorer({
      targetCents: 1_000_000,
      maxCents: 2_000_000,
    });
    const result = await scorer.score(makeInput({ costCents: 9999 }));
    expect(result.aggregateScore).toBe(1.0);
  });

  it("latency scorer: targetMs == maxMs boundary → latency at target scores 1.0", async () => {
    // When target == max the linear formula would be (latency - target) / 0 = Infinity
    // but latencyMs <= targetMs branch fires first and returns 1.0
    const scorer = createLatencyScorer({ targetMs: 500, maxMs: 500 });
    const result = await scorer.score(makeInput({ latencyMs: 500 }));
    expect(result.aggregateScore).toBe(1.0);
  });

  it("cost scorer: targetCents == maxCents boundary → cost at target scores 1.0", async () => {
    const scorer = createCostScorer({ targetCents: 10, maxCents: 10 });
    const result = await scorer.score(makeInput({ costCents: 10 }));
    expect(result.aggregateScore).toBe(1.0);
  });

  it("latency scorer scorerId is included in result", async () => {
    const scorer = createLatencyScorer({
      id: "lat-123",
      targetMs: 200,
      maxMs: 1000,
    });
    const result = await scorer.score(makeInput({ latencyMs: 100 }));
    expect(result.scorerId).toBe("lat-123");
  });

  it("cost scorer scorerId is included in result", async () => {
    const scorer = createCostScorer({
      id: "cost-456",
      targetCents: 10,
      maxCents: 20,
    });
    const result = await scorer.score(makeInput({ costCents: 5 }));
    expect(result.scorerId).toBe("cost-456");
  });

  it("zero-cost edge case: 0 tokens → costCents=0 → score 1.0", async () => {
    const cost = computeTokenCostCents({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      inputPricePerK: 0.3,
      outputPricePerK: 1.5,
    });
    const scorer = createCostScorer({ targetCents: 10, maxCents: 20 });
    const result = await scorer.score(makeInput({ costCents: cost }));
    expect(cost).toBe(0);
    expect(result.aggregateScore).toBe(1.0);
  });

  it("zero-latency edge case: 0ms → latency scorer returns 1.0", async () => {
    const scorer = createLatencyScorer({ targetMs: 200, maxMs: 1000 });
    const result = await scorer.score(makeInput({ latencyMs: 0 }));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });
});
