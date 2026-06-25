/**
 * Regression Eval Suites — comprehensive coverage of baseline pinning,
 * regression detection across model updates, threshold tolerance, baseline
 * update/versioning, serialization, per-case baselines, multi-metric
 * tracking, and report formatting.
 *
 * All tests are deterministic — no network, no LLM, no filesystem.
 *
 * Topics covered:
 *  1. Baseline pinning — store and retrieve eval scores as baseline
 *  2. Regression detection — new scores below threshold trigger failure
 *  3. No-regression — scores at/above baseline always pass
 *  4. Partial regression — only failing cases reported
 *  5. Threshold tolerance — configurable % grace before flagging
 *  6. Baseline update — updating baseline stores new scores
 *  7. Missing baseline — running check with no baseline skips/warns
 *  8. Per-case baseline — individual cases with different baselines
 *  9. Score improvement — above-baseline scores noted, not flagged
 * 10. Multi-metric baseline — accuracy, latency, cost dimensions
 * 11. Baseline serialization — save and load from JSON
 * 12. Baseline versioning — stale model-version baseline handling
 * 13. Aggregate regression — suite-level aggregate score detection
 * 14. Regression report format — name, expected, actual, delta
 * 15. BenchmarkTrendStore regression trend detection
 * 16. EvalRunner.regressionCheck extended coverage
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  BenchmarkOrchestrator,
  RegressionGateError,
} from "../orchestrator/benchmark-orchestrator.js";
import type {
  BenchmarkOrchestratorConfig,
  RegressionGateResult,
  RegressionDetail,
} from "../orchestrator/benchmark-orchestrator.js";
import type {
  BenchmarkRunStore,
  BenchmarkRunRecord,
  BenchmarkRunListPage,
  BenchmarkBaselineRecord,
} from "@dzupagent/eval-contracts";

import { EvalRunner } from "../runner/enhanced-runner.js";
import type { EvalInput, Scorer, ScorerResult } from "../types.js";
import { EvalDataset } from "../dataset/eval-dataset.js";

import {
  BenchmarkTrendStore,
  InMemoryBenchmarkRunStore,
  type BenchmarkRunRecord as TrendRunRecord,
} from "../benchmarks/benchmark-trend.js";
import { compareBenchmarks } from "../benchmarks/benchmark-runner.js";
import type { BenchmarkResult } from "../benchmarks/benchmark-types.js";

// ===========================================================================
// Shared helpers
// ===========================================================================

function makeBenchmarkResult(
  suiteId: string,
  scores: Record<string, number>,
  regressions: string[] = [],
): BenchmarkResult {
  return {
    suiteId,
    timestamp: new Date().toISOString(),
    scores,
    passedBaseline: regressions.length === 0,
    regressions,
  };
}

function makeRunRecord(
  id: string,
  suiteId: string,
  scores: Record<string, number>,
  targetId = "target-a",
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId,
    strict: true,
    createdAt: new Date().toISOString(),
    result: makeBenchmarkResult(suiteId, scores),
  };
}

class InMemoryStore implements BenchmarkRunStore {
  private runs = new Map<string, BenchmarkRunRecord>();
  private baselines = new Map<string, BenchmarkBaselineRecord>();

  async saveRun(record: BenchmarkRunRecord): Promise<void> {
    this.runs.set(record.id, record);
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(): Promise<BenchmarkRunListPage> {
    return { data: [...this.runs.values()], nextCursor: null, hasMore: false };
  }

  async saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void> {
    this.baselines.set(`${baseline.suiteId}::${baseline.targetId}`, baseline);
  }

  async getBaseline(
    suiteId: string,
    targetId: string,
  ): Promise<BenchmarkBaselineRecord | null> {
    return this.baselines.get(`${suiteId}::${targetId}`) ?? null;
  }

  async listBaselines(filter?: {
    suiteId?: string;
    targetId?: string;
  }): Promise<BenchmarkBaselineRecord[]> {
    const all = [...this.baselines.values()];
    return all.filter(
      (b) =>
        (filter?.suiteId === undefined || b.suiteId === filter.suiteId) &&
        (filter?.targetId === undefined || b.targetId === filter.targetId),
    );
  }
}

function makeOrchestrator(store: BenchmarkRunStore = new InMemoryStore()) {
  return new BenchmarkOrchestrator({
    suites: {},
    executeTarget: async () => "",
    store,
  } satisfies BenchmarkOrchestratorConfig);
}

function makeFixedScorer(
  id: string,
  score: number,
  passed = true,
): Scorer<EvalInput> {
  return {
    config: { id, name: id, type: "deterministic" },
    score: async (): Promise<ScorerResult> => ({
      scorerId: id,
      scores: [{ criterion: "test", score, reasoning: "fixed" }],
      aggregateScore: score,
      passed,
      durationMs: 0,
    }),
  };
}

function makeDataset(n = 3) {
  return EvalDataset.from(
    Array.from({ length: n }, (_, i) => ({
      id: `e${i + 1}`,
      input: `input-${i + 1}`,
      expectedOutput: `expected-${i + 1}`,
    })),
  );
}

function makeTrendRecord(
  runId: string,
  suiteId: string,
  targetId: string,
  overallScore: number,
  offsetMs = 0,
): TrendRunRecord {
  return {
    runId,
    suiteId,
    targetId,
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
    overallScore,
    result: makeBenchmarkResult(suiteId, { overall: overallScore }),
  };
}

// ===========================================================================
// 1. Baseline pinning — store and retrieve eval scores as baseline
// ===========================================================================

describe("Baseline pinning", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("stores a run as the baseline and retrieves it with full score fidelity", async () => {
    const run = makeRunRecord("pin-1", "suite-pin", {
      accuracy: 0.88,
      f1: 0.76,
    });
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-pin",
      targetId: "target-a",
      runId: "pin-1",
    });

    expect(baseline.result.scores["accuracy"]).toBeCloseTo(0.88);
    expect(baseline.result.scores["f1"]).toBeCloseTo(0.76);

    const retrieved = await orchestrator.getBaseline("suite-pin", "target-a");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.result.scores["accuracy"]).toBeCloseTo(0.88);
    expect(retrieved!.result.scores["f1"]).toBeCloseTo(0.76);
  });

  it("baseline pinning is keyed by suiteId AND targetId independently", async () => {
    const runA = makeRunRecord("r-a", "suite-x", { score: 0.7 }, "model-a");
    const runB = makeRunRecord("r-b", "suite-x", { score: 0.9 }, "model-b");
    await store.saveRun(runA);
    await store.saveRun(runB);

    await orchestrator.setBaseline({
      suiteId: "suite-x",
      targetId: "model-a",
      runId: "r-a",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-x",
      targetId: "model-b",
      runId: "r-b",
    });

    const bA = await orchestrator.getBaseline("suite-x", "model-a");
    const bB = await orchestrator.getBaseline("suite-x", "model-b");

    expect(bA!.result.scores["score"]).toBeCloseTo(0.7);
    expect(bB!.result.scores["score"]).toBeCloseTo(0.9);
  });

  it("baseline carries the pinned runId reference", async () => {
    const run = makeRunRecord("my-run-42", "suite-z", { x: 0.5 });
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-z",
      targetId: "target-a",
      runId: "my-run-42",
    });

    expect(baseline.runId).toBe("my-run-42");
  });

  it("baseline.updatedAt is a valid ISO string at or after call time", async () => {
    const before = Date.now();
    const run = makeRunRecord("ts-run", "suite-ts", { q: 0.8 });
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-ts",
      targetId: "target-a",
      runId: "ts-run",
    });

    const t = Date.parse(baseline.updatedAt);
    expect(isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
  });

  it("pinned baseline preserves high-precision scores (many decimals)", async () => {
    const run = makeRunRecord("precise-run", "suite-p", { score: 0.123456789 });
    await store.saveRun(run);

    await orchestrator.setBaseline({
      suiteId: "suite-p",
      targetId: "target-a",
      runId: "precise-run",
    });

    const bl = await orchestrator.getBaseline("suite-p", "target-a");
    expect(bl!.result.scores["score"]).toBeCloseTo(0.123456789, 9);
  });
});

// ===========================================================================
// 2. Regression detection — scores below threshold trigger failure
// ===========================================================================

describe("Regression detection — new scores below baseline threshold", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("throws RegressionGateError when single metric drops beyond 5% threshold", () => {
    const baseline = makeRunRecord("b", "s", { accuracy: 0.9 });
    const current = makeRunRecord("c", "s", { accuracy: 0.8 }); // -0.10 drop

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("throws when multiple metrics all regress beyond threshold", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.9, b: 0.8, c: 0.7 });
    const current = makeRunRecord("c", "s", { a: 0.5, b: 0.4, c: 0.3 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught!.regressions).toHaveLength(3);
  });

  it("RegressionGateError is an instance of Error", () => {
    const baseline = makeRunRecord("b", "s", { q: 0.9 });
    const current = makeRunRecord("c", "s", { q: 0.5 });

    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(RegressionGateError);
    }
  });

  it('error.name is "RegressionGateError"', () => {
    const baseline = makeRunRecord("b", "s", { q: 0.9 });
    const current = makeRunRecord("c", "s", { q: 0.5 });

    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      expect((e as Error).name).toBe("RegressionGateError");
    }
  });

  it("model update scenario — previously 0.85 accuracy, now 0.70 triggers gate", () => {
    const v1 = makeRunRecord("v1", "qa", { accuracy: 0.85 });
    const v2 = makeRunRecord("v2", "qa", { accuracy: 0.7 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: v2,
        baselineRun: v1,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("model update scenario — previously 0.70 accuracy, now 0.85 does NOT trigger gate", () => {
    const v1 = makeRunRecord("v1", "qa", { accuracy: 0.7 });
    const v2 = makeRunRecord("v2", "qa", { accuracy: 0.85 });

    const result = orchestrator.regressionGate({
      currentRun: v2,
      baselineRun: v1,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });
});

// ===========================================================================
// 3. No-regression — scores at or above baseline always pass
// ===========================================================================

describe("No-regression — scores at or above baseline", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("returns passed=true when every metric equals its baseline value", () => {
    const scores = { accuracy: 0.8, f1: 0.7, recall: 0.75, precision: 0.72 };
    const baseline = makeRunRecord("b", "s", { ...scores });
    const current = makeRunRecord("c", "s", { ...scores });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it("returns passed=true when every metric strictly improves", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.5, b: 0.6, c: 0.7 });
    const current = makeRunRecord("c", "s", { a: 0.8, b: 0.9, c: 0.95 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });

  it("drop exactly at threshold boundary is treated as pass (inclusive)", () => {
    // delta = 0.7 - 0.75 = -0.05 === -threshold => boundary pass
    const baseline = makeRunRecord("b", "s", { score: 0.75 });
    const current = makeRunRecord("c", "s", { score: 0.7 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });

  it("returned regressions array is empty when all scores pass", () => {
    const baseline = makeRunRecord("b", "s", { x: 0.6, y: 0.7 });
    const current = makeRunRecord("c", "s", { x: 0.65, y: 0.75 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.regressions).toEqual([]);
  });

  it("perfect 1.0 → 1.0 does not regress even with threshold=0", () => {
    const baseline = makeRunRecord("b", "s", { score: 1.0 });
    const current = makeRunRecord("c", "s", { score: 1.0 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0,
    });
    expect(result.passed).toBe(true);
  });
});

// ===========================================================================
// 4. Partial regression — only failing cases appear in report
// ===========================================================================

describe("Partial regression — only regressions reported", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("only regressed metrics appear in regressions array", () => {
    const baseline = makeRunRecord("b", "s", { ok1: 0.8, ok2: 0.7, bad1: 0.9 });
    const current = makeRunRecord("c", "s", { ok1: 0.85, ok2: 0.7, bad1: 0.5 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught!.regressions).toHaveLength(1);
    expect(caught!.regressions[0]!.suiteName).toBe("bad1");
  });

  it("improved and within-threshold metrics are NOT included in regressions", () => {
    const baseline = makeRunRecord("b", "s", {
      great: 0.5, // will improve
      ok: 0.8, // will drop within threshold
      bad: 0.9, // will regress
    });
    const current = makeRunRecord("c", "s", {
      great: 0.95,
      ok: 0.76,
      bad: 0.7,
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.regressions).toHaveLength(1);
    const names = caught!.regressions.map((r) => r.suiteName);
    expect(names).toContain("bad");
    expect(names).not.toContain("great");
    expect(names).not.toContain("ok");
  });

  it("EvalRunner.regressionCheck reports only the failing scorer dimension", async () => {
    const passing = makeFixedScorer("good", 0.9, true);
    const failing = makeFixedScorer("bad", 0.3, false);
    const runner = new EvalRunner({ scorers: [passing, failing] });

    const baseline = new Map([
      ["good", 0.8],
      ["bad", 0.9],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("bad");
    expect(result.regressions.every((r) => !r.includes("good"))).toBe(true);
  });

  it("three scorers: two pass, one regresses — regression list length is 1", async () => {
    const s1 = makeFixedScorer("alpha", 0.85, true);
    const s2 = makeFixedScorer("beta", 0.9, true);
    const s3 = makeFixedScorer("gamma", 0.2, false);
    const runner = new EvalRunner({ scorers: [s1, s2, s3] });

    const baseline = new Map([
      ["alpha", 0.8],
      ["beta", 0.85],
      ["gamma", 0.9],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("gamma");
  });
});

// ===========================================================================
// 5. Threshold tolerance — configurable % drop before flagging
// ===========================================================================

describe("Threshold tolerance — configurable grace before flagging", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("1% threshold: drop of 0.5% passes", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.8 });
    const current = makeRunRecord("c", "s", { score: 0.795 }); // -0.005

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.01,
    });
    expect(result.passed).toBe(true);
  });

  it("1% threshold: drop of 1.5% fails", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.8 });
    const current = makeRunRecord("c", "s", { score: 0.785 }); // -0.015

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.01,
      }),
    ).toThrow(RegressionGateError);
  });

  it("10% threshold: drop of 9% passes", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.9 });
    const current = makeRunRecord("c", "s", { score: 0.819 }); // -0.081 < 0.10

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.1,
    });
    expect(result.passed).toBe(true);
  });

  it("10% threshold: drop of 11% fails", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.9 });
    const current = makeRunRecord("c", "s", { score: 0.789 }); // -0.111

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.1,
      }),
    ).toThrow(RegressionGateError);
  });

  it("50% threshold: even a large regression passes", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.9 });
    const current = makeRunRecord("c", "s", { score: 0.45 }); // -0.45 <= 0.50

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.5,
    });
    expect(result.passed).toBe(true);
  });

  it("threshold=0: any numeric drop (even tiny) is a regression", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.8 });
    const current = makeRunRecord("c", "s", { score: 0.7999 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0,
      }),
    ).toThrow(RegressionGateError);
  });

  it("negative threshold throws RangeError", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.8 });
    const current = makeRunRecord("c", "s", { score: 0.8 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: -0.01,
      }),
    ).toThrow(RangeError);
  });

  it("threshold=1.0 allows even a catastrophic regression (0.9 → 0.0)", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.9 });
    const current = makeRunRecord("c", "s", { score: 0.0 }); // -0.9 < 1.0

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 1.0,
    });
    expect(result.passed).toBe(true);
  });
});

// ===========================================================================
// 6. Baseline update — explicitly updating baseline stores new scores
// ===========================================================================

describe("Baseline update — re-pinning stores new scores", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("second setBaseline call for same suite+target overwrites the first", async () => {
    const run1 = makeRunRecord("r1", "suite-u", { accuracy: 0.7 });
    const run2 = makeRunRecord("r2", "suite-u", { accuracy: 0.9 });
    await store.saveRun(run1);
    await store.saveRun(run2);

    await orchestrator.setBaseline({
      suiteId: "suite-u",
      targetId: "target-a",
      runId: "r1",
    });

    let bl = await orchestrator.getBaseline("suite-u", "target-a");
    expect(bl!.result.scores["accuracy"]).toBeCloseTo(0.7);

    await orchestrator.setBaseline({
      suiteId: "suite-u",
      targetId: "target-a",
      runId: "r2",
    });

    bl = await orchestrator.getBaseline("suite-u", "target-a");
    expect(bl!.runId).toBe("r2");
    expect(bl!.result.scores["accuracy"]).toBeCloseTo(0.9);
  });

  it("baseline update changes gate behavior — improved model now passes gate", async () => {
    const run1 = makeRunRecord("r1", "suite-v", { quality: 0.6 });
    const run2 = makeRunRecord("r2", "suite-v", { quality: 0.85 });
    await store.saveRun(run1);
    await store.saveRun(run2);

    // Pin the improved run as the new baseline
    await orchestrator.setBaseline({
      suiteId: "suite-v",
      targetId: "target-a",
      runId: "r2",
    });

    const bl = await orchestrator.getBaseline("suite-v", "target-a");
    expect(bl!.result.scores["quality"]).toBeCloseTo(0.85);

    // A run matching the new baseline should pass
    const newRun = makeRunRecord("r3", "suite-v", { quality: 0.87 });
    const result = orchestrator.regressionGate({
      currentRun: newRun,
      baselineRun: bl!,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });

  it("after baseline update, old scores may cause regression under new baseline", async () => {
    const oldRun = makeRunRecord("old", "suite-w", { quality: 0.6 });
    const newRun = makeRunRecord("new", "suite-w", { quality: 0.9 });
    await store.saveRun(oldRun);
    await store.saveRun(newRun);

    // Update baseline to the improved run
    await orchestrator.setBaseline({
      suiteId: "suite-w",
      targetId: "target-a",
      runId: "new",
    });
    const bl = await orchestrator.getBaseline("suite-w", "target-a");

    // Now a run with old scores should regress against new baseline
    const staleRun = makeRunRecord("stale", "suite-w", { quality: 0.6 });
    expect(() =>
      orchestrator.regressionGate({
        currentRun: staleRun,
        baselineRun: bl!,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });
});

// ===========================================================================
// 7. Missing baseline — running check with no stored baseline
// ===========================================================================

describe("Missing baseline — no baseline stored", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("getBaseline returns null when no baseline has been set", async () => {
    const result = await orchestrator.getBaseline("suite-missing", "target-x");
    expect(result).toBeNull();
  });

  it("regressionGate with empty baseline scores acts as first-run (always passes)", () => {
    const emptyBaseline = makeRunRecord("baseline", "s", {}); // no metrics
    const current = makeRunRecord("current", "s", { score: 0.8 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: emptyBaseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("EvalRunner.regressionCheck with empty Map baseline passes for all scorers", async () => {
    const scorer = makeFixedScorer("dim", 0.3, false); // even a low score passes
    const runner = new EvalRunner({ scorers: [scorer] });

    const result = await runner.regressionCheck(makeDataset(2), new Map());
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("EvalRunner.regressionCheck reports averages even when no baseline provided", async () => {
    const scorer = makeFixedScorer("metric", 0.65, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const result = await runner.regressionCheck(makeDataset(2), new Map());
    expect(result.averages.has("metric")).toBe(true);
    expect(result.averages.get("metric")).toBeCloseTo(0.65);
  });

  it("EvalRunner with empty dataset and non-empty baseline treats missing score as no regression", async () => {
    const scorer = makeFixedScorer("s", 0.5, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const result = await runner.regressionCheck(
      EvalDataset.from([]),
      new Map([["s", 0.9]]),
    );

    expect(result.passed).toBe(true);
  });
});

// ===========================================================================
// 8. Per-case baseline — individual cases have different expected scores
// ===========================================================================

describe("Per-case baseline — individual metrics with distinct baselines", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("each metric evaluated against its own baseline value independently", () => {
    // We simulate "per-case" by using different scorers as case identifiers
    const baseline = makeRunRecord("b", "s", {
      "case-easy": 0.95, // high bar
      "case-hard": 0.5, // low bar
      "case-mid": 0.7, // mid bar
    });
    const current = makeRunRecord("c", "s", {
      "case-easy": 0.92, // -0.03 within 5% threshold
      "case-hard": 0.48, // -0.02 within 5% threshold
      "case-mid": 0.6, // -0.10 exceeds threshold
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught!.regressions).toHaveLength(1);
    expect(caught!.regressions[0]!.suiteName).toBe("case-mid");
  });

  it("high-bar case that barely passes while another regresses — only regressions reported", () => {
    const baseline = makeRunRecord("b", "s", {
      "task-a": 0.9,
      "task-b": 0.6,
    });
    const current = makeRunRecord("c", "s", {
      "task-a": 0.86, // -0.04 within threshold
      "task-b": 0.3, // -0.3 regression
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.regressions).toHaveLength(1);
    expect(caught!.regressions[0]!.suiteName).toBe("task-b");
  });

  it("two cases regress, one passes — regression list contains exactly the two bad cases", () => {
    const baseline = makeRunRecord("b", "s", {
      caseA: 0.8,
      caseB: 0.7,
      caseC: 0.6,
    });
    const current = makeRunRecord("c", "s", {
      caseA: 0.5, // regressed
      caseB: 0.67, // within threshold
      caseC: 0.3, // regressed
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    const names = caught!.regressions.map((r) => r.suiteName).sort();
    expect(names).toEqual(["caseA", "caseC"]);
  });
});

// ===========================================================================
// 9. Score improvement — above-baseline is noted, not flagged
// ===========================================================================

describe("Score improvement — above-baseline scores are not flagged", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("scores above baseline result in passed=true with no regressions", () => {
    const baseline = makeRunRecord("b", "s", { accuracy: 0.7, f1: 0.6 });
    const current = makeRunRecord("c", "s", { accuracy: 0.95, f1: 0.88 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("improved scorers are not included in regressions even under strict threshold=0", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.5 });
    const current = makeRunRecord("c", "s", { score: 0.9 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it("compareBenchmarks marks improved scorers in .improved list", () => {
    const current = makeBenchmarkResult("s", { accuracy: 0.95 });
    const previous = makeBenchmarkResult("s", { accuracy: 0.7 });

    const comp = compareBenchmarks(current, previous);
    expect(comp.improved).toContain("accuracy");
    expect(comp.regressed).not.toContain("accuracy");
  });

  it("EvalRunner: scorer above baseline does not appear in regressions list", async () => {
    const scorer = makeFixedScorer("coverage", 0.99, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["coverage", 0.5]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });
});

// ===========================================================================
// 10. Multi-metric baseline — accuracy, latency, cost dimensions
// ===========================================================================

describe("Multi-metric baseline — multiple dimensions tracked independently", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("three-dimension baseline with only latency regressing fires gate", () => {
    const baseline = makeRunRecord("b", "s", {
      accuracy: 0.8,
      latency: 0.9,
      cost: 0.95,
    });
    const current = makeRunRecord("c", "s", {
      accuracy: 0.82, // improved
      latency: 0.7, // -0.20: regressed
      cost: 0.96, // improved
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.regressions).toHaveLength(1);
    expect(caught!.regressions[0]!.suiteName).toBe("latency");
  });

  it("six-dimension baseline: reports accurate subset of regressions", () => {
    const baseline = makeRunRecord("b", "s", {
      accuracy: 0.9,
      precision: 0.85,
      recall: 0.8,
      f1: 0.82,
      latency: 0.9,
      cost: 0.95,
    });
    const current = makeRunRecord("c", "s", {
      accuracy: 0.91, // improved
      precision: 0.83, // -0.02 within threshold
      recall: 0.6, // -0.20 regressed
      f1: 0.79, // -0.03 within threshold
      latency: 0.72, // -0.18 regressed
      cost: 0.97, // improved
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    const names = caught!.regressions.map((r) => r.suiteName).sort();
    expect(names).toEqual(["latency", "recall"]);
  });

  it("EvalRunner multi-scorer baseline: averages map contains all dimensions", async () => {
    const scorers = [
      makeFixedScorer("accuracy", 0.88, true),
      makeFixedScorer("latency", 0.75, true),
      makeFixedScorer("cost", 0.92, true),
    ];
    const runner = new EvalRunner({ scorers });

    const result = await runner.regressionCheck(makeDataset(2), new Map());

    expect(result.averages.get("accuracy")).toBeCloseTo(0.88);
    expect(result.averages.get("latency")).toBeCloseTo(0.75);
    expect(result.averages.get("cost")).toBeCloseTo(0.92);
  });

  it("multi-metric: only cost regresses, accuracy+latency pass", async () => {
    const scorers = [
      makeFixedScorer("accuracy", 0.85, true),
      makeFixedScorer("latency", 0.8, true),
      makeFixedScorer("cost", 0.3, false),
    ];
    const runner = new EvalRunner({ scorers });

    const baseline = new Map([
      ["accuracy", 0.8],
      ["latency", 0.75],
      ["cost", 0.9],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("cost");
  });
});

// ===========================================================================
// 11. Baseline serialization — save and load from JSON round-trip
// ===========================================================================

describe("Baseline serialization — JSON round-trip", () => {
  it("baseline record can be serialized and deserialized without data loss", () => {
    const original: BenchmarkBaselineRecord = {
      suiteId: "suite-serial",
      targetId: "model-v3",
      runId: "run-abc",
      updatedAt: new Date().toISOString(),
      result: makeBenchmarkResult("suite-serial", {
        accuracy: 0.876,
        f1: 0.732,
      }),
    };

    const serialized = JSON.stringify(original);
    const restored = JSON.parse(serialized) as BenchmarkBaselineRecord;

    expect(restored.suiteId).toBe("suite-serial");
    expect(restored.targetId).toBe("model-v3");
    expect(restored.runId).toBe("run-abc");
    expect(restored.result.scores["accuracy"]).toBeCloseTo(0.876);
    expect(restored.result.scores["f1"]).toBeCloseTo(0.732);
  });

  it("baseline round-tripped via JSON still works with regressionGate", () => {
    const original: BenchmarkBaselineRecord = {
      suiteId: "suite-rg",
      targetId: "tgt",
      runId: "r1",
      updatedAt: new Date().toISOString(),
      result: makeBenchmarkResult("suite-rg", { quality: 0.85 }),
    };

    const restored = JSON.parse(
      JSON.stringify(original),
    ) as BenchmarkBaselineRecord;

    // Construct BenchmarkRunRecord from restored baseline result
    const baselineRun: BenchmarkRunRecord = {
      id: restored.runId,
      suiteId: restored.suiteId,
      targetId: restored.targetId,
      strict: true,
      createdAt: restored.updatedAt,
      result: restored.result,
    };

    const currentRun = makeRunRecord("current", "suite-rg", { quality: 0.84 });

    const orchestrator = makeOrchestrator();
    const result = orchestrator.regressionGate({
      currentRun,
      baselineRun,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
  });

  it("baseline scores survive JSON round-trip with high-precision floats", () => {
    const scores = { a: 0.123456789, b: 0.987654321, c: 0.500000001 };
    const baseline: BenchmarkBaselineRecord = {
      suiteId: "p",
      targetId: "t",
      runId: "r",
      updatedAt: new Date().toISOString(),
      result: makeBenchmarkResult("p", scores),
    };

    const restored = JSON.parse(
      JSON.stringify(baseline),
    ) as BenchmarkBaselineRecord;

    expect(restored.result.scores["a"]).toBeCloseTo(0.123456789, 6);
    expect(restored.result.scores["b"]).toBeCloseTo(0.987654321, 6);
    expect(restored.result.scores["c"]).toBeCloseTo(0.500000001, 6);
  });

  it("multiple baselines serialize/restore independently", () => {
    const baselines: BenchmarkBaselineRecord[] = [
      {
        suiteId: "qa",
        targetId: "gpt4",
        runId: "r1",
        updatedAt: "2024-01-01T00:00:00Z",
        result: makeBenchmarkResult("qa", { acc: 0.9 }),
      },
      {
        suiteId: "qa",
        targetId: "claude3",
        runId: "r2",
        updatedAt: "2024-01-02T00:00:00Z",
        result: makeBenchmarkResult("qa", { acc: 0.95 }),
      },
    ];

    const restored = JSON.parse(
      JSON.stringify(baselines),
    ) as BenchmarkBaselineRecord[];

    expect(restored).toHaveLength(2);
    expect(restored[0]!.targetId).toBe("gpt4");
    expect(restored[1]!.targetId).toBe("claude3");
    expect(restored[0]!.result.scores["acc"]).toBeCloseTo(0.9);
    expect(restored[1]!.result.scores["acc"]).toBeCloseTo(0.95);
  });
});

// ===========================================================================
// 12. Baseline versioning — stale model-version baseline handling
// ===========================================================================

describe("Baseline versioning — stale or wrong model version", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("baseline for different targetId is not returned for current targetId", async () => {
    const run = makeRunRecord("r1", "suite-ver", { score: 0.9 }, "model-v1");
    await store.saveRun(run);

    await orchestrator.setBaseline({
      suiteId: "suite-ver",
      targetId: "model-v1",
      runId: "r1",
    });

    const bl = await orchestrator.getBaseline("suite-ver", "model-v2");
    expect(bl).toBeNull();
  });

  it("setBaseline rejects run belonging to different targetId", async () => {
    const run = makeRunRecord("r1", "suite-ver", { score: 0.9 }, "model-v1");
    await store.saveRun(run);

    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-ver",
        targetId: "model-v2",
        runId: "r1",
      }),
    ).rejects.toThrow("target");
  });

  it("upgrading model: v1 baseline does not interfere with v2 baseline", async () => {
    const runV1 = makeRunRecord(
      "r-v1",
      "suite-ver",
      { accuracy: 0.7 },
      "model-v1",
    );
    const runV2 = makeRunRecord(
      "r-v2",
      "suite-ver",
      { accuracy: 0.9 },
      "model-v2",
    );
    await store.saveRun(runV1);
    await store.saveRun(runV2);

    await orchestrator.setBaseline({
      suiteId: "suite-ver",
      targetId: "model-v1",
      runId: "r-v1",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-ver",
      targetId: "model-v2",
      runId: "r-v2",
    });

    const blV1 = await orchestrator.getBaseline("suite-ver", "model-v1");
    const blV2 = await orchestrator.getBaseline("suite-ver", "model-v2");

    expect(blV1!.result.scores["accuracy"]).toBeCloseTo(0.7);
    expect(blV2!.result.scores["accuracy"]).toBeCloseTo(0.9);
  });

  it("listBaselines filtered by targetId returns only that target", async () => {
    const r1 = makeRunRecord("r1", "suite-ver", { score: 0.7 }, "model-v1");
    const r2 = makeRunRecord("r2", "suite-ver", { score: 0.9 }, "model-v2");
    await store.saveRun(r1);
    await store.saveRun(r2);

    await orchestrator.setBaseline({
      suiteId: "suite-ver",
      targetId: "model-v1",
      runId: "r1",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-ver",
      targetId: "model-v2",
      runId: "r2",
    });

    const results = await orchestrator.listBaselines({ targetId: "model-v2" });
    expect(results).toHaveLength(1);
    expect(results[0]!.targetId).toBe("model-v2");
  });
});

// ===========================================================================
// 13. Aggregate regression — suite-level aggregate detection
// ===========================================================================

describe("Aggregate regression — suite-level detection", () => {
  it("BenchmarkTrendStore: degrading trend detected after 4 descending runs", async () => {
    const memStore = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(memStore);

    const scores = [0.9, 0.8, 0.7, 0.6];
    for (let i = 0; i < scores.length; i++) {
      await memStore.append(
        makeTrendRecord(`r${i}`, "suite-agg", "model-x", scores[i]!, i * 1000),
      );
    }

    const trend = await trendStore.trend("suite-agg", "model-x");
    expect(trend.direction).toBe("degrading");
    expect(trend.deltaPerWave).toBeLessThan(-0.01);
  });

  it("BenchmarkTrendStore: improving trend detected after 4 ascending runs", async () => {
    const memStore = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(memStore);

    const scores = [0.5, 0.65, 0.8, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await memStore.append(
        makeTrendRecord(`r${i}`, "suite-imp", "model-y", scores[i]!, i * 1000),
      );
    }

    const trend = await trendStore.trend("suite-imp", "model-y");
    expect(trend.direction).toBe("improving");
    expect(trend.deltaPerWave).toBeGreaterThan(0.01);
  });

  it("BenchmarkTrendStore: stable trend when all runs have same score", async () => {
    const memStore = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(memStore);

    for (let i = 0; i < 5; i++) {
      await memStore.append(
        makeTrendRecord(`r${i}`, "suite-stb", "model-z", 0.75, i * 1000),
      );
    }

    const trend = await trendStore.trend("suite-stb", "model-z");
    expect(trend.direction).toBe("stable");
    expect(trend.deltaPerWave).toBeCloseTo(0);
  });

  it("BenchmarkTrendStore: insufficient_data returned for fewer than 3 runs", async () => {
    const memStore = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(memStore);

    await memStore.append(
      makeTrendRecord("r1", "suite-few", "model-a", 0.8, 0),
    );
    await memStore.append(
      makeTrendRecord("r2", "suite-few", "model-a", 0.7, 1000),
    );

    const trend = await trendStore.trend("suite-few", "model-a");
    expect(trend.direction).toBe("insufficient_data");
  });

  it("BenchmarkTrendStore: trend uses only last windowSize runs", async () => {
    const memStore = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(memStore);

    // 7 runs: first 4 declining, last 3 sharply improving
    const scores = [0.9, 0.8, 0.7, 0.6, 0.85, 0.9, 0.95];
    for (let i = 0; i < scores.length; i++) {
      await memStore.append(
        makeTrendRecord(`r${i}`, "suite-win", "mdl", scores[i]!, i * 1000),
      );
    }

    // windowSize=3 → last 3 runs are [0.85, 0.90, 0.95]: improving
    const trend = await trendStore.trend("suite-win", "mdl", 3);
    expect(trend.direction).toBe("improving");
    expect(trend.runs).toHaveLength(3);
  });

  it("aggregate gate: multiple suites failing triggers RegressionGateError", () => {
    const orchestrator = makeOrchestrator();

    // Baseline covers 3 "suites" (metrics in a single run)
    const baseline = makeRunRecord("b", "s", {
      "suite-1": 0.9,
      "suite-2": 0.8,
      "suite-3": 0.7,
    });
    const current = makeRunRecord("c", "s", {
      "suite-1": 0.5, // regressed
      "suite-2": 0.5, // regressed
      "suite-3": 0.68, // within threshold
    });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.regressions).toHaveLength(2);
    expect(caught!.message).toContain("2 suite(s)");
  });
});

// ===========================================================================
// 14. Regression report format — name, expected, actual, delta
// ===========================================================================

describe("Regression report format — name, expected, actual, delta", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("each regression detail contains suiteName, baseline, current, delta", () => {
    const baseline = makeRunRecord("b", "s", { myMetric: 0.9 });
    const current = makeRunRecord("c", "s", { myMetric: 0.6 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    const reg = caught!.regressions[0]!;
    expect(reg.suiteName).toBe("myMetric");
    expect(reg.baseline).toBeCloseTo(0.9);
    expect(reg.current).toBeCloseTo(0.6);
    expect(reg.delta).toBeCloseTo(-0.3);
  });

  it("error message includes metric name, baseline score, current score, and delta", () => {
    const baseline = makeRunRecord("b", "s", { accuracy: 0.85 });
    const current = makeRunRecord("c", "s", { accuracy: 0.6 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.message).toContain("accuracy");
    expect(caught!.message).toContain("0.8500");
    expect(caught!.message).toContain("0.6000");
    expect(caught!.message).toContain("-0.2500");
  });

  it("regression report includes count of failing suites in message", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.9, b: 0.8 });
    const current = makeRunRecord("c", "s", { a: 0.5, b: 0.4 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    expect(caught!.message).toContain("2 suite(s)");
  });

  it("delta is always negative in regressions list", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.9, b: 0.8, c: 0.7 });
    const current = makeRunRecord("c", "s", { a: 0.5, b: 0.4, c: 0.3 });

    let caught: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) caught = e;
    }

    for (const reg of caught!.regressions) {
      expect(reg.delta).toBeLessThan(0);
    }
  });

  it("EvalRunner regression message includes scorer id and both score values", async () => {
    const scorer = makeFixedScorer("faithfulness", 0.4, false);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["faithfulness", 0.9]]);
    const result = await runner.regressionCheck(makeDataset(1), baseline);

    const msg = result.regressions[0]!;
    expect(msg).toContain("faithfulness");
    // scores formatted to 3 decimal places
    expect(msg).toContain("0.400");
    expect(msg).toContain("0.900");
  });

  it("EvalRunner regressions array has one entry per failing scorer", async () => {
    const s1 = makeFixedScorer("A", 0.2, false);
    const s2 = makeFixedScorer("B", 0.3, false);
    const s3 = makeFixedScorer("C", 0.95, true);
    const runner = new EvalRunner({ scorers: [s1, s2, s3] });

    const baseline = new Map([
      ["A", 0.8],
      ["B", 0.8],
      ["C", 0.8],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.regressions).toHaveLength(2);
  });

  it("RegressionGateError with zero regressions has an empty regressions array", () => {
    const err = new RegressionGateError([]);
    expect(err.regressions).toHaveLength(0);
    expect(err).toBeInstanceOf(Error);
  });

  it("RegressionGateError formats scores to 4 decimal places", () => {
    const err = new RegressionGateError([
      {
        suiteName: "metric",
        baseline: 0.123456,
        current: 0.001234,
        delta: -0.122222,
      },
    ]);

    expect(err.message).toContain("0.1235"); // baseline rounded to 4dp
    expect(err.message).toContain("0.0012"); // current rounded to 4dp
    expect(err.message).toContain("-0.1222"); // delta rounded to 4dp
  });
});

// ===========================================================================
// 15. ciMode — EvalRunner throws on regression in CI
// ===========================================================================

describe("EvalRunner ciMode — throws instead of returning on regression", () => {
  it('ciMode=true throws "Eval regression detected" when regression found', async () => {
    const scorer = makeFixedScorer("dim", 0.3, false);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });

    const baseline = new Map([["dim", 0.8]]);
    await expect(
      runner.regressionCheck(makeDataset(1), baseline),
    ).rejects.toThrow("Eval regression detected");
  });

  it("ciMode=true does NOT throw when no regression found", async () => {
    const scorer = makeFixedScorer("dim", 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });

    const baseline = new Map([["dim", 0.8]]);
    const result = await runner.regressionCheck(makeDataset(1), baseline);
    expect(result.passed).toBe(true);
  });

  it("ciMode=false (default) returns result without throwing on regression", async () => {
    const scorer = makeFixedScorer("q", 0.2, false);
    const runner = new EvalRunner({ scorers: [scorer] }); // ciMode unset

    const baseline = new Map([["q", 0.9]]);
    const result = await runner.regressionCheck(makeDataset(1), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
  });
});

// ===========================================================================
// 16. compareBenchmarks — additional coverage
// ===========================================================================

describe("compareBenchmarks — additional cases", () => {
  it("union of improved+regressed+unchanged covers all scorer keys from both runs", () => {
    const current = makeBenchmarkResult("s", {
      a: 0.9,
      b: 0.5,
      c: 0.7,
      d: 0.6,
    });
    const previous = makeBenchmarkResult("s", { a: 0.7, b: 0.8, c: 0.7 });
    // c is in both (unchanged), d is only in current, a improved, b regressed

    const comp = compareBenchmarks(current, previous);
    const allKeys = [
      ...comp.improved,
      ...comp.regressed,
      ...comp.unchanged,
    ].sort();

    // Should cover a, b, c, d
    expect(allKeys).toContain("a");
    expect(allKeys).toContain("b");
    expect(allKeys).toContain("c");
    expect(allKeys).toContain("d");
  });

  it("scorer only in previous (dropped in current) is classified as regressed", () => {
    const current = makeBenchmarkResult("s", { a: 0.9 });
    const previous = makeBenchmarkResult("s", { a: 0.9, dropped: 0.8 });

    const comp = compareBenchmarks(current, previous);
    expect(comp.regressed).toContain("dropped");
  });

  it("scorer only in current (new) is classified as improved vs previous=0", () => {
    const current = makeBenchmarkResult("s", { a: 0.9, newMetric: 0.7 });
    const previous = makeBenchmarkResult("s", { a: 0.9 });

    const comp = compareBenchmarks(current, previous);
    expect(comp.improved).toContain("newMetric");
  });

  it("single scorer with identical values is unchanged", () => {
    const current = makeBenchmarkResult("s", { score: 0.75 });
    const previous = makeBenchmarkResult("s", { score: 0.75 });

    const comp = compareBenchmarks(current, previous);
    expect(comp.unchanged).toContain("score");
    expect(comp.improved).not.toContain("score");
    expect(comp.regressed).not.toContain("score");
  });

  it("handles large number of metrics (20) without error", () => {
    const n = 20;
    const scores = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`m${i}`, 0.5 + i * 0.02]),
    );
    const baselineScores = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`m${i}`, 0.4 + i * 0.02]),
    );

    const current = makeBenchmarkResult("s", scores);
    const previous = makeBenchmarkResult("s", baselineScores);

    const comp = compareBenchmarks(current, previous);
    const total =
      comp.improved.length + comp.regressed.length + comp.unchanged.length;
    expect(total).toBe(n);
    expect(comp.regressed).toHaveLength(0); // all improved or same
  });
});
