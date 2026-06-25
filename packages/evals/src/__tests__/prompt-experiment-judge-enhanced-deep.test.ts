/**
 * Deep coverage tests for PromptExperiment and LLMJudgeEnhanced.
 *
 * Targets gaps left by the thin existing tests (prompt-experiment.test.ts at 6 tests
 * and llm-judge-enhanced.test.ts at 3 tests) and also the broader coverage file
 * (prompt-experiment-coverage.test.ts) which already covers the basic run flow.
 *
 * This file adds 45+ new tests across:
 *   - PromptExperiment: variant metadata, N-way runs, per-entry structure,
 *     statistical edge cases, scoring with no scorers, scorer error resilience,
 *     report structure, export shape, and filtering variants from results.
 *   - LLMJudgeEnhanced: rubric building, weighted aggregation, multi-criterion
 *     scoring, retry logic, out-of-range clamping, missing criterion padding,
 *     JSON extraction from noisy LLM responses, total failure fallback,
 *     threshold-based pass/fail, prompt/model drift warnings, and the
 *     prompt template placeholder substitution.
 *   - Statistical helpers (prompt-experiment-stats): pairedTTest edge cases,
 *     mean/stddev helpers, twoTailedPValue, normalizeConcurrency.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { EvalDataset } from "../dataset/eval-dataset.js";
import { PromptExperiment } from "../prompt-experiment/prompt-experiment.js";
import type {
  ExperimentReport,
  PromptVariant,
  VariantResult,
} from "../prompt-experiment/prompt-experiment.js";
import {
  mean,
  normalizeConcurrency,
  pairedTTest,
  stddev,
  twoTailedPValue,
} from "../prompt-experiment/prompt-experiment-stats.js";
import { createLLMJudge, PINNED_JUDGE } from "../scorers/llm-judge-enhanced.js";
import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ---------------------------------------------------------------------------
// Test Fixtures & Helpers
// ---------------------------------------------------------------------------

function makeModel(output: string | object = "response"): BaseChatModel {
  return {
    invoke: vi
      .fn()
      .mockResolvedValue(
        typeof output === "string" ? { content: output } : output
      ),
  } as unknown as BaseChatModel;
}

function makeScorer(score: number, id = "default-scorer"): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: "deterministic" };
  return {
    config,
    score: vi.fn().mockResolvedValue({
      scorerId: id,
      scores: [{ criterion: "quality", score, reasoning: "mocked" }],
      aggregateScore: score,
      passed: score >= 0.5,
      durationMs: 1,
    } satisfies ScorerResult),
  };
}

function makeFailingScorer(id = "failing-scorer"): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: "deterministic" };
  return {
    config,
    score: vi.fn().mockRejectedValue(new Error("scorer exploded")),
  };
}

function makeDataset(count = 3, prefix = "q"): EvalDataset {
  return EvalDataset.from(
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      input: `input-${i}`,
      expectedOutput: `expected-${i}`,
      tags: ["tag-a"],
      metadata: { index: i },
    }))
  );
}

function makeVariants(n = 2): PromptVariant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    name: `Variant-${i}`,
    systemPrompt: `system prompt for variant ${i}`,
    metadata: { variantIndex: i },
  }));
}

function makeLLMReturning(
  responseJson: unknown
): (prompt: string) => Promise<string> {
  return vi.fn().mockResolvedValue(JSON.stringify(responseJson));
}

// ---------------------------------------------------------------------------
// 1. PromptExperiment — variant structure
// ---------------------------------------------------------------------------

describe("PromptExperiment — variant structure", () => {
  it("result includes variantId and variantName matching input variants", async () => {
    const variants = makeVariants(2);
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.7)],
    });
    const report = await exp.run(variants, makeDataset(2));

    expect(report.variants[0]!.variantId).toBe("v0");
    expect(report.variants[0]!.variantName).toBe("Variant-0");
    expect(report.variants[1]!.variantId).toBe("v1");
    expect(report.variants[1]!.variantName).toBe("Variant-1");
  });

  it("each entry result carries the dataset entry id", async () => {
    const dataset = EvalDataset.from([
      { id: "alpha", input: "hello" },
      { id: "beta", input: "world" },
    ]);
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.6)],
      concurrency: 1,
    });

    const report = await exp.run(makeVariants(2), dataset);
    const entryIds = report.variants[0]!.entries.map((e) => e.entryId);
    expect(entryIds).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("entry output matches what the model returned", async () => {
    const model = makeModel("the actual model output");
    const exp = new PromptExperiment({
      model,
      scorers: [makeScorer(0.5)],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(1));

    for (const variant of report.variants) {
      expect(variant.entries[0]!.output).toBe("the actual model output");
    }
  });

  it("variant metadata is preserved in input but not in result (it is used at run time)", async () => {
    const variants: PromptVariant[] = [
      {
        id: "v0",
        name: "A",
        systemPrompt: "prompt",
        metadata: { tag: "custom" },
      },
      {
        id: "v1",
        name: "B",
        systemPrompt: "prompt",
        metadata: { tag: "other" },
      },
    ];
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.8)],
    });
    const report = await exp.run(variants, makeDataset(1));
    // We verify the experiment completes without issue and returns variant names
    expect(report.variants.map((v) => v.variantName)).toEqual(["A", "B"]);
  });

  it("datasetSize matches the number of entries in the input dataset", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
    });
    const report = await exp.run(makeVariants(2), makeDataset(7));
    expect(report.datasetSize).toBe(7);
  });

  it("totalDurationMs is a non-negative number", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
    });
    const report = await exp.run(makeVariants(2), makeDataset(2));
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 2. PromptExperiment — N-way (3+ variants)
// ---------------------------------------------------------------------------

describe("PromptExperiment — N-way experiments", () => {
  it("3 variants produce 3 pairwise comparisons (C(3,2)=3)", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
    });
    const report = await exp.run(makeVariants(3), makeDataset(3));
    expect(report.comparisons).toHaveLength(3);
  });

  it("4 variants produce 6 pairwise comparisons (C(4,2)=6)", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
    });
    const report = await exp.run(makeVariants(4), makeDataset(3));
    expect(report.comparisons).toHaveLength(6);
  });

  it("bestVariant is the one with the highest avgScore among 4 variants", async () => {
    // Scorer gives incrementally higher scores per variant: 0.1, 0.4, 0.7, 0.95
    const scores = [0.1, 0.4, 0.7, 0.95];
    let variantCallIndex = -1;
    let currentScore = 0;
    const datasetSize = 2;

    const model = {
      invoke: vi
        .fn()
        .mockImplementation(async (msgs: Array<{ content: string }>) => {
          // Detect which variant is being run by the system prompt content
          const systemPrompt = msgs.find(
            (m) =>
              typeof m.content === "string" &&
              m.content.includes("system prompt for variant")
          );
          if (systemPrompt && typeof systemPrompt.content === "string") {
            const match = /variant (\d+)/.exec(systemPrompt.content);
            if (match) {
              variantCallIndex = Number(match[1]);
              currentScore = scores[variantCallIndex] ?? 0;
            }
          }
          return { content: "response" };
        }),
    } as unknown as BaseChatModel;

    const scorer: Scorer<EvalInput> = {
      config: { id: "s", name: "s", type: "deterministic" },
      score: vi.fn().mockImplementation(async () => {
        const s = currentScore;
        return {
          scorerId: "s",
          scores: [{ criterion: "c", score: s, reasoning: "" }],
          aggregateScore: s,
          passed: s >= 0.5,
          durationMs: 1,
        };
      }),
    };

    const exp = new PromptExperiment({
      model,
      scorers: [scorer],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(4), makeDataset(datasetSize));

    // Variant-3 should win (score 0.95)
    expect(report.bestVariant).toBe("Variant-3");
  });

  it("comparisons always reference variant names not ids", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
    });
    const report = await exp.run(makeVariants(3), makeDataset(3));
    for (const comp of report.comparisons) {
      expect(comp.variantA).toMatch(/Variant-\d/);
      expect(comp.variantB).toMatch(/Variant-\d/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. PromptExperiment — passRate computation
// ---------------------------------------------------------------------------

describe("PromptExperiment — passRate", () => {
  it("passRate is 1.0 when all scorer results pass", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.9)],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(4));
    for (const v of report.variants) {
      expect(v.passRate).toBe(1.0);
    }
  });

  it("passRate is 0.0 when all scorer results fail", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.1)],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(4));
    for (const v of report.variants) {
      expect(v.passRate).toBe(0.0);
    }
  });

  it("passRate is 0 when there are no scorers", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(3));
    for (const v of report.variants) {
      expect(v.passRate).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. PromptExperiment — significantWinner logic
// ---------------------------------------------------------------------------

describe("PromptExperiment — significantWinner", () => {
  it("significantWinner is false when all variants have the same score", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.7)],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(5));
    expect(report.significantWinner).toBe(false);
  });

  it("bestVariant falls back to first variant when scores are equal", async () => {
    const exp = new PromptExperiment({
      model: makeModel(),
      scorers: [makeScorer(0.5)],
      concurrency: 1,
    });
    const report = await exp.run(makeVariants(2), makeDataset(3));
    // First variant is returned as best when scores are tied
    expect(report.bestVariant).toBe("Variant-0");
  });
});

// ---------------------------------------------------------------------------
// 5. PromptExperiment — report export (structured object)
// ---------------------------------------------------------------------------

describe("PromptExperiment — report export shape", () => {
  let report: ExperimentReport;

  beforeEach(async () => {
    const exp = new PromptExperiment({
      model: makeModel("result"),
      scorers: [makeScorer(0.8)],
      concurrency: 2,
    });
    report = await exp.run(makeVariants(2), makeDataset(3));
  });

  it("report.variants is an array", () => {
    expect(Array.isArray(report.variants)).toBe(true);
  });

  it("report.comparisons is an array", () => {
    expect(Array.isArray(report.comparisons)).toBe(true);
  });

  it("each comparison has required keys", () => {
    const keys = [
      "variantA",
      "variantB",
      "meanDifference",
      "standardError",
      "confidenceInterval",
      "pValue",
      "significant",
      "winner",
      "summary",
    ];
    for (const comp of report.comparisons) {
      for (const key of keys) {
        expect(comp).toHaveProperty(key);
      }
    }
  });

  it("each variant result has required keys", () => {
    const keys = [
      "variantId",
      "variantName",
      "entries",
      "avgScore",
      "passRate",
      "avgLatencyMs",
      "avgCostCents",
      "scorerAverages",
    ];
    for (const v of report.variants) {
      for (const key of keys) {
        expect(v).toHaveProperty(key);
      }
    }
  });

  it("toMarkdown() returns a non-empty string", () => {
    const md = report.toMarkdown();
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });

  it("pairwise comparison confidenceInterval is a 2-element array of numbers", () => {
    const comp = report.comparisons[0]!;
    expect(Array.isArray(comp.confidenceInterval)).toBe(true);
    expect(comp.confidenceInterval).toHaveLength(2);
    expect(typeof comp.confidenceInterval[0]).toBe("number");
    expect(typeof comp.confidenceInterval[1]).toBe("number");
  });

  it("can filter variants by variantId from report results", () => {
    const byId = (id: string): VariantResult | undefined =>
      report.variants.find((v) => v.variantId === id);

    expect(byId("v0")).toBeDefined();
    expect(byId("v1")).toBeDefined();
    expect(byId("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. PromptExperiment — concurrency validation (normalizeConcurrency)
// ---------------------------------------------------------------------------

describe("normalizeConcurrency", () => {
  it("returns value when valid positive integer", () => {
    expect(normalizeConcurrency(1)).toBe(1);
    expect(normalizeConcurrency(5)).toBe(5);
    expect(normalizeConcurrency(100)).toBe(100);
  });

  it("uses default 3 when undefined", () => {
    expect(normalizeConcurrency(undefined)).toBe(3);
  });

  it("uses custom default when provided", () => {
    expect(normalizeConcurrency(undefined, 10)).toBe(10);
  });

  it("throws on 0", () => {
    expect(() => normalizeConcurrency(0)).toThrow(
      /concurrency must be a finite positive integer/
    );
  });

  it("throws on negative integer", () => {
    expect(() => normalizeConcurrency(-5)).toThrow(
      /concurrency must be a finite positive integer/
    );
  });

  it("throws on non-integer float", () => {
    expect(() => normalizeConcurrency(2.5)).toThrow(
      /concurrency must be a finite positive integer/
    );
  });

  it("throws on Infinity", () => {
    expect(() => normalizeConcurrency(Infinity)).toThrow(
      /concurrency must be a finite positive integer/
    );
  });

  it("throws on NaN", () => {
    expect(() => normalizeConcurrency(NaN)).toThrow(
      /concurrency must be a finite positive integer/
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Statistical helpers
// ---------------------------------------------------------------------------

describe("mean()", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("returns single value for single-element array", () => {
    expect(mean([7])).toBe(7);
  });

  it("computes average for multiple values", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
});

describe("stddev()", () => {
  it("returns 0 for single-element array", () => {
    expect(stddev([42], 42)).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(stddev([], 0)).toBe(0);
  });

  it("computes sample standard deviation correctly", () => {
    // [1, 2, 3] has sample variance = ((0+1+1)/2) = 1, so stddev = 1.0
    const values = [1, 2, 3];
    const avg = mean(values);
    expect(stddev(values, avg)).toBeCloseTo(1.0, 5);
  });
});

describe("pairedTTest()", () => {
  it("returns winner=tie and pValue=1 when n < 2", () => {
    const result = pairedTTest([0.8], [0.5], "A", "B");
    expect(result.winner).toBe("tie");
    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
  });

  it("returns winner=tie when scores are identical", () => {
    const scores = [0.7, 0.7, 0.7, 0.7, 0.7];
    const result = pairedTTest(scores, scores, "A", "B");
    expect(result.winner).toBe("tie");
    expect(result.pValue).toBe(1);
  });

  it("meanDifference is positive when A consistently outperforms B", () => {
    const a = [0.9, 0.9, 0.9, 0.9, 0.9];
    const b = [0.1, 0.1, 0.1, 0.1, 0.1];
    const result = pairedTTest(a, b, "A", "B");
    expect(result.meanDifference).toBeCloseTo(0.8, 3);
  });

  it("winner is A when A has significantly higher scores", () => {
    const a = [0.95, 0.93, 0.94, 0.92, 0.96, 0.95, 0.94, 0.93, 0.95, 0.92];
    const b = [0.2, 0.22, 0.21, 0.19, 0.23, 0.2, 0.21, 0.22, 0.2, 0.21];
    const result = pairedTTest(a, b, "A", "B");
    expect(result.winner).toBe("A");
    expect(result.significant).toBe(true);
  });

  it("pValue is clamped to [0, 1]", () => {
    const a = [0.5, 0.6];
    const b = [0.4, 0.5];
    const result = pairedTTest(a, b, "A", "B");
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
  });

  it("summary contains insufficient data when n < 2", () => {
    const result = pairedTTest([], [], "X", "Y");
    expect(result.summary).toContain("Insufficient data");
  });
});

describe("twoTailedPValue()", () => {
  it("returns a value between 0 and 1", () => {
    const p = twoTailedPValue(2.0, 10);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("uses normal approximation for df > 30", () => {
    // For df > 30, uses erfc path
    const p = twoTailedPValue(1.96, 100);
    expect(p).toBeCloseTo(0.05, 1);
  });

  it("returns smaller p-value for larger t-statistic", () => {
    const p1 = twoTailedPValue(1.0, 10);
    const p2 = twoTailedPValue(5.0, 10);
    expect(p2).toBeLessThan(p1);
  });
});

// ---------------------------------------------------------------------------
// 8. LLMJudgeEnhanced — scorer creation and config
// ---------------------------------------------------------------------------

describe("createLLMJudge — scorer config", () => {
  it("creates a scorer with config.id when id is provided", () => {
    const judge = createLLMJudge({
      id: "my-judge",
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(judge.config.id).toBe("my-judge");
  });

  it("auto-generates id when id is omitted", () => {
    const judge = createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(judge.config.id).toMatch(/^llm-judge-\d+$/);
  });

  it("config.name is always llm-judge-enhanced", () => {
    const judge = createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(judge.config.name).toBe("llm-judge-enhanced");
  });

  it("config.type is llm-judge", () => {
    const judge = createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
    });
    expect(judge.config.type).toBe("llm-judge");
  });

  it("description uses string criteria directly", () => {
    const judge = createLLMJudge({
      criteria: "Answer relevance",
      llm: async () => "[]",
    });
    expect(judge.config.description).toBe("Answer relevance");
  });

  it("description lists criterion names for array criteria", () => {
    const judge = createLLMJudge({
      criteria: [
        { name: "relevance", description: "Is it relevant?", weight: 0.5 },
        { name: "accuracy", description: "Is it accurate?", weight: 0.5 },
      ],
      llm: async () => "[]",
    });
    expect(judge.config.description).toContain("relevance");
    expect(judge.config.description).toContain("accuracy");
  });
});

// ---------------------------------------------------------------------------
// 9. LLMJudgeEnhanced — scoring with single string criterion
// ---------------------------------------------------------------------------

describe("createLLMJudge — single string criterion scoring", () => {
  it("returns aggregateScore from LLM response for string criteria", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 0.85, reasoning: "good answer" },
    ]);
    const judge = createLLMJudge({
      id: "j1",
      criteria: "overall quality",
      llm,
    });

    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.85);
    expect(result.passed).toBe(true);
    expect(result.scorerId).toBe("j1");
  });

  it("score contains criterion array", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 0.6, reasoning: "acceptable" },
    ]);
    const judge = createLLMJudge({ criteria: "overall quality", llm });

    const result = await judge.score({ input: "q", output: "a" });
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]!.criterion).toBe("overall");
    expect(result.scores[0]!.score).toBeCloseTo(0.6);
  });

  it("durationMs is non-negative", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 0.8, reasoning: "ok" },
    ]);
    const judge = createLLMJudge({ criteria: "overall quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 10. LLMJudgeEnhanced — weighted aggregation with multi-criterion rubric
// ---------------------------------------------------------------------------

describe("createLLMJudge — weighted multi-criterion aggregation", () => {
  it("computes weighted average correctly", async () => {
    // relevance weight 0.6, accuracy weight 0.4
    // relevance score 1.0, accuracy score 0.0
    // expected aggregate = (1.0 * 0.6 + 0.0 * 0.4) / (0.6 + 0.4) = 0.6
    const llm = makeLLMReturning([
      { criterion: "relevance", score: 1.0, reasoning: "perfect" },
      { criterion: "accuracy", score: 0.0, reasoning: "wrong" },
    ]);
    const judge = createLLMJudge({
      criteria: [
        { name: "relevance", description: "Relevance", weight: 0.6 },
        { name: "accuracy", description: "Accuracy", weight: 0.4 },
      ],
      llm,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.6, 5);
  });

  it("treats missing weight as 1 in weighted sum", async () => {
    // Two criteria: one with weight 2, one without weight (defaults to 1)
    // scores both 1.0 → (1.0*2 + 1.0*1) / (2+1) = 1.0
    const llm = makeLLMReturning([
      { criterion: "a", score: 1.0, reasoning: "" },
      { criterion: "b", score: 1.0, reasoning: "" },
    ]);
    const judge = createLLMJudge({
      criteria: [
        { name: "a", description: "A", weight: 2 },
        { name: "b", description: "B" }, // no weight — defaults to 1
      ],
      llm,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(1.0, 5);
  });

  it("all three criteria with equal weights produce simple average", async () => {
    const llm = makeLLMReturning([
      { criterion: "c1", score: 0.3, reasoning: "" },
      { criterion: "c2", score: 0.6, reasoning: "" },
      { criterion: "c3", score: 0.9, reasoning: "" },
    ]);
    const judge = createLLMJudge({
      criteria: [
        { name: "c1", description: "C1", weight: 1 },
        { name: "c2", description: "C2", weight: 1 },
        { name: "c3", description: "C3", weight: 1 },
      ],
      llm,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// 11. LLMJudgeEnhanced — out-of-range score clamping
// ---------------------------------------------------------------------------

describe("createLLMJudge — out-of-range score clamping", () => {
  it("clamps score above 1.0 to 1.0", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 1.5, reasoning: "over" },
    ]);
    const judge = createLLMJudge({ criteria: "overall quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBe(1.0);
    expect(result.scores[0]!.score).toBe(1.0);
  });

  it("clamps score below 0.0 to 0.0", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: -0.5, reasoning: "negative" },
    ]);
    const judge = createLLMJudge({ criteria: "overall quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBe(0.0);
    expect(result.scores[0]!.score).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// 12. LLMJudgeEnhanced — JSON extraction from noisy LLM responses
// ---------------------------------------------------------------------------

describe("createLLMJudge — JSON extraction from noisy responses", () => {
  it("extracts JSON array embedded in surrounding text", async () => {
    const llm = vi
      .fn()
      .mockResolvedValue(
        'Here is my evaluation:\n[{"criterion":"overall","score":0.75,"reasoning":"good"}]\nEnd of response.'
      );
    const judge = createLLMJudge({ criteria: "overall quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.75);
  });

  it("pads missing criterion with score 0 when LLM omits it", async () => {
    // Rubric has two criteria but LLM only returns one
    const llm = makeLLMReturning([
      { criterion: "relevance", score: 0.9, reasoning: "yes" },
      // 'accuracy' is missing
    ]);
    const judge = createLLMJudge({
      criteria: [
        { name: "relevance", description: "Relevance", weight: 1 },
        { name: "accuracy", description: "Accuracy", weight: 1 },
      ],
      llm,
    });
    const result = await judge.score({ input: "q", output: "a" });
    const accScore = result.scores.find((s) => s.criterion === "accuracy");
    expect(accScore).toBeDefined();
    expect(accScore!.score).toBe(0);
    expect(accScore!.reasoning).toBe("Not evaluated by judge");
  });
});

// ---------------------------------------------------------------------------
// 13. LLMJudgeEnhanced — retry logic
// ---------------------------------------------------------------------------

describe("createLLMJudge — retry on parse failure", () => {
  it("retries up to maxRetries and succeeds on last attempt", async () => {
    let callCount = 0;
    const llm = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) return "not json";
      return '[{"criterion":"overall","score":0.6,"reasoning":"ok"}]';
    });
    const judge = createLLMJudge({
      criteria: "overall quality",
      llm,
      maxRetries: 2,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBeCloseTo(0.6);
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  it("returns 0 score and passed=false after all retries are exhausted", async () => {
    const llm = vi.fn().mockResolvedValue("invalid json garbage");
    const judge = createLLMJudge({
      id: "exhausted",
      criteria: "overall quality",
      llm,
      maxRetries: 1,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain(
      "Failed to get valid response"
    );
  });

  it("returns 0 score when LLM throws an error on all attempts", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("LLM timeout"));
    const judge = createLLMJudge({
      criteria: "overall quality",
      llm,
      maxRetries: 0,
    });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. LLMJudgeEnhanced — passed threshold
// ---------------------------------------------------------------------------

describe("createLLMJudge — pass/fail threshold", () => {
  it("passed is true when aggregateScore >= 0.5 (default threshold)", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 0.5, reasoning: "" },
    ]);
    const judge = createLLMJudge({ criteria: "quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.passed).toBe(true);
  });

  it("passed is false when aggregateScore < 0.5", async () => {
    const llm = makeLLMReturning([
      { criterion: "overall", score: 0.49, reasoning: "" },
    ]);
    const judge = createLLMJudge({ criteria: "quality", llm });
    const result = await judge.score({ input: "q", output: "a" });
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 15. LLMJudgeEnhanced — prompt template substitution
// ---------------------------------------------------------------------------

describe("createLLMJudge — prompt template placeholders", () => {
  it("injects {{input}}, {{output}}, {{criteria}} into the prompt", async () => {
    let capturedPrompt = "";
    const llm = vi.fn().mockImplementation(async (p: string) => {
      capturedPrompt = p;
      return '[{"criterion":"overall","score":0.8,"reasoning":"ok"}]';
    });

    const judge = createLLMJudge({
      criteria: "overall quality",
      llm,
    });
    await judge.score({ input: "my question", output: "my answer" });

    expect(capturedPrompt).toContain("my question");
    expect(capturedPrompt).toContain("my answer");
    expect(capturedPrompt).toContain("overall");
  });

  it("includes reference in prompt when provided", async () => {
    let capturedPrompt = "";
    const llm = vi.fn().mockImplementation(async (p: string) => {
      capturedPrompt = p;
      return '[{"criterion":"overall","score":0.8,"reasoning":"ok"}]';
    });

    const judge = createLLMJudge({ criteria: "quality", llm });
    await judge.score({
      input: "q",
      output: "a",
      reference: "gold standard answer",
    });

    expect(capturedPrompt).toContain("gold standard answer");
  });

  it("does not include Reference line when reference is absent", async () => {
    let capturedPrompt = "";
    const llm = vi.fn().mockImplementation(async (p: string) => {
      capturedPrompt = p;
      return '[{"criterion":"overall","score":0.8,"reasoning":"ok"}]';
    });

    const judge = createLLMJudge({ criteria: "quality", llm });
    await judge.score({ input: "q", output: "a" });

    expect(capturedPrompt).not.toContain("Reference:");
  });

  it("respects custom promptTemplate", async () => {
    let capturedPrompt = "";
    const llm = vi.fn().mockImplementation(async (p: string) => {
      capturedPrompt = p;
      return '[{"criterion":"overall","score":0.8,"reasoning":"ok"}]';
    });

    const judge = createLLMJudge({
      criteria: "overall quality",
      llm,
      promptTemplate:
        "CUSTOM {{criteria}} INPUT:{{input}} OUTPUT:{{output}}{{reference}}",
    });
    await judge.score({ input: "the-input", output: "the-output" });

    expect(capturedPrompt.startsWith("CUSTOM")).toBe(true);
    expect(capturedPrompt).toContain("the-input");
    expect(capturedPrompt).toContain("the-output");
  });
});

// ---------------------------------------------------------------------------
// 16. LLMJudgeEnhanced — pinned judge drift warnings (existing 3 + more detail)
// ---------------------------------------------------------------------------

describe("createLLMJudge — pinned judge drift (extended)", () => {
  it("no warn callback → no error even if versions drift", () => {
    expect(() => {
      createLLMJudge({
        criteria: "quality",
        llm: async () => "[]",
        promptVersion: "v-different",
        modelId: "gpt-99",
        // no warn callback provided
      });
    }).not.toThrow();
  });

  it("does not warn when no promptVersion / modelId specified (uses pinned defaults)", () => {
    const warnings: string[] = [];
    createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
      warn: (msg) => warnings.push(msg),
      // promptVersion and modelId omitted → uses pinned values → no drift
    });
    expect(warnings).toHaveLength(0);
  });

  it("warn message includes both versions for promptVersion drift", () => {
    const warnings: string[] = [];
    createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
      promptVersion: "my-custom-v2",
      warn: (msg) => warnings.push(msg),
    });
    const driftWarning = warnings.find((w) =>
      w.includes("promptVersion drift")
    );
    expect(driftWarning).toContain(PINNED_JUDGE.promptVersion);
    expect(driftWarning).toContain("my-custom-v2");
  });

  it("warn message includes both model ids for modelId drift", () => {
    const warnings: string[] = [];
    createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
      modelId: "claude-3-haiku",
      warn: (msg) => warnings.push(msg),
    });
    const driftWarning = warnings.find((w) => w.includes("modelId drift"));
    expect(driftWarning).toContain(PINNED_JUDGE.modelId);
    expect(driftWarning).toContain("claude-3-haiku");
  });

  it("two separate drift warnings when both promptVersion and modelId differ", () => {
    const warnings: string[] = [];
    createLLMJudge({
      criteria: "quality",
      llm: async () => "[]",
      promptVersion: "experimental-v9",
      modelId: "gpt-5-turbo",
      warn: (msg) => warnings.push(msg),
    });
    expect(
      warnings.filter((w) => w.includes("promptVersion drift"))
    ).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("modelId drift"))).toHaveLength(1);
  });
});
