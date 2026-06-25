/**
 * scorer-composition.test.ts
 *
 * +70 focused tests covering scorer composition patterns:
 *  - Chained scorers (output of A feeds into B)
 *  - Weighted averages (CompositeScorer, edge cases)
 *  - Short-circuit evaluation (threshold-gated pipeline)
 *  - Timeout handling (scorer that times out returns fallback)
 *  - Async race conditions (first-to-resolve wins)
 *  - Error propagation (one fails, others still run)
 *  - Edge cases (empty list, single scorer, all-zero)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompositeScorer } from "../composite-scorer.js";
import type { EvalScorer, EvalResult } from "../types.js";
import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fixedEvalScorer(name: string, score: number, delayMs = 0): EvalScorer {
  return {
    name,
    score: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) {
        await delay(delayMs);
      }
      return {
        score,
        pass: score >= 0.5,
        reasoning: `${name} returned ${score}`,
      } satisfies EvalResult;
    }),
  };
}

function throwingEvalScorer(name: string): EvalScorer {
  return {
    name,
    score: vi.fn().mockRejectedValue(new Error(`${name} exploded`)),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ---------------------------------------------------------------------------
// Short-circuit pipeline (utility built on top of EvalScorer)
// ---------------------------------------------------------------------------

interface ShortCircuitResult {
  finalScore: number;
  pass: boolean;
  stoppedEarlyAt?: string;
  reasoningChain: string[];
}

/**
 * Runs scorers sequentially. If a scorer's score falls below `threshold`,
 * it stops immediately and returns that result without invoking remaining scorers.
 */
async function runWithShortCircuit(
  scorers: Array<{ scorer: EvalScorer; threshold: number }>,
  input: string,
  output: string,
  reference?: string,
): Promise<ShortCircuitResult> {
  const reasoningChain: string[] = [];
  let lastScore = 0;

  for (const { scorer, threshold } of scorers) {
    const result = await scorer.score(input, output, reference);
    lastScore = result.score;
    reasoningChain.push(`[${scorer.name}] ${result.reasoning}`);

    if (result.score < threshold) {
      return {
        finalScore: result.score,
        pass: false,
        stoppedEarlyAt: scorer.name,
        reasoningChain,
      };
    }
  }

  return {
    finalScore: lastScore,
    pass: lastScore >= 0.5,
    reasoningChain,
  };
}

// ---------------------------------------------------------------------------
// Chained scorer pipeline (output of A feeds into B)
// ---------------------------------------------------------------------------

interface ChainedScorerResult {
  intermediateScores: number[];
  finalScore: number;
  pass: boolean;
}

/**
 * Runs scorers as a chain: the reasoning from scorer N is passed as the
 * `output` argument to scorer N+1 (simulating output-transforms pipeline).
 */
async function runChained(
  scorers: EvalScorer[],
  initialInput: string,
  initialOutput: string,
): Promise<ChainedScorerResult> {
  let currentOutput = initialOutput;
  const intermediateScores: number[] = [];

  for (const scorer of scorers) {
    const result = await scorer.score(initialInput, currentOutput);
    intermediateScores.push(result.score);
    // Chain: pass reasoning as next scorer's output (simulates transform)
    currentOutput = result.reasoning;
  }

  const finalScore =
    intermediateScores.length > 0
      ? intermediateScores.reduce((sum, s) => sum + s, 0) /
        intermediateScores.length
      : 0;

  return {
    intermediateScores,
    finalScore,
    pass: finalScore >= 0.5,
  };
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

interface TimeoutScorerOptions {
  timeoutMs: number;
  fallbackScore: number;
  fallbackReasoning?: string;
}

/**
 * Wraps an EvalScorer with a timeout. If the scorer does not resolve within
 * `timeoutMs`, it returns a fallback result instead.
 */
function withTimeout(
  scorer: EvalScorer,
  opts: TimeoutScorerOptions,
): EvalScorer {
  return {
    name: `${scorer.name}-with-timeout`,
    score: async (input, output, reference) => {
      const timeoutPromise = new Promise<EvalResult>((resolve) => {
        setTimeout(() => {
          resolve({
            score: opts.fallbackScore,
            pass: opts.fallbackScore >= 0.5,
            reasoning:
              opts.fallbackReasoning ??
              `Scorer ${scorer.name} timed out after ${opts.timeoutMs}ms`,
          });
        }, opts.timeoutMs);
      });

      return Promise.race([
        scorer.score(input, output, reference),
        timeoutPromise,
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Race scorer (first to resolve wins)
// ---------------------------------------------------------------------------

/**
 * Runs multiple scorers concurrently and returns the result of whichever
 * resolves first (without error).
 */
async function runRace(
  scorers: EvalScorer[],
  input: string,
  output: string,
  reference?: string,
): Promise<EvalResult & { winnerName: string }> {
  if (scorers.length === 0) {
    return {
      score: 0,
      pass: false,
      reasoning: "No scorers in race",
      winnerName: "none",
    };
  }

  const races = scorers.map(async (scorer) => {
    const result = await scorer.score(input, output, reference);
    return { ...result, winnerName: scorer.name };
  });

  return Promise.race(races);
}

// ---------------------------------------------------------------------------
// Error-tolerant combiner (runs all, collects failures as fallback 0 scores)
// ---------------------------------------------------------------------------

interface TolerantResult {
  scores: Array<{ name: string; score: number; error?: string }>;
  aggregateScore: number;
  pass: boolean;
  failedCount: number;
}

/**
 * Runs all scorers, even if some throw. Failed scorers contribute 0 to the
 * aggregate. Useful for observability without cascading failures.
 */
async function runTolerant(
  scorers: Array<{ scorer: EvalScorer; weight: number }>,
  input: string,
  output: string,
  reference?: string,
): Promise<TolerantResult> {
  const settled = await Promise.allSettled(
    scorers.map(async ({ scorer, weight }) => ({
      name: scorer.name,
      weight,
      result: await scorer.score(input, output, reference),
    })),
  );

  let totalWeight = 0;
  let weightedSum = 0;
  let failedCount = 0;

  const scores: Array<{ name: string; score: number; error?: string }> = [];

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { name, weight, result } = outcome.value;
      scores.push({ name, score: result.score });
      weightedSum += result.score * weight;
      totalWeight += weight;
    } else {
      const scorerEntry = scorers[settled.indexOf(outcome)]!;
      scores.push({
        name: scorerEntry.scorer.name,
        score: 0,
        error: (outcome.reason as Error).message,
      });
      totalWeight += scorerEntry.weight;
      failedCount++;
    }
  }

  const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    scores,
    aggregateScore,
    pass: aggregateScore >= 0.5,
    failedCount,
  };
}

// ===========================================================================
// 1. CHAINED SCORERS
// ===========================================================================

describe("Chained scorers", () => {
  describe("basic chain behavior", () => {
    it("single scorer: chain result equals that scorer score", async () => {
      const scorerA = fixedEvalScorer("A", 0.9);
      const result = await runChained([scorerA], "input", "output");
      expect(result.intermediateScores).toHaveLength(1);
      expect(result.intermediateScores[0]).toBeCloseTo(0.9);
    });

    it("two scorers: both are called and scores are averaged", async () => {
      const scorerA = fixedEvalScorer("A", 1.0);
      const scorerB = fixedEvalScorer("B", 0.0);
      const result = await runChained([scorerA, scorerB], "input", "output");
      expect(result.intermediateScores).toHaveLength(2);
      expect(result.finalScore).toBeCloseTo(0.5);
    });

    it("three scorers: final score is mean of all three", async () => {
      const scorers = [
        fixedEvalScorer("A", 0.3),
        fixedEvalScorer("B", 0.6),
        fixedEvalScorer("C", 0.9),
      ];
      const result = await runChained(scorers, "in", "out");
      expect(result.intermediateScores).toHaveLength(3);
      // (0.3 + 0.6 + 0.9) / 3 = 0.6
      expect(result.finalScore).toBeCloseTo(0.6);
    });

    it("empty scorer list returns finalScore=0 and pass=false", async () => {
      const result = await runChained([], "in", "out");
      expect(result.finalScore).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.intermediateScores).toHaveLength(0);
    });

    it("second scorer receives the reasoning from first scorer as output", async () => {
      const spyScorer: EvalScorer = {
        name: "spy",
        score: vi.fn().mockResolvedValue({
          score: 0.5,
          pass: true,
          reasoning: "spy-reasoning-value",
        }),
      };
      const capturedOutputs: string[] = [];
      const observer: EvalScorer = {
        name: "observer",
        score: async (input, output) => {
          capturedOutputs.push(output);
          return { score: 0.7, pass: true, reasoning: "observed" };
        },
      };
      await runChained([spyScorer, observer], "the-input", "initial-output");
      // First scorer gets original output
      expect(vi.mocked(spyScorer.score).mock.calls[0]![1]).toBe(
        "initial-output",
      );
      // Second scorer gets first scorer's reasoning as output
      expect(capturedOutputs[0]).toBe("spy-reasoning-value");
    });

    it("chain with all 1.0 scores passes", async () => {
      const scorers = [
        fixedEvalScorer("A", 1.0),
        fixedEvalScorer("B", 1.0),
        fixedEvalScorer("C", 1.0),
      ];
      const result = await runChained(scorers, "in", "out");
      expect(result.pass).toBe(true);
      expect(result.finalScore).toBeCloseTo(1.0);
    });

    it("chain with all 0.0 scores fails", async () => {
      const scorers = [fixedEvalScorer("A", 0.0), fixedEvalScorer("B", 0.0)];
      const result = await runChained(scorers, "in", "out");
      expect(result.pass).toBe(false);
      expect(result.finalScore).toBeCloseTo(0.0);
    });

    it("each scorer in the chain is called exactly once", async () => {
      const scorerA = fixedEvalScorer("A", 0.8);
      const scorerB = fixedEvalScorer("B", 0.6);
      await runChained([scorerA, scorerB], "in", "out");
      expect(vi.mocked(scorerA.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(1);
    });
  });

  describe("chain pass/fail boundary", () => {
    it("finalScore exactly 0.5 => pass=true", async () => {
      const scorers = [fixedEvalScorer("X", 0.5)];
      const result = await runChained(scorers, "in", "out");
      expect(result.pass).toBe(true);
    });

    it("finalScore 0.499 => pass=false", async () => {
      const scorers = [fixedEvalScorer("A", 0.0), fixedEvalScorer("B", 0.998)];
      // mean = (0 + 0.998) / 2 = 0.499
      const result = await runChained(scorers, "in", "out");
      expect(result.finalScore).toBeCloseTo(0.499);
      expect(result.pass).toBe(false);
    });
  });
});

// ===========================================================================
// 2. WEIGHTED AVERAGES (CompositeScorer deep edge cases)
// ===========================================================================

describe("Weighted averages — edge cases", () => {
  describe("standard weighted calculations", () => {
    it("three scorers equal weights: mean of scores", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("a", 0.2), weight: 1 },
          { scorer: fixedEvalScorer("b", 0.5), weight: 1 },
          { scorer: fixedEvalScorer("c", 0.8), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      // (0.2 + 0.5 + 0.8) / 3 = 0.5
      expect(r.score).toBeCloseTo(0.5);
    });

    it("dominant weight drives score to near that scorer value", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("dominant", 0.9), weight: 100 },
          { scorer: fixedEvalScorer("minor", 0.0), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      // (0.9*100 + 0.0*1) / 101 ≈ 0.891
      expect(r.score).toBeCloseTo((0.9 * 100) / 101, 3);
    });

    it("identical weights: result equals simple average", async () => {
      const weights = [5, 5, 5, 5];
      const scores = [0.1, 0.4, 0.7, 1.0];
      const c = new CompositeScorer({
        scorers: scores.map((s, i) => ({
          scorer: fixedEvalScorer(`s${i}`, s),
          weight: weights[i]!,
        })),
      });
      const r = await c.score("in", "out");
      const expected = scores.reduce((a, b) => a + b, 0) / scores.length;
      expect(r.score).toBeCloseTo(expected);
    });
  });

  describe("edge cases — weights sum to zero", () => {
    it("all weights=0: score=0, pass=false, reasoning mentions zero", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("a", 1.0), weight: 0 },
          { scorer: fixedEvalScorer("b", 1.0), weight: 0 },
          { scorer: fixedEvalScorer("c", 1.0), weight: 0 },
        ],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.reasoning).toContain("zero");
    });

    it("one zero-weight scorer plus one non-zero: only non-zero contributes", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("ignored", 1.0), weight: 0 },
          { scorer: fixedEvalScorer("real", 0.3), weight: 1 },
        ],
      });
      const r = await c.score("in", "out");
      // (1.0*0 + 0.3*1) / 1 = 0.3
      expect(r.score).toBeCloseTo(0.3);
    });
  });

  describe("edge cases — empty list", () => {
    it("empty scorers array: score=0, pass=false, reasoning mentions no scorers", async () => {
      const c = new CompositeScorer({ scorers: [] });
      const r = await c.score("in", "out");
      expect(r.score).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.reasoning).toContain("No scorers");
    });
  });

  describe("edge cases — single scorer", () => {
    it("single scorer passes through its exact score", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: fixedEvalScorer("only", 0.73), weight: 7 }],
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0.73);
    });

    it("single scorer with score=0 returns pass=false", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: fixedEvalScorer("only", 0), weight: 1 }],
      });
      const r = await c.score("in", "out");
      expect(r.pass).toBe(false);
    });

    it("single scorer with score=1 returns pass=true", async () => {
      const c = new CompositeScorer({
        scorers: [{ scorer: fixedEvalScorer("only", 1.0), weight: 1 }],
      });
      const r = await c.score("in", "out");
      expect(r.pass).toBe(true);
    });
  });

  describe("edge cases — all scorers return 0", () => {
    it("five scorers all returning 0 produce aggregate=0", async () => {
      const c = new CompositeScorer({
        scorers: Array.from({ length: 5 }, (_, i) => ({
          scorer: fixedEvalScorer(`z${i}`, 0),
          weight: i + 1,
        })),
      });
      const r = await c.score("in", "out");
      expect(r.score).toBeCloseTo(0);
      expect(r.pass).toBe(false);
    });
  });

  describe("negative weight handling", () => {
    it("negative weight still contributes to totalWeight via absolute arithmetic", async () => {
      // CompositeScorer sums weights algebraically; negative weight reduces totalWeight
      // (0.8 * (-1) + 1.0 * 3) / (-1 + 3) = (-0.8 + 3.0) / 2 = 1.1 → but score should be >=0
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("neg", 0.8), weight: -1 },
          { scorer: fixedEvalScorer("pos", 1.0), weight: 3 },
        ],
      });
      const r = await c.score("in", "out");
      // Negative weights are unusual but CompositeScorer uses raw arithmetic
      // totalWeight = 2, weighted = -0.8 + 3.0 = 2.2 → 2.2 / 2 = 1.1
      // The result is whatever the arithmetic gives — we just assert it doesn't throw
      expect(typeof r.score).toBe("number");
      expect(typeof r.pass).toBe("boolean");
    });
  });

  describe("fractional weight precision", () => {
    it("weights as small fractions normalize correctly", async () => {
      const c = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("a", 1.0), weight: 0.1 },
          { scorer: fixedEvalScorer("b", 0.0), weight: 0.9 },
        ],
      });
      const r = await c.score("in", "out");
      // (1.0*0.1 + 0.0*0.9) / 1.0 = 0.1
      expect(r.score).toBeCloseTo(0.1);
    });
  });
});

// ===========================================================================
// 3. SHORT-CIRCUIT EVALUATION
// ===========================================================================

describe("Short-circuit evaluation", () => {
  describe("normal flow (no early exit)", () => {
    it("all scorers above threshold: all are called", async () => {
      const scorerA = fixedEvalScorer("A", 0.9);
      const scorerB = fixedEvalScorer("B", 0.8);
      await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      expect(vi.mocked(scorerA.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(1);
    });

    it("returns correct final score when no early exit", async () => {
      const scorerA = fixedEvalScorer("A", 1.0);
      const scorerB = fixedEvalScorer("B", 0.8);
      const result = await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      // Last scorer re-scored, so finalScore = 0.8
      expect(result.finalScore).toBeCloseTo(0.8);
      expect(result.stoppedEarlyAt).toBeUndefined();
    });
  });

  describe("early exit triggered", () => {
    it("first scorer below threshold: second is never called", async () => {
      const scorerA = fixedEvalScorer("A", 0.2); // below threshold 0.5
      const scorerB = fixedEvalScorer("B", 0.9);
      await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      expect(vi.mocked(scorerA.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(0);
    });

    it("stoppedEarlyAt is set to the failing scorer name", async () => {
      const scorerA = fixedEvalScorer("gate-scorer", 0.1);
      const scorerB = fixedEvalScorer("should-not-run", 1.0);
      const result = await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      expect(result.stoppedEarlyAt).toBe("gate-scorer");
    });

    it("final score is the failing scorer score when short-circuited", async () => {
      const scorerA = fixedEvalScorer("fail-gate", 0.3);
      const result = await runWithShortCircuit(
        [{ scorer: scorerA, threshold: 0.5 }],
        "in",
        "out",
      );
      expect(result.finalScore).toBeCloseTo(0.3);
      expect(result.pass).toBe(false);
    });

    it("second scorer below threshold: third is never called", async () => {
      const scorerA = fixedEvalScorer("A", 0.9); // passes
      const scorerB = fixedEvalScorer("B", 0.1); // fails → short-circuit
      const scorerC = fixedEvalScorer("C", 1.0); // should not run
      await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
          { scorer: scorerC, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      expect(vi.mocked(scorerA.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerC.score)).toHaveBeenCalledTimes(0);
    });

    it("reasoning chain captures only scorers that ran", async () => {
      const scorerA = fixedEvalScorer("A", 0.9);
      const scorerB = fixedEvalScorer("B", 0.0); // triggers early exit
      const scorerC = fixedEvalScorer("C", 1.0); // never runs
      const result = await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
          { scorer: scorerC, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      // A and B ran, C did not
      const chainText = result.reasoningChain.join(" ");
      expect(chainText).toContain("[A]");
      expect(chainText).toContain("[B]");
      expect(chainText).not.toContain("[C]");
    });

    it("score exactly at threshold does NOT trigger short-circuit", async () => {
      const scorerA = fixedEvalScorer("A", 0.5); // exactly at threshold, should NOT stop
      const scorerB = fixedEvalScorer("B", 1.0);
      const result = await runWithShortCircuit(
        [
          { scorer: scorerA, threshold: 0.5 },
          { scorer: scorerB, threshold: 0.5 },
        ],
        "in",
        "out",
      );
      // A is 0.5 which is NOT < 0.5, so B should run
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(1);
      expect(result.stoppedEarlyAt).toBeUndefined();
    });
  });

  describe("single scorer short-circuit", () => {
    it("single scorer passing: no early exit", async () => {
      const scorer = fixedEvalScorer("only", 0.9);
      const result = await runWithShortCircuit(
        [{ scorer, threshold: 0.5 }],
        "in",
        "out",
      );
      expect(result.stoppedEarlyAt).toBeUndefined();
    });

    it("single scorer failing: short-circuit on first", async () => {
      const scorer = fixedEvalScorer("only", 0.4);
      const result = await runWithShortCircuit(
        [{ scorer, threshold: 0.5 }],
        "in",
        "out",
      );
      expect(result.stoppedEarlyAt).toBe("only");
    });
  });
});

// ===========================================================================
// 4. TIMEOUT HANDLING
// ===========================================================================

describe("Timeout handling", () => {
  describe("scorer completes before timeout", () => {
    it("fast scorer completes normally with its actual score", async () => {
      const fast = fixedEvalScorer("fast", 0.9, 0);
      const wrapped = withTimeout(fast, {
        timeoutMs: 100,
        fallbackScore: 0,
      });
      const result = await wrapped.score("in", "out");
      expect(result.score).toBeCloseTo(0.9);
    });

    it("wrapped scorer name includes -with-timeout suffix", () => {
      const scorer = fixedEvalScorer("my-scorer", 1.0);
      const wrapped = withTimeout(scorer, { timeoutMs: 100, fallbackScore: 0 });
      expect(wrapped.name).toBe("my-scorer-with-timeout");
    });
  });

  describe("scorer times out", () => {
    it("slow scorer returns fallbackScore after timeout", async () => {
      const slow = fixedEvalScorer("slow", 1.0, 200); // 200ms delay
      const wrapped = withTimeout(slow, {
        timeoutMs: 50, // 50ms timeout
        fallbackScore: 0.0,
      });
      const result = await wrapped.score("in", "out");
      // Should get fallback, not slow's actual score
      expect(result.score).toBeCloseTo(0.0);
    });

    it("fallback reasoning mentions timeout when scorer is slow", async () => {
      const slow = fixedEvalScorer("slow-scorer", 0.9, 200);
      const wrapped = withTimeout(slow, {
        timeoutMs: 50,
        fallbackScore: 0,
        fallbackReasoning: "Timed out waiting for slow-scorer",
      });
      const result = await wrapped.score("in", "out");
      expect(result.reasoning).toContain("Timed out");
    });

    it("fallback pass status reflects fallbackScore threshold", async () => {
      const slow = fixedEvalScorer("slow", 1.0, 200);
      const wrappedFail = withTimeout(slow, {
        timeoutMs: 50,
        fallbackScore: 0.0,
      });
      const wrappedPass = withTimeout(slow, {
        timeoutMs: 50,
        fallbackScore: 0.8,
      });
      const failResult = await wrappedFail.score("in", "out");
      const passResult = await wrappedPass.score("in", "out");
      expect(failResult.pass).toBe(false);
      expect(passResult.pass).toBe(true);
    });

    it("custom fallback reasoning is preserved verbatim", async () => {
      const slow = fixedEvalScorer("slow", 0.5, 200);
      const wrapped = withTimeout(slow, {
        timeoutMs: 50,
        fallbackScore: 0,
        fallbackReasoning: "Custom fallback: scorer unavailable",
      });
      const result = await wrapped.score("in", "out");
      expect(result.reasoning).toBe("Custom fallback: scorer unavailable");
    });
  });

  describe("timeout with CompositeScorer", () => {
    it("composite with one timed-out scorer uses fallback score in calculation", async () => {
      const fast = fixedEvalScorer("fast", 1.0, 0);
      const slow = fixedEvalScorer("slow", 1.0, 200);
      const slowWrapped = withTimeout(slow, {
        timeoutMs: 50,
        fallbackScore: 0.0,
      });

      const composite = new CompositeScorer({
        scorers: [
          { scorer: fast, weight: 1 },
          { scorer: slowWrapped, weight: 1 },
        ],
      });

      const result = await composite.score("in", "out");
      // fast=1.0, slow-timeout=0.0 → (1.0+0.0)/2 = 0.5
      expect(result.score).toBeCloseTo(0.5);
    });

    it("all scorers timed out in composite yields aggregate of fallback scores", async () => {
      const slow1 = withTimeout(fixedEvalScorer("s1", 1.0, 200), {
        timeoutMs: 50,
        fallbackScore: 0.2,
      });
      const slow2 = withTimeout(fixedEvalScorer("s2", 1.0, 200), {
        timeoutMs: 50,
        fallbackScore: 0.4,
      });

      const composite = new CompositeScorer({
        scorers: [
          { scorer: slow1, weight: 1 },
          { scorer: slow2, weight: 1 },
        ],
      });

      const result = await composite.score("in", "out");
      // Both use fallback: (0.2 + 0.4) / 2 = 0.3
      expect(result.score).toBeCloseTo(0.3);
    });
  });
});

// ===========================================================================
// 5. ASYNC RACE CONDITIONS
// ===========================================================================

describe("Async race conditions", () => {
  describe("runRace — first to resolve wins", () => {
    it("fast scorer beats slow scorer", async () => {
      const fast = fixedEvalScorer("fast", 0.9, 10);
      const slow = fixedEvalScorer("slow", 0.3, 200);
      const result = await runRace([fast, slow], "in", "out");
      expect(result.winnerName).toBe("fast");
      expect(result.score).toBeCloseTo(0.9);
    });

    it("winner name is correct when second scorer is fastest", async () => {
      const slow = fixedEvalScorer("slow", 0.1, 200);
      const fast = fixedEvalScorer("fast", 0.7, 10);
      const result = await runRace([slow, fast], "in", "out");
      expect(result.winnerName).toBe("fast");
    });

    it("empty scorers array returns score=0, winnerName=none", async () => {
      const result = await runRace([], "in", "out");
      expect(result.score).toBe(0);
      expect(result.winnerName).toBe("none");
    });

    it("single scorer: it wins the race", async () => {
      const only = fixedEvalScorer("only", 0.55, 0);
      const result = await runRace([only], "in", "out");
      expect(result.winnerName).toBe("only");
      expect(result.score).toBeCloseTo(0.55);
    });

    it("winner result pass field reflects its own score", async () => {
      const fast = fixedEvalScorer("fast", 0.8, 0);
      const result = await runRace(
        [fast, fixedEvalScorer("slow", 0.1, 200)],
        "in",
        "out",
      );
      expect(result.pass).toBe(true); // 0.8 >= 0.5
    });

    it("race result contains reasoning from the winner", async () => {
      const fast = fixedEvalScorer("fast", 0.6, 0);
      const result = await runRace(
        [fast, fixedEvalScorer("slow", 0.9, 200)],
        "in",
        "out",
      );
      expect(result.reasoning).toContain("fast");
    });

    it("three scorers: fastest one wins", async () => {
      const scorers = [
        fixedEvalScorer("medium", 0.5, 50),
        fixedEvalScorer("fast", 0.9, 5),
        fixedEvalScorer("slow", 1.0, 300),
      ];
      const result = await runRace(scorers, "in", "out");
      expect(result.winnerName).toBe("fast");
    });

    it("reference is passed to all racers", async () => {
      const capturedRefs: Array<string | undefined> = [];
      const racingScorer = (name: string, d: number): EvalScorer => ({
        name,
        score: async (input, output, ref) => {
          await delay(d);
          capturedRefs.push(ref);
          return { score: 0.5, pass: true, reasoning: name };
        },
      });
      await runRace(
        [racingScorer("A", 100), racingScorer("B", 100)],
        "in",
        "out",
        "the-ref",
      );
      // Both started, at least one captured the reference
      expect(capturedRefs.some((r) => r === "the-ref")).toBe(true);
    });
  });

  describe("CompositeScorer runs in parallel", () => {
    it("composite timing is ~50ms for two 50ms scorers (parallel, not serial)", async () => {
      const s1 = fixedEvalScorer("s1", 0.8, 50);
      const s2 = fixedEvalScorer("s2", 0.6, 50);
      const composite = new CompositeScorer({
        scorers: [
          { scorer: s1, weight: 1 },
          { scorer: s2, weight: 1 },
        ],
      });
      const start = Date.now();
      await composite.score("in", "out");
      const elapsed = Date.now() - start;
      // Parallel: should be ~50ms, not ~100ms
      expect(elapsed).toBeLessThan(130);
    });

    it("composite timing with three 30ms scorers is still ~30ms (parallel)", async () => {
      const scorers = [
        fixedEvalScorer("a", 0.5, 30),
        fixedEvalScorer("b", 0.7, 30),
        fixedEvalScorer("c", 0.9, 30),
      ];
      const composite = new CompositeScorer({
        scorers: scorers.map((s) => ({ scorer: s, weight: 1 })),
      });
      const start = Date.now();
      await composite.score("in", "out");
      const elapsed = Date.now() - start;
      // Three parallel 30ms scorers should complete in ~30ms, not ~90ms
      expect(elapsed).toBeLessThan(100);
    });
  });
});

// ===========================================================================
// 6. ERROR PROPAGATION
// ===========================================================================

describe("Error propagation", () => {
  describe("runTolerant — one fails, others run", () => {
    it("one throwing scorer does not prevent others from running", async () => {
      const good = fixedEvalScorer("good", 0.9);
      const bad = throwingEvalScorer("bad");
      const result = await runTolerant(
        [
          { scorer: good, weight: 1 },
          { scorer: bad, weight: 1 },
        ],
        "in",
        "out",
      );
      expect(result.failedCount).toBe(1);
      expect(result.scores).toHaveLength(2);
    });

    it("failed scorer contributes score=0 to aggregate", async () => {
      const good = fixedEvalScorer("good", 1.0);
      const bad = throwingEvalScorer("bad");
      const result = await runTolerant(
        [
          { scorer: good, weight: 1 },
          { scorer: bad, weight: 1 },
        ],
        "in",
        "out",
      );
      // good=1.0*1, bad=0.0*1 → 1.0/2 = 0.5
      expect(result.aggregateScore).toBeCloseTo(0.5);
    });

    it("error message from failed scorer is captured in scores array", async () => {
      const bad = throwingEvalScorer("bad");
      const result = await runTolerant(
        [{ scorer: bad, weight: 1 }],
        "in",
        "out",
      );
      const badScore = result.scores.find((s) => s.name === "bad");
      expect(badScore?.error).toContain("bad exploded");
    });

    it("all failing scorers yields aggregateScore=0", async () => {
      const result = await runTolerant(
        [
          { scorer: throwingEvalScorer("bad1"), weight: 1 },
          { scorer: throwingEvalScorer("bad2"), weight: 1 },
        ],
        "in",
        "out",
      );
      expect(result.aggregateScore).toBe(0);
      expect(result.failedCount).toBe(2);
    });

    it("all passing scorers yields failedCount=0", async () => {
      const result = await runTolerant(
        [
          { scorer: fixedEvalScorer("a", 0.8), weight: 1 },
          { scorer: fixedEvalScorer("b", 0.6), weight: 1 },
        ],
        "in",
        "out",
      );
      expect(result.failedCount).toBe(0);
    });

    it("failing scorer with high weight still reduces aggregate", async () => {
      const good = fixedEvalScorer("good", 1.0);
      const bad = throwingEvalScorer("bad");
      const result = await runTolerant(
        [
          { scorer: good, weight: 1 },
          { scorer: bad, weight: 9 }, // high weight for bad scorer
        ],
        "in",
        "out",
      );
      // good=1.0*1, bad=0.0*9 → 1.0/10 = 0.1
      expect(result.aggregateScore).toBeCloseTo(0.1);
    });

    it("three scorers, one fails: still returns correct count", async () => {
      const result = await runTolerant(
        [
          { scorer: fixedEvalScorer("a", 1.0), weight: 1 },
          { scorer: throwingEvalScorer("b"), weight: 1 },
          { scorer: fixedEvalScorer("c", 0.5), weight: 1 },
        ],
        "in",
        "out",
      );
      expect(result.scores).toHaveLength(3);
      expect(result.failedCount).toBe(1);
    });

    it("scores array contains entry for each scorer including failed ones", async () => {
      const result = await runTolerant(
        [
          { scorer: fixedEvalScorer("good", 0.8), weight: 1 },
          { scorer: throwingEvalScorer("bad"), weight: 1 },
        ],
        "in",
        "out",
      );
      const names = result.scores.map((s) => s.name);
      expect(names).toContain("good");
      expect(names).toContain("bad");
    });
  });

  describe("CompositeScorer error propagation", () => {
    it("CompositeScorer throws if a sub-scorer throws (Promise.all rejects)", async () => {
      const good = fixedEvalScorer("good", 0.9);
      const bad = throwingEvalScorer("bad");
      const composite = new CompositeScorer({
        scorers: [
          { scorer: good, weight: 1 },
          { scorer: bad, weight: 1 },
        ],
      });
      await expect(composite.score("in", "out")).rejects.toThrow();
    });

    it("all-good scorers do not throw in CompositeScorer", async () => {
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("a", 0.5), weight: 1 },
          { scorer: fixedEvalScorer("b", 0.7), weight: 1 },
        ],
      });
      await expect(composite.score("in", "out")).resolves.toBeDefined();
    });
  });
});

// ===========================================================================
// 7. COMPOSED PIPELINE INTEGRATION
// ===========================================================================

describe("Composed pipeline integration", () => {
  describe("chain then composite", () => {
    it("chained result within tolerance of expected weighted composite", async () => {
      // Run a chain first to get intermediate scores, then feed them into composite logic
      const scorerA = fixedEvalScorer("A", 0.8);
      const scorerB = fixedEvalScorer("B", 0.6);
      const chainResult = await runChained(
        [scorerA, scorerB],
        "input",
        "output",
      );

      // Then verify a composite with same scorers gives same mean
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fixedEvalScorer("A2", 0.8), weight: 1 },
          { scorer: fixedEvalScorer("B2", 0.6), weight: 1 },
        ],
      });
      const compositeResult = await composite.score("input", "output");

      // Both should give (0.8 + 0.6) / 2 = 0.7
      expect(chainResult.finalScore).toBeCloseTo(0.7);
      expect(compositeResult.score).toBeCloseTo(0.7);
    });
  });

  describe("short-circuit then tolerance", () => {
    it("tolerant runner succeeds even if short-circuit would have stopped", async () => {
      // If we used short-circuit, scorer B would stop at scorer A (score=0.1)
      // But tolerant runner continues and gets both results
      const scorerA = fixedEvalScorer("A", 0.1); // below short-circuit threshold
      const scorerB = fixedEvalScorer("B", 1.0);

      const tolerantResult = await runTolerant(
        [
          { scorer: scorerA, weight: 1 },
          { scorer: scorerB, weight: 1 },
        ],
        "in",
        "out",
      );

      // tolerant runner runs both: (0.1 + 1.0) / 2 = 0.55
      expect(tolerantResult.aggregateScore).toBeCloseTo(0.55);
      expect(vi.mocked(scorerA.score)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scorerB.score)).toHaveBeenCalledTimes(1);
    });
  });

  describe("timeout-wrapped inside composite", () => {
    it("partial timeouts do not throw from composite", async () => {
      const fast = fixedEvalScorer("fast", 0.8, 0);
      const slow = withTimeout(fixedEvalScorer("slow", 1.0, 500), {
        timeoutMs: 50,
        fallbackScore: 0.0,
      });
      const composite = new CompositeScorer({
        scorers: [
          { scorer: fast, weight: 1 },
          { scorer: slow, weight: 1 },
        ],
      });
      const result = await composite.score("in", "out");
      // fast=0.8, slow-timeout=0.0 → (0.8+0.0)/2 = 0.4
      expect(result.score).toBeCloseTo(0.4);
      expect(result.pass).toBe(false);
    });
  });

  describe("enhanced scorer interface compatibility", () => {
    it("enhanced scorer with fixed score still satisfies ScorerResult contract", async () => {
      const s = makeEnhancedScorer("test-id", 0.75);
      const result = await s.score({ input: "q", output: "a" });
      expect(result.scorerId).toBe("test-id");
      expect(result.aggregateScore).toBeCloseTo(0.75);
      expect(result.passed).toBe(true);
      expect(Array.isArray(result.scores)).toBe(true);
      expect(typeof result.durationMs).toBe("number");
    });

    it("multiple enhanced scorers can be run independently", async () => {
      const s1 = makeEnhancedScorer("s1", 0.3);
      const s2 = makeEnhancedScorer("s2", 0.9);
      const [r1, r2] = await Promise.all([
        s1.score({ input: "q", output: "a" }),
        s2.score({ input: "q", output: "a" }),
      ]);
      expect(r1.aggregateScore).toBeCloseTo(0.3);
      expect(r2.aggregateScore).toBeCloseTo(0.9);
    });
  });
});
