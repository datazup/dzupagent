/**
 * W30-D — LLM-as-judge pipeline deep coverage (70+ tests)
 *
 * Tests the judge pipeline at a higher level than the unit tests already in:
 *   - llm-judge-scorer.test.ts        (LlmJudgeScorer unit tests)
 *   - llm-judge-enhanced.test.ts      (createLLMJudge pinned-snapshot tests)
 *   - prompt-experiment-judge-enhanced-deep.test.ts (multi-criteria + stats)
 *   - scorer-combinators-calibration-deep.test.ts   (W28-B combinator tests)
 *
 * This file adds pipeline-level concerns:
 *   - Multi-judge panels with score aggregation (mean / median / majority vote)
 *   - Judge disagreement detection + configurable threshold
 *   - Confidence-interval computation from N scores
 *   - Rubric validation (invalid rubric rejected at setup time)
 *   - Per-criterion scoring with weighted sum + weight normalization
 *   - Calibration with ground truth: offset computation + application
 *   - Judge timeout with fallback score + metadata flag
 *   - Out-of-range score clamping to [0, 1]
 *   - Structured output parsing and malformed output retry
 *   - Batch evaluation (N responses in parallel, all collected)
 *   - Metadata: model name, latency, token count recorded per evaluation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LlmJudgeScorer,
  judgeResponseSchema,
} from "../scorers/llm-judge-scorer.js";
import { createLLMJudge, PINNED_JUDGE } from "../scorers/llm-judge-enhanced.js";
import type {
  JudgeDimension,
  JudgeScorerResult,
  JudgeTokenUsage,
  JudgeScorerConfig,
  JudgeAnchor,
} from "../scorers/llm-judge-scorer.js";
import type { EvalInput, ScorerResult } from "../types.js";
import type { JudgeCriterion } from "../scorers/criteria.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid 5-dimension response (0-10 scale for the Zod-validated LlmJudgeScorer). */
function make5DimResponse(
  scores: Partial<Record<JudgeDimension, number>> = {},
  reasoning = "judge reasoning"
): string {
  return JSON.stringify({
    correctness: 8,
    completeness: 8,
    coherence: 8,
    relevance: 8,
    safety: 8,
    reasoning,
    ...scores,
  });
}

/** Build a valid enhanced-judge array response (score 0-1 scale). */
function makeEnhancedResponse(
  criteria: string[],
  scores: number[],
  reasonings?: string[]
): string {
  return JSON.stringify(
    criteria.map((c, i) => ({
      criterion: c,
      score: scores[i] ?? 0.5,
      reasoning: reasonings?.[i] ?? `${c} reasoning`,
    }))
  );
}

/** Create a simple LlmJudgeScorer with a mocked LLM. */
function makeJudgeScorer(
  llm: (p: string) => Promise<string>,
  overrides?: Partial<JudgeScorerConfig>
): LlmJudgeScorer {
  return new LlmJudgeScorer({ llm, ...overrides });
}

// ---------------------------------------------------------------------------
// 1. Single judge — basic pipeline
// ---------------------------------------------------------------------------

describe("Single judge pipeline", () => {
  it("returns score and reasoning from a single LLM call", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(make5DimResponse({ correctness: 9, safety: 10 }));
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("input", "output");
    expect(result.overall).toBeGreaterThan(0);
    expect(result.reasoning).toBe("judge reasoning");
    expect(llm).toHaveBeenCalledOnce();
  });

  it("passes both input and output text into the judge prompt", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm);
    await scorer.score("the question", "the answer");
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("the question");
    expect(prompt).toContain("the answer");
  });

  it("returns JudgeScorerResult shape with all 5 dimension keys", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    const keys: JudgeDimension[] = [
      "correctness",
      "completeness",
      "coherence",
      "relevance",
      "safety",
    ];
    for (const k of keys) {
      expect(result.dimensions).toHaveProperty(k);
      expect(typeof result.dimensions[k]).toBe("number");
    }
  });

  it("records tokenUsage in result", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.totalTokens).toBeGreaterThan(0);
  });

  it("records model name via scorerConfig.id", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm, { id: "gpt-4o-judge" });
    expect(scorer.config.id).toBe("gpt-4o-judge");
    expect(scorer.config.type).toBe("llm-judge");
  });

  it("records latency via durationMs in EvalInput interface", async () => {
    const llm = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<string>((res) =>
            setTimeout(() => res(make5DimResponse()), 5)
          )
      );
    const scorer = makeJudgeScorer(llm);
    const evalResult = await scorer.score({ input: "q", output: "a" });
    expect(evalResult.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-judge panel — score aggregation
// ---------------------------------------------------------------------------

describe("Multi-judge panel: mean aggregation", () => {
  /** Run three mocked judges over the same input and compute mean overall. */
  async function runPanel(scores: number[]): Promise<number> {
    const results = await Promise.all(
      scores.map((s) => {
        const raw = make5DimResponse({
          correctness: s * 10,
          completeness: s * 10,
          coherence: s * 10,
          relevance: s * 10,
          safety: s * 10,
        });
        const llm = vi.fn().mockResolvedValue(raw);
        return makeJudgeScorer(llm).score("q", "a");
      })
    );
    return results.reduce((sum, r) => sum + r.overall, 0) / results.length;
  }

  it("computes mean of three identical judge scores", async () => {
    const mean = await runPanel([0.8, 0.8, 0.8]);
    expect(mean).toBeCloseTo(0.8, 3);
  });

  it("computes mean of three different judge scores", async () => {
    const mean = await runPanel([0.6, 0.8, 1.0]);
    expect(mean).toBeCloseTo(0.8, 3);
  });

  it("handles panel of 5 judges and averages correctly", async () => {
    const mean = await runPanel([0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(mean).toBeCloseTo(0.7, 3);
  });
});

describe("Multi-judge panel: median aggregation", () => {
  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  async function panelScores(rawScores: number[]): Promise<number[]> {
    return Promise.all(
      rawScores.map((s) => {
        const raw = make5DimResponse({
          correctness: s * 10,
          completeness: s * 10,
          coherence: s * 10,
          relevance: s * 10,
          safety: s * 10,
        });
        const llm = vi.fn().mockResolvedValue(raw);
        return makeJudgeScorer(llm)
          .score("q", "a")
          .then((r) => r.overall);
      })
    );
  }

  it("returns correct median for odd number of judges", async () => {
    const scores = await panelScores([0.6, 0.9, 0.7]);
    expect(median(scores)).toBeCloseTo(0.7, 3);
  });

  it("returns correct median for even number of judges", async () => {
    const scores = await panelScores([0.6, 0.8, 0.7, 0.9]);
    expect(median(scores)).toBeCloseTo(0.75, 3);
  });
});

describe("Multi-judge panel: majority vote (pass/fail)", () => {
  async function majorityPass(
    scores: number[],
    threshold = 0.7
  ): Promise<boolean> {
    const passes = await Promise.all(
      scores.map(async (s) => {
        const raw = make5DimResponse({
          correctness: s * 10,
          completeness: s * 10,
          coherence: s * 10,
          relevance: s * 10,
          safety: s * 10,
        });
        const llm = vi.fn().mockResolvedValue(raw);
        const r = await makeJudgeScorer(llm, {
          passThreshold: threshold,
        }).score({
          input: "q",
          output: "a",
        });
        return r.passed;
      })
    );
    const trueCount = passes.filter(Boolean).length;
    return trueCount > passes.length / 2;
  }

  it("majority vote passes when >50% judges pass", async () => {
    const result = await majorityPass([0.8, 0.8, 0.6]); // 2 pass, 1 fail
    expect(result).toBe(true);
  });

  it("majority vote fails when majority reject", async () => {
    const result = await majorityPass([0.5, 0.5, 0.9]); // 2 fail, 1 pass
    expect(result).toBe(false);
  });

  it("majority vote: 3-3 tie resolves false (strictly >50%)", async () => {
    const result = await majorityPass([0.8, 0.8, 0.8, 0.5, 0.5, 0.5]);
    // 3 pass / 6 judges = exactly 50%, not > 50%
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Judge disagreement detection
// ---------------------------------------------------------------------------

describe("Judge disagreement detection", () => {
  function variance(values: number[]): number {
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  }

  function isDisagreement(scores: number[], threshold: number): boolean {
    return variance(scores) > threshold;
  }

  it("flags high variance as disagreement", () => {
    const scores = [0.1, 0.9, 0.5]; // high spread
    expect(isDisagreement(scores, 0.05)).toBe(true);
  });

  it("does not flag low variance as disagreement", () => {
    const scores = [0.79, 0.81, 0.8]; // very tight
    expect(isDisagreement(scores, 0.05)).toBe(false);
  });

  it("disagreement threshold is configurable", () => {
    const scores = [0.6, 0.8]; // variance = 0.01
    expect(isDisagreement(scores, 0.005)).toBe(true); // tight threshold → disagree
    expect(isDisagreement(scores, 0.05)).toBe(false); // loose threshold → agree
  });

  it("single judge produces zero variance (no disagreement)", () => {
    expect(isDisagreement([0.7], 0.01)).toBe(false);
  });

  it("three judges with very different scores produce high variance", () => {
    const scores = [0.0, 0.5, 1.0];
    const v = variance(scores);
    expect(v).toBeCloseTo(1 / 6, 3);
    expect(isDisagreement(scores, 0.1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Confidence interval computation
// ---------------------------------------------------------------------------

describe("Confidence interval from N judge scores", () => {
  /** 95% CI using t-distribution approximation (z=1.96 for large N). */
  function ci95(scores: number[]): {
    lower: number;
    upper: number;
    mean: number;
  } {
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(
      scores.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1)
    );
    const margin = 1.96 * (std / Math.sqrt(n));
    return { lower: mean - margin, upper: mean + margin, mean };
  }

  it("CI is centered on the mean", () => {
    const scores = [0.7, 0.8, 0.9];
    const { lower, upper, mean } = ci95(scores);
    expect((lower + upper) / 2).toBeCloseTo(mean, 5);
  });

  it("wider spread produces wider CI", () => {
    const narrow = ci95([0.79, 0.8, 0.81]);
    const wide = ci95([0.5, 0.8, 1.1]);
    const narrowWidth = narrow.upper - narrow.lower;
    const wideWidth = wide.upper - wide.lower;
    expect(wideWidth).toBeGreaterThan(narrowWidth);
  });

  it("CI contains the mean for any set of scores", () => {
    const scores = [0.3, 0.6, 0.55, 0.72, 0.9];
    const { lower, upper, mean } = ci95(scores);
    expect(mean).toBeGreaterThanOrEqual(lower);
    expect(mean).toBeLessThanOrEqual(upper);
  });

  it("single score produces a zero-width CI (std=0 guard)", () => {
    const { lower, upper, mean } = ci95([0.75]);
    expect(mean).toBeCloseTo(0.75, 5);
    expect(upper - lower).toBe(0);
  });

  it("CI bounds are in correct order (lower < upper)", () => {
    const scores = [0.4, 0.6, 0.5, 0.7, 0.45, 0.65];
    const { lower, upper } = ci95(scores);
    expect(lower).toBeLessThan(upper);
  });
});

// ---------------------------------------------------------------------------
// 5. Rubric validation
// ---------------------------------------------------------------------------

describe("Rubric validation at setup time", () => {
  it("createLLMJudge accepts a valid string rubric", () => {
    expect(() =>
      createLLMJudge({
        criteria: "Rate the answer quality from 0 to 1.",
        llm: async () => "[]",
      })
    ).not.toThrow();
  });

  it("createLLMJudge accepts an array of valid JudgeCriterion objects", () => {
    const criteria: JudgeCriterion[] = [
      { name: "accuracy", description: "Is the answer accurate?", weight: 0.6 },
      { name: "clarity", description: "Is the answer clear?", weight: 0.4 },
    ];
    expect(() =>
      createLLMJudge({ criteria, llm: async () => "[]" })
    ).not.toThrow();
  });

  it("createLLMJudge accepts criteria array with optional weight omitted", () => {
    const criteria: JudgeCriterion[] = [
      { name: "accuracy", description: "Accurate?" },
    ];
    expect(() =>
      createLLMJudge({ criteria, llm: async () => "[]" })
    ).not.toThrow();
  });

  it("LlmJudgeScorer rejects scores outside 0-10 range via Zod at parse time", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        correctness: 11,
        completeness: 8,
        coherence: 8,
        relevance: 8,
        safety: 8,
        reasoning: "ok",
      })
    );
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    expect(result.overall).toBe(0.5); // fallback
  });

  it("LlmJudgeScorer rejects response missing required fields", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ correctness: 8, reasoning: "partial" })
      );
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    expect(result.overall).toBe(0.5); // fallback
  });

  it("judgeResponseSchema validates correctly structured object", () => {
    const valid = judgeResponseSchema.safeParse({
      correctness: 7,
      completeness: 6,
      coherence: 8,
      relevance: 9,
      safety: 10,
      reasoning: "Good",
    });
    expect(valid.success).toBe(true);
  });

  it("judgeResponseSchema rejects non-string reasoning", () => {
    const invalid = judgeResponseSchema.safeParse({
      correctness: 7,
      completeness: 6,
      coherence: 8,
      relevance: 9,
      safety: 10,
      reasoning: 42,
    });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Per-criterion scoring + weighted sum
// ---------------------------------------------------------------------------

describe("Per-criterion scoring with weighted sum", () => {
  it("each criterion is scored independently by the judge", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "accuracy", description: "Accurate?", weight: 1 },
      { name: "clarity", description: "Clear?", weight: 1 },
      { name: "safety", description: "Safe?", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(
        makeEnhancedResponse(["accuracy", "clarity", "safety"], [0.9, 0.7, 1.0])
      );
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });

    const names = result.scores.map((s) => s.criterion);
    expect(names).toContain("accuracy");
    expect(names).toContain("clarity");
    expect(names).toContain("safety");
  });

  it("weighted sum is computed using criterion weights", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 2 },
      { name: "b", description: "B", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["a", "b"], [1.0, 0.0]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    // weighted sum: (1.0*2 + 0.0*1) / 3 = 2/3 ≈ 0.667
    expect(result.aggregateScore).toBeCloseTo(2 / 3, 3);
  });

  it("all criteria equal weight produces arithmetic mean", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 1 },
      { name: "b", description: "B", weight: 1 },
      { name: "c", description: "C", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(
        makeEnhancedResponse(["a", "b", "c"], [0.6, 0.8, 1.0])
      );
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo((0.6 + 0.8 + 1.0) / 3, 3);
  });

  it("single-criterion judge returns that criterion score as aggregate", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "quality", description: "Overall quality", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["quality"], [0.85]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.85, 3);
  });
});

// ---------------------------------------------------------------------------
// 7. Criterion weight normalization
// ---------------------------------------------------------------------------

describe("Criterion weight normalization", () => {
  it("weights summing to 2 produce correct normalized aggregate", async () => {
    // weight 0.8 + 0.8 = 1.6; sum normalizes by dividing by total weight
    const criteria: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 0.8 },
      { name: "b", description: "B", weight: 0.8 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["a", "b"], [1.0, 0.0]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    // (1.0*0.8 + 0.0*0.8) / 1.6 = 0.5
    expect(result.aggregateScore).toBeCloseTo(0.5, 3);
  });

  it("weights summing to 0.5 still produce valid [0,1] aggregate", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 0.3 },
      { name: "b", description: "B", weight: 0.2 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["a", "b"], [0.8, 0.6]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    // (0.8*0.3 + 0.6*0.2) / 0.5 = (0.24 + 0.12) / 0.5 = 0.36 / 0.5 = 0.72
    expect(result.aggregateScore).toBeCloseTo(0.72, 3);
    expect(result.aggregateScore).toBeGreaterThanOrEqual(0);
    expect(result.aggregateScore).toBeLessThanOrEqual(1);
  });

  it("large weights produce same relative aggregate as normalized weights", async () => {
    const criteria1: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 1 },
      { name: "b", description: "B", weight: 1 },
    ];
    const criteria2: JudgeCriterion[] = [
      { name: "a", description: "A", weight: 100 },
      { name: "b", description: "B", weight: 100 },
    ];
    const response = makeEnhancedResponse(["a", "b"], [0.6, 0.4]);
    const llm1 = vi.fn().mockResolvedValue(response);
    const llm2 = vi.fn().mockResolvedValue(response);
    const [r1, r2] = await Promise.all([
      createLLMJudge({ criteria: criteria1, llm: llm1 }).score({
        input: "q",
        output: "a",
      }),
      createLLMJudge({ criteria: criteria2, llm: llm2 }).score({
        input: "q",
        output: "a",
      }),
    ]);
    expect(r1.aggregateScore).toBeCloseTo(r2.aggregateScore, 5);
  });
});

// ---------------------------------------------------------------------------
// 8. Calibration with ground truth (offset computation)
// ---------------------------------------------------------------------------

describe("Calibration with ground truth — offset computation", () => {
  /** Compute calibration offset: mean(judgeScores) - mean(groundTruth) */
  function computeCalibrationOffset(
    judgeScores: number[],
    groundTruths: number[]
  ): number {
    if (
      judgeScores.length !== groundTruths.length ||
      judgeScores.length === 0
    ) {
      throw new Error("Input arrays must be non-empty and same length");
    }
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return mean(judgeScores) - mean(groundTruths);
  }

  it("offset is zero when judge matches ground truth exactly", () => {
    expect(
      computeCalibrationOffset([0.7, 0.8, 0.9], [0.7, 0.8, 0.9])
    ).toBeCloseTo(0, 5);
  });

  it("offset is positive when judge scores are biased high", () => {
    const offset = computeCalibrationOffset([0.9, 0.8, 0.85], [0.7, 0.6, 0.65]);
    expect(offset).toBeCloseTo(0.2, 5);
  });

  it("offset is negative when judge scores are biased low", () => {
    const offset = computeCalibrationOffset([0.5, 0.6, 0.55], [0.7, 0.8, 0.75]);
    expect(offset).toBeCloseTo(-0.2, 5);
  });

  it("calibrated score is raw score minus offset, clamped to [0,1]", () => {
    const offset = 0.15;
    const rawScore = 0.8;
    const calibrated = Math.max(0, Math.min(1, rawScore - offset));
    expect(calibrated).toBeCloseTo(0.65, 5);
  });

  it("calibrated score is clamped to 0 if correction would go negative", () => {
    const offset = 0.6;
    const rawScore = 0.4;
    const calibrated = Math.max(0, Math.min(1, rawScore - offset));
    expect(calibrated).toBe(0);
  });

  it("calibrated score is clamped to 1 if correction would exceed 1", () => {
    const offset = -0.5;
    const rawScore = 0.8;
    const calibrated = Math.max(0, Math.min(1, rawScore - offset));
    expect(calibrated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Calibration applied via JudgeAnchor (few-shot examples in prompt)
// ---------------------------------------------------------------------------

describe("Calibration applied via anchor examples", () => {
  it("anchor examples appear in the LLM prompt", async () => {
    const anchors: JudgeAnchor[] = [
      {
        input: "Q1",
        output: "A1",
        expectedScore: 0.9,
        explanation: "Excellent",
      },
      {
        input: "Q2",
        output: "A2",
        expectedScore: 0.3,
        explanation: "Poor answer",
      },
    ];
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm, { anchors });
    await scorer.score("test", "output");
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("Q1");
    expect(prompt).toContain("Excellent");
    expect(prompt).toContain("Q2");
    expect(prompt).toContain("Poor answer");
  });

  it("scorer with anchors still returns valid score", async () => {
    const anchors: JudgeAnchor[] = [
      {
        input: "good example",
        output: "correct",
        expectedScore: 0.95,
        explanation: "Perfect",
      },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(make5DimResponse({ correctness: 10, safety: 10 }));
    const scorer = makeJudgeScorer(llm, { anchors });
    const result = await scorer.score("question", "response");
    expect(result.overall).toBeGreaterThan(0);
  });

  it("multiple anchors in prompt are listed in calibration section", async () => {
    const anchors: JudgeAnchor[] = [
      { input: "A", output: "B", expectedScore: 0.5, explanation: "Mediocre" },
      { input: "C", output: "D", expectedScore: 0.8, explanation: "Good" },
      { input: "E", output: "F", expectedScore: 1.0, explanation: "Perfect" },
    ];
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm, { anchors });
    await scorer.score("q", "a");
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("Calibration examples");
    expect(prompt).toContain("Mediocre");
    expect(prompt).toContain("Perfect");
  });
});

// ---------------------------------------------------------------------------
// 10. Judge timeout with fallback
// ---------------------------------------------------------------------------

describe("Judge timeout with fallback", () => {
  /**
   * We simulate "timeout" by creating a scorer whose LLM never resolves.
   * We wrap the call with Promise.race + a timeout promise.
   */
  async function scoreWithTimeout(
    scorer: LlmJudgeScorer,
    input: string,
    output: string,
    timeoutMs: number
  ): Promise<{ result: JudgeScorerResult; timedOut: boolean }> {
    let timedOut = false;
    const timeout = new Promise<JudgeScorerResult>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve({
          overall: 0.5,
          dimensions: {
            correctness: 0.5,
            completeness: 0.5,
            coherence: 0.5,
            relevance: 0.5,
            safety: 0.5,
          },
          reasoning: "Timeout: LLM call exceeded time limit",
        });
      }, timeoutMs)
    );
    const result = await Promise.race([scorer.score(input, output), timeout]);
    return { result, timedOut };
  }

  it("returns fallback score of 0.5 on timeout", async () => {
    const neverResolves = vi
      .fn()
      .mockReturnValue(new Promise<string>(() => {}));
    const scorer = makeJudgeScorer(neverResolves, { maxRetries: 0 });
    const { result, timedOut } = await scoreWithTimeout(scorer, "q", "a", 20);
    expect(timedOut).toBe(true);
    expect(result.overall).toBe(0.5);
  });

  it("timeout is recorded in reasoning metadata", async () => {
    const neverResolves = vi
      .fn()
      .mockReturnValue(new Promise<string>(() => {}));
    const scorer = makeJudgeScorer(neverResolves, { maxRetries: 0 });
    const { result } = await scoreWithTimeout(scorer, "q", "a", 20);
    expect(result.reasoning).toContain("Timeout");
  });

  it("fast LLM call completes before timeout fires", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse({ correctness: 9 }));
    const scorer = makeJudgeScorer(llm);
    const { timedOut } = await scoreWithTimeout(scorer, "q", "a", 5000);
    expect(timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Out-of-range score clamping to [0, 1]
// ---------------------------------------------------------------------------

describe("Out-of-range score clamping", () => {
  it("scores exceeding 1 in enhanced judge are clamped to 1.0", async () => {
    // createLLMJudge clamps inside parseResponse: Math.max(0, Math.min(1, score))
    const criteria: JudgeCriterion[] = [
      { name: "quality", description: "Quality", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify([
          { criterion: "quality", score: 1.5, reasoning: "Great" },
        ])
      );
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    const qualityScore = result.scores.find((s) => s.criterion === "quality")!;
    expect(qualityScore.score).toBeLessThanOrEqual(1.0);
    expect(qualityScore.score).toBeGreaterThanOrEqual(0.0);
  });

  it("negative scores in enhanced judge are clamped to 0", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "quality", description: "Quality", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify([
          { criterion: "quality", score: -0.5, reasoning: "Terrible" },
        ])
      );
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    const qualityScore = result.scores.find((s) => s.criterion === "quality")!;
    expect(qualityScore.score).toBe(0);
  });

  it("LlmJudgeScorer returns 0.5 fallback when Zod rejects out-of-range (>10)", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        correctness: 12,
        completeness: 8,
        coherence: 8,
        relevance: 8,
        safety: 8,
        reasoning: "over range",
      })
    );
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    expect(result.overall).toBe(0.5);
  });

  it("LlmJudgeScorer returns 0.5 fallback when Zod rejects out-of-range (<0)", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        correctness: -1,
        completeness: 8,
        coherence: 8,
        relevance: 8,
        safety: 8,
        reasoning: "negative",
      })
    );
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    expect(result.overall).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 12. Structured output parsing
// ---------------------------------------------------------------------------

describe("Structured output parsing", () => {
  it("parses clean JSON object with score + reasoning", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(make5DimResponse({ correctness: 8 }, "clear"));
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    expect(result.reasoning).toBe("clear");
    expect(result.dimensions.correctness).toBeCloseTo(0.8, 4);
  });

  it("extracts JSON from prose-wrapped response", async () => {
    const jsonPart = make5DimResponse({ correctness: 7 }, "wrapped");
    const llm = vi
      .fn()
      .mockResolvedValue(`Here is my evaluation:\n${jsonPart}\nThanks!`);
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    expect(result.overall).toBeGreaterThan(0);
    expect(result.reasoning).toBe("wrapped");
  });

  it("parses JSON with extra unknown fields (Zod ignores extra keys)", async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        correctness: 9,
        completeness: 9,
        coherence: 9,
        relevance: 9,
        safety: 9,
        reasoning: "good",
        unexpectedField: "extra value",
      })
    );
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    expect(result.overall).toBeCloseTo(0.9, 4);
  });

  it("parses floating-point scores in all dimensions", async () => {
    const llm = vi.fn().mockResolvedValue(
      make5DimResponse({
        correctness: 7.5,
        completeness: 6.25,
        coherence: 8.75,
        relevance: 9.0,
        safety: 5.5,
      })
    );
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score("q", "a");
    expect(result.dimensions.correctness).toBeCloseTo(0.75, 4);
    expect(result.dimensions.completeness).toBeCloseTo(0.625, 4);
    expect(result.dimensions.coherence).toBeCloseTo(0.875, 4);
  });
});

// ---------------------------------------------------------------------------
// 13. Malformed output with retry
// ---------------------------------------------------------------------------

describe("Malformed output with retry", () => {
  it("retries on non-JSON response and succeeds on valid retry", async () => {
    const llm = vi
      .fn()
      .mockResolvedValueOnce("not json at all")
      .mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm, { maxRetries: 1 });
    const result = await scorer.score("q", "a");
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).not.toBe(0.5); // not fallback
  });

  it("falls back to 0.5 after exhausting all retries on malformed output", async () => {
    const llm = vi.fn().mockResolvedValue("{ bad json with no closing brace");
    const scorer = makeJudgeScorer(llm, { maxRetries: 2 });
    const result = await scorer.score("q", "a");
    expect(llm).toHaveBeenCalledTimes(3);
    expect(result.overall).toBe(0.5);
  });

  it("returns 0 aggregate in enhanced judge after all retries on malformed output", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "q", description: "Q", weight: 1 },
    ];
    const llm = vi.fn().mockResolvedValue("plain text no JSON");
    const scorer = createLLMJudge({ criteria, llm, maxRetries: 1 });
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("handles response where JSON is an array of strings instead of objects", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(JSON.stringify(["bad", "array", "items"]));
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    // The JSON is an array not an object — regex extracts {} only; array won't match
    expect(result.overall).toBe(0.5);
  });

  it("handles completely empty response (empty string)", async () => {
    const llm = vi.fn().mockResolvedValue("");
    const scorer = makeJudgeScorer(llm, { maxRetries: 0 });
    const result = await scorer.score("q", "a");
    expect(result.overall).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 14. Batch evaluation
// ---------------------------------------------------------------------------

describe("Batch evaluation (N responses in parallel)", () => {
  it("evaluates multiple responses and collects all results", async () => {
    const inputs = [
      { input: "Q1", output: "A1" },
      { input: "Q2", output: "A2" },
      { input: "Q3", output: "A3" },
    ];
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const results = await Promise.all(
      inputs.map((i) => scorer.score(i.input, i.output))
    );
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.overall).toBeGreaterThan(0);
    }
  });

  it("batch of 10 runs all in parallel and returns 10 results", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => scorer.score(`Q${i}`, `A${i}`))
    );
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.overall > 0)).toBe(true);
  });

  it("batch tolerates individual failures gracefully via allSettled", async () => {
    const responses = [make5DimResponse(), "bad json", make5DimResponse()];
    let idx = 0;
    const scorer = makeJudgeScorer(
      vi.fn(async () => responses[idx++ % responses.length]!),
      {
        maxRetries: 0,
      }
    );
    const results = await Promise.allSettled([
      scorer.score("Q1", "A1"),
      scorer.score("Q2", "A2"),
      scorer.score("Q3", "A3"),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const scores = results.map(
      (r) => (r as PromiseFulfilledResult<JudgeScorerResult>).value.overall
    );
    // first and third succeed, second falls back to 0.5
    expect(scores[0]).not.toBe(0.5);
    expect(scores[1]).toBe(0.5);
    expect(scores[2]).not.toBe(0.5);
  });

  it("batch evaluation uses independent LLM call per response", async () => {
    const llm = vi.fn().mockResolvedValue(make5DimResponse());
    const scorer = makeJudgeScorer(llm);
    await Promise.all([
      scorer.score("Q1", "A1"),
      scorer.score("Q2", "A2"),
      scorer.score("Q3", "A3"),
    ]);
    expect(llm).toHaveBeenCalledTimes(3);
  });

  it("batch results each include tokenUsage metadata", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const results = await Promise.all(
      ["A", "B", "C"].map((x) => scorer.score("q", x))
    );
    for (const r of results) {
      expect(r.tokenUsage).toBeDefined();
      expect(r.tokenUsage!.totalTokens).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Metadata: model name, latency, token count
// ---------------------------------------------------------------------------

describe("Metadata recording per evaluation", () => {
  it("records scorer config id as model identifier", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse()),
      { id: "claude-3-haiku-judge" }
    );
    expect(scorer.config.id).toBe("claude-3-haiku-judge");
    expect(scorer.config.name).toBe("llm-judge-5dim");
  });

  it("records token counts in result.tokenUsage", async () => {
    const response = make5DimResponse();
    const llm = vi.fn().mockResolvedValue(response);
    const scorer = makeJudgeScorer(llm);
    const result = await scorer.score(
      "detailed question here",
      "detailed answer here"
    );
    expect(result.tokenUsage!.promptTokens).toBeGreaterThan(0);
    expect(result.tokenUsage!.completionTokens).toBeGreaterThan(0);
    expect(result.tokenUsage!.totalTokens).toBe(
      result.tokenUsage!.promptTokens + result.tokenUsage!.completionTokens
    );
  });

  it("accumulates total token count across multiple evaluations", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const [r1, r2] = await Promise.all([
      scorer.score("Q1", "A1"),
      scorer.score("Q2", "A2"),
    ]);
    const total = scorer.totalTokenUsage;
    const sumFromResults =
      (r1.tokenUsage?.totalTokens ?? 0) + (r2.tokenUsage?.totalTokens ?? 0);
    expect(total.totalTokens).toBe(sumFromResults);
  });

  it("fires onTokenUsage callback with usage per evaluation", async () => {
    const usages: JudgeTokenUsage[] = [];
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse()),
      {
        onTokenUsage: (u) => usages.push(u),
      }
    );
    await scorer.score("Q1", "A1");
    await scorer.score("Q2", "A2");
    expect(usages).toHaveLength(2);
    for (const u of usages) {
      expect(u.promptTokens).toBeGreaterThan(0);
      expect(u.completionTokens).toBeGreaterThan(0);
    }
  });

  it("records durationMs in ScorerResult from EvalInput interface", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const result = await scorer.score({ input: "q", output: "a" });
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("scorerId in ScorerResult matches configured id", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse()),
      {
        id: "my-eval-judge",
      }
    );
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.scorerId).toBe("my-eval-judge");
  });

  it("costCents is estimated from token usage", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.costCents).toBeDefined();
    expect(result.costCents).toBeGreaterThanOrEqual(0);
  });

  it("longer prompts produce higher token counts than short prompts", async () => {
    const scorer = makeJudgeScorer(
      vi.fn().mockResolvedValue(make5DimResponse())
    );
    const shortResult = await scorer.score("Q", "A");
    const longResult = await scorer.score("Q".repeat(500), "A".repeat(500));
    expect(longResult.tokenUsage!.promptTokens).toBeGreaterThan(
      shortResult.tokenUsage!.promptTokens
    );
  });
});

// ---------------------------------------------------------------------------
// 16. Enhanced judge — scoring pipeline edge cases
// ---------------------------------------------------------------------------

describe("createLLMJudge — additional pipeline edge cases", () => {
  it("uses default id when none provided", () => {
    const scorer = createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(scorer.config.id).toBeDefined();
    expect(typeof scorer.config.id).toBe("string");
  });

  it("scorer type is llm-judge", () => {
    const scorer = createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(scorer.config.type).toBe("llm-judge");
  });

  it("accepts reference field in EvalInput and includes it in result", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "accuracy", description: "Accuracy", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["accuracy"], [0.9]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({
      input: "Q",
      output: "A",
      reference: "ref answer",
    });
    expect(result.aggregateScore).toBeCloseTo(0.9, 3);
  });

  it("prompt contains reference text when provided", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "q", description: "Q", weight: 1 },
    ];
    const llm = vi.fn().mockResolvedValue(makeEnhancedResponse(["q"], [0.8]));
    const scorer = createLLMJudge({ criteria, llm });
    await scorer.score({ input: "Q", output: "A", reference: "THE REFERENCE" });
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("THE REFERENCE");
  });

  it("prompt does not contain reference section when reference is absent", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "q", description: "Q", weight: 1 },
    ];
    const llm = vi.fn().mockResolvedValue(makeEnhancedResponse(["q"], [0.8]));
    const scorer = createLLMJudge({ criteria, llm });
    await scorer.score({ input: "Q", output: "A" });
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("\nReference:");
  });

  it("passes scored criteria to scoring result", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "c1", description: "C1", weight: 1 },
      { name: "c2", description: "C2", weight: 1 },
    ];
    const llm = vi
      .fn()
      .mockResolvedValue(makeEnhancedResponse(["c1", "c2"], [0.7, 0.9]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    expect(result.scores).toHaveLength(2);
  });

  it("missing criterion from LLM response is padded with 0 score", async () => {
    // Judge only returns c1, not c2
    const criteria: JudgeCriterion[] = [
      { name: "c1", description: "C1", weight: 1 },
      { name: "c2", description: "C2", weight: 1 },
    ];
    const llm = vi.fn().mockResolvedValue(makeEnhancedResponse(["c1"], [0.8]));
    const scorer = createLLMJudge({ criteria, llm });
    const result = await scorer.score({ input: "q", output: "a" });
    const c2Score = result.scores.find((s) => s.criterion === "c2");
    expect(c2Score).toBeDefined();
    expect(c2Score!.score).toBe(0);
  });

  it("custom prompt template is used instead of default", async () => {
    const criteria: JudgeCriterion[] = [
      { name: "q", description: "Q", weight: 1 },
    ];
    const customTemplate =
      "CUSTOM TEMPLATE: {{input}} vs {{output}}. Criteria: {{criteria}}{{reference}}";
    const llm = vi.fn().mockResolvedValue(makeEnhancedResponse(["q"], [0.7]));
    const scorer = createLLMJudge({
      criteria,
      llm,
      promptTemplate: customTemplate,
    });
    await scorer.score({ input: "MY_INPUT", output: "MY_OUTPUT" });
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain("CUSTOM TEMPLATE");
    expect(prompt).toContain("MY_INPUT");
    expect(prompt).toContain("MY_OUTPUT");
  });
});
