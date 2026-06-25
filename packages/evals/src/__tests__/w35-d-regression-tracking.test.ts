/**
 * Wave 35-D: Regression Tracking — comprehensive tests for baseline comparison,
 * score drift alerts, trend analysis, snapshot storage, run diff, regression
 * detection logic, multi-metric tracking, and edge cases.
 *
 * Covers:
 *  - compareBenchmarks (benchmark-runner.ts) — not previously tested in isolation
 *  - BenchmarkOrchestrator baseline management (setBaseline / getBaseline / compareRuns)
 *  - EvalRunner.regressionCheck (deeper coverage beyond enhanced-runner-coverage)
 *  - RegressionGateError metadata (suiteName, baseline, current, delta)
 *  - BenchmarkTrendStore multi-suite / multi-target dimension tracking
 *  - InMemoryBenchmarkRunStore (orchestrator-local, separate from trend store)
 *  - Edge cases: empty baseline, first run, tied scores, NaN-free arithmetic
 *
 * All tests are deterministic — no network, no LLM, no filesystem.
 */

import { describe, it, expect, beforeEach } from "vitest";

// --- benchmark-runner utilities ---
import { compareBenchmarks } from "../benchmarks/benchmark-runner.js";
import type { BenchmarkResult } from "../benchmarks/benchmark-types.js";

// --- benchmark-orchestrator: baseline management + regression gate ---
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

// --- enhanced runner regression check ---
import { EvalRunner } from "../runner/enhanced-runner.js";
import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";
import { EvalDataset } from "../dataset/eval-dataset.js";

// --- trend store ---
import {
  BenchmarkTrendStore,
  InMemoryBenchmarkRunStore,
  type BenchmarkRunRecord as TrendRunRecord,
} from "../benchmarks/benchmark-trend.js";

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
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId: "target-a",
    strict: true,
    createdAt: new Date().toISOString(),
    result: makeBenchmarkResult(suiteId, scores),
  };
}

// In-memory store that the BenchmarkOrchestrator can use (satisfies
// @dzupagent/eval-contracts BenchmarkRunStore interface).
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
    return {
      data: [...this.runs.values()],
      nextCursor: null,
      hasMore: false,
    };
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

function makeOrchestrator(
  store: BenchmarkRunStore = new InMemoryStore(),
): BenchmarkOrchestrator {
  return new BenchmarkOrchestrator({
    suites: {},
    executeTarget: async () => "",
    store,
  } satisfies BenchmarkOrchestratorConfig);
}

// Scorer that always returns a fixed score (used in EvalRunner tests).
function makeFixedScorer(
  id: string,
  score: number,
  passed = true,
): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: "deterministic" };
  const scoreFn = async (_input: EvalInput): Promise<ScorerResult> => ({
    scorerId: id,
    scores: [{ criterion: "test", score, reasoning: "fixed" }],
    aggregateScore: score,
    passed,
    durationMs: 0,
  });
  return { config, score: scoreFn };
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

// ===========================================================================
// 1. compareBenchmarks — diff between two eval runs
// ===========================================================================

describe("compareBenchmarks — run diff", () => {
  it("categorises improved, regressed, and unchanged scorers correctly", () => {
    const current = makeBenchmarkResult("s1", {
      accuracy: 0.9,
      f1: 0.5,
      latency: 0.7,
    });
    const previous = makeBenchmarkResult("s1", {
      accuracy: 0.7,
      f1: 0.8,
      latency: 0.7,
    });

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toContain("accuracy");
    expect(comparison.regressed).toContain("f1");
    expect(comparison.unchanged).toContain("latency");
  });

  it("returns all scorers in exactly one category", () => {
    const current = makeBenchmarkResult("s1", { a: 0.9, b: 0.3, c: 0.6 });
    const previous = makeBenchmarkResult("s1", { a: 0.6, b: 0.6, c: 0.6 });

    const comparison = compareBenchmarks(current, previous);
    const all = [
      ...comparison.improved,
      ...comparison.regressed,
      ...comparison.unchanged,
    ];

    expect(all.sort()).toEqual(["a", "b", "c"]);
  });

  it("treats identical scores as unchanged", () => {
    const current = makeBenchmarkResult("s1", { accuracy: 0.8, f1: 0.75 });
    const previous = makeBenchmarkResult("s1", { accuracy: 0.8, f1: 0.75 });

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toHaveLength(0);
    expect(comparison.regressed).toHaveLength(0);
    expect(comparison.unchanged).toHaveLength(2);
  });

  it("handles scorer present only in current (not in previous) as improved", () => {
    const current = makeBenchmarkResult("s1", {
      accuracy: 0.9,
      newMetric: 0.8,
    });
    const previous = makeBenchmarkResult("s1", { accuracy: 0.9 });

    const comparison = compareBenchmarks(current, previous);

    // newMetric: currentScore=0.8, previousScore=0 => improved
    expect(comparison.improved).toContain("newMetric");
  });

  it("handles scorer present only in previous (dropped in current) as regressed", () => {
    const current = makeBenchmarkResult("s1", { accuracy: 0.9 });
    const previous = makeBenchmarkResult("s1", {
      accuracy: 0.9,
      droppedMetric: 0.8,
    });

    const comparison = compareBenchmarks(current, previous);

    // droppedMetric: currentScore=0, previousScore=0.8 => regressed
    expect(comparison.regressed).toContain("droppedMetric");
  });

  it("handles empty both results as empty comparison", () => {
    const current = makeBenchmarkResult("s1", {});
    const previous = makeBenchmarkResult("s1", {});

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toHaveLength(0);
    expect(comparison.regressed).toHaveLength(0);
    expect(comparison.unchanged).toHaveLength(0);
  });

  it("uses EPSILON to avoid floating-point false regressions near 0", () => {
    // diff = 0.0005 which is within EPSILON=0.001 => unchanged
    const current = makeBenchmarkResult("s1", { score: 0.8005 });
    const previous = makeBenchmarkResult("s1", { score: 0.8 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.unchanged).toContain("score");
    expect(comparison.improved).not.toContain("score");
  });

  it("detects improvement when diff is just above EPSILON", () => {
    // diff = 0.0015 which exceeds EPSILON=0.001
    const current = makeBenchmarkResult("s1", { score: 0.8015 });
    const previous = makeBenchmarkResult("s1", { score: 0.8 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.improved).toContain("score");
  });

  it("handles multiple scorers all improving", () => {
    const current = makeBenchmarkResult("s1", {
      a: 0.9,
      b: 0.8,
      c: 0.95,
      d: 0.7,
    });
    const previous = makeBenchmarkResult("s1", {
      a: 0.5,
      b: 0.5,
      c: 0.5,
      d: 0.5,
    });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.improved).toHaveLength(4);
    expect(comparison.regressed).toHaveLength(0);
  });

  it("handles multiple scorers all regressing", () => {
    const current = makeBenchmarkResult("s1", { a: 0.3, b: 0.4, c: 0.2 });
    const previous = makeBenchmarkResult("s1", { a: 0.8, b: 0.9, c: 0.7 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.regressed).toHaveLength(3);
    expect(comparison.improved).toHaveLength(0);
  });

  it("handles perfect score to zero as regression", () => {
    const current = makeBenchmarkResult("s1", { accuracy: 0.0 });
    const previous = makeBenchmarkResult("s1", { accuracy: 1.0 });

    const comparison = compareBenchmarks(current, previous);
    expect(comparison.regressed).toContain("accuracy");
  });

  it("returns deterministic results regardless of key insertion order", () => {
    // current: b=0.9 (higher), a=0.3 (lower); previous: a=0.5 (higher), b=0.7 (lower)
    // a: current=0.3 vs previous=0.5 => regressed; b: current=0.9 vs previous=0.7 => improved
    const scores1 = { b: 0.9, a: 0.3 };
    const scores2 = { a: 0.5, b: 0.7 };

    const current = makeBenchmarkResult("s1", scores1);
    const previous = makeBenchmarkResult("s1", scores2);

    const comparison = compareBenchmarks(current, previous);

    // b: 0.9 vs 0.7 => improved; a: 0.3 vs 0.5 => regressed
    expect(comparison.improved).toContain("b");
    expect(comparison.regressed).toContain("a");
  });
});

// ===========================================================================
// 2. BenchmarkOrchestrator — baseline management
// ===========================================================================

describe("BenchmarkOrchestrator — baseline storage and retrieval", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("getBaseline returns null when no baseline is stored", async () => {
    const result = await orchestrator.getBaseline("suite-a", "target-a");
    expect(result).toBeNull();
  });

  it("setBaseline persists baseline and getBaseline retrieves it", async () => {
    // First save a run so setBaseline can find it
    const run = makeRunRecord("run-1", "suite-a", { accuracy: 0.85 });
    run.targetId = "target-a";
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-1",
    });

    expect(baseline.suiteId).toBe("suite-a");
    expect(baseline.targetId).toBe("target-a");
    expect(baseline.runId).toBe("run-1");
    expect(baseline.result.scores["accuracy"]).toBeCloseTo(0.85);

    const retrieved = await orchestrator.getBaseline("suite-a", "target-a");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe("run-1");
  });

  it("setBaseline overwrites when called again for same suite+target", async () => {
    const run1 = makeRunRecord("run-1", "suite-a", { accuracy: 0.7 });
    run1.targetId = "target-a";
    const run2 = makeRunRecord("run-2", "suite-a", { accuracy: 0.9 });
    run2.targetId = "target-a";
    await store.saveRun(run1);
    await store.saveRun(run2);

    await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-1",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-2",
    });

    const retrieved = await orchestrator.getBaseline("suite-a", "target-a");
    expect(retrieved!.runId).toBe("run-2");
    expect(retrieved!.result.scores["accuracy"]).toBeCloseTo(0.9);
  });

  it("setBaseline throws when runId does not exist", async () => {
    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-a",
        targetId: "target-a",
        runId: "ghost-run",
      }),
    ).rejects.toThrow("not found");
  });

  it("setBaseline throws when run belongs to different suiteId", async () => {
    const run = makeRunRecord("run-1", "other-suite", { accuracy: 0.8 });
    run.targetId = "target-a";
    await store.saveRun(run);

    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-a",
        targetId: "target-a",
        runId: "run-1",
      }),
    ).rejects.toThrow("suite");
  });

  it("setBaseline throws when run belongs to different targetId", async () => {
    const run = makeRunRecord("run-1", "suite-a", { accuracy: 0.8 });
    run.targetId = "other-target";
    await store.saveRun(run);

    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-a",
        targetId: "target-a",
        runId: "run-1",
      }),
    ).rejects.toThrow("target");
  });

  it("listBaselines returns all baselines", async () => {
    const runA = makeRunRecord("run-a", "suite-a", { score: 0.8 });
    runA.targetId = "target-a";
    const runB = makeRunRecord("run-b", "suite-b", { score: 0.9 });
    runB.targetId = "target-b";
    await store.saveRun(runA);
    await store.saveRun(runB);

    await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-a",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-b",
      targetId: "target-b",
      runId: "run-b",
    });

    const baselines = await orchestrator.listBaselines();
    expect(baselines).toHaveLength(2);
  });

  it("listBaselines filters by suiteId", async () => {
    const runA = makeRunRecord("run-a", "suite-a", { score: 0.8 });
    runA.targetId = "target-a";
    const runB = makeRunRecord("run-b", "suite-b", { score: 0.9 });
    runB.targetId = "target-b";
    await store.saveRun(runA);
    await store.saveRun(runB);

    await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-a",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-b",
      targetId: "target-b",
      runId: "run-b",
    });

    const baselines = await orchestrator.listBaselines({ suiteId: "suite-a" });
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.suiteId).toBe("suite-a");
  });

  it("listBaselines returns empty array when no baselines exist", async () => {
    const result = await orchestrator.listBaselines();
    expect(result).toEqual([]);
  });

  it("baseline record includes updatedAt timestamp", async () => {
    const before = new Date();
    const run = makeRunRecord("run-1", "suite-a", { score: 0.8 });
    run.targetId = "target-a";
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "target-a",
      runId: "run-1",
    });

    expect(baseline.updatedAt).toBeDefined();
    const updatedAt = new Date(baseline.updatedAt);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

// ===========================================================================
// 3. BenchmarkOrchestrator — compareRuns (diff between stored runs)
// ===========================================================================

describe("BenchmarkOrchestrator — compareRuns", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("compareRuns returns comparison with improved/regressed/unchanged", async () => {
    const current = makeRunRecord("run-current", "suite-a", {
      accuracy: 0.9,
      f1: 0.4,
    });
    const previous = makeRunRecord("run-previous", "suite-a", {
      accuracy: 0.7,
      f1: 0.8,
    });
    await store.saveRun(current);
    await store.saveRun(previous);

    const result = await orchestrator.compareRuns(
      "run-current",
      "run-previous",
    );

    expect(result.currentRun.id).toBe("run-current");
    expect(result.previousRun.id).toBe("run-previous");
    expect(result.comparison.improved).toContain("accuracy");
    expect(result.comparison.regressed).toContain("f1");
  });

  it("compareRuns throws when current run not found", async () => {
    const previous = makeRunRecord("run-previous", "suite-a", {
      accuracy: 0.7,
    });
    await store.saveRun(previous);

    await expect(
      orchestrator.compareRuns("ghost", "run-previous"),
    ).rejects.toThrow("Current run");
  });

  it("compareRuns throws when previous run not found", async () => {
    const current = makeRunRecord("run-current", "suite-a", { accuracy: 0.9 });
    await store.saveRun(current);

    await expect(
      orchestrator.compareRuns("run-current", "ghost"),
    ).rejects.toThrow("Previous run");
  });

  it("compareRuns returns all unchanged when scores are identical", async () => {
    const current = makeRunRecord("run-c", "suite-a", {
      accuracy: 0.8,
      f1: 0.75,
    });
    const previous = makeRunRecord("run-p", "suite-a", {
      accuracy: 0.8,
      f1: 0.75,
    });
    await store.saveRun(current);
    await store.saveRun(previous);

    const result = await orchestrator.compareRuns("run-c", "run-p");

    expect(result.comparison.improved).toHaveLength(0);
    expect(result.comparison.regressed).toHaveLength(0);
    expect(result.comparison.unchanged).toHaveLength(2);
  });
});

// ===========================================================================
// 4. Regression gate — score drift alerts
// ===========================================================================

describe("RegressionGate — score drift alerts", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("alerts (throws) when score drops by more than the threshold", () => {
    const baseline = makeRunRecord("b", "s", { quality: 0.9 });
    const current = makeRunRecord("c", "s", { quality: 0.7 }); // -0.2 drop

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("does not alert when score drops within threshold", () => {
    const baseline = makeRunRecord("b", "s", { quality: 0.9 });
    const current = makeRunRecord("c", "s", { quality: 0.87 }); // -0.03 drop

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("alert includes which metrics drifted", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.9, b: 0.8, c: 0.7 });
    const current = makeRunRecord("c", "s", { a: 0.6, b: 0.8, c: 0.6 });

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
    const drifted = caught!.regressions.map(
      (r: RegressionDetail) => r.suiteName,
    );
    expect(drifted).toContain("a");
    expect(drifted).toContain("c");
    expect(drifted).not.toContain("b");
  });

  it("alert delta values are negative when scores regress", () => {
    const baseline = makeRunRecord("b", "s", { q: 0.9 });
    const current = makeRunRecord("c", "s", { q: 0.6 });

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
    expect(reg.delta).toBeLessThan(0);
    expect(reg.delta).toBeCloseTo(-0.3);
  });

  it("alert fires only once per failing metric", () => {
    const baseline = makeRunRecord("b", "s", { q: 0.9 });
    const current = makeRunRecord("c", "s", { q: 0.5 });

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

    // Single scorer, should appear exactly once
    expect(caught!.regressions).toHaveLength(1);
  });

  it("no alert when all scores improve", () => {
    const baseline = makeRunRecord("b", "s", { a: 0.5, b: 0.6 });
    const current = makeRunRecord("c", "s", { a: 0.9, b: 0.95 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it("validates threshold=0 strictly — any drop triggers alert", () => {
    const baseline = makeRunRecord("b", "s", { q: 0.8 });
    const current = makeRunRecord("c", "s", { q: 0.7999 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0,
      }),
    ).toThrow(RegressionGateError);
  });

  it("throws RangeError for negative threshold", () => {
    const baseline = makeRunRecord("b", "s", { q: 0.8 });
    const current = makeRunRecord("c", "s", { q: 0.8 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: -0.05,
      }),
    ).toThrow(RangeError);
  });
});

// ===========================================================================
// 5. Regression detection logic — what counts as regression vs noise
// ===========================================================================

describe("Regression detection — signal vs noise", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("boundary: drop equal to threshold is NOT a regression (inclusive pass)", () => {
    // delta = 0.65 - 0.70 = -0.05; threshold = 0.05 => NOT < -(0.05+epsilon) => pass
    const baseline = makeRunRecord("b", "s", { score: 0.7 });
    const current = makeRunRecord("c", "s", { score: 0.65 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
  });

  it("boundary: drop one epsilon beyond threshold IS a regression", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.7 });
    const current = makeRunRecord("c", "s", { score: 0.6499 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("floating-point noise at exactly threshold does not fire (EPSILON guard)", () => {
    // 0.80 - 0.75 = 0.05 in IEEE 754 is sometimes -0.050000000000000044
    const baseline = makeRunRecord("b", "s", { score: 0.8 });
    const current = makeRunRecord("c", "s", { score: 0.75 });

    // Should NOT throw — the EPSILON in regressionGate prevents the false positive
    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).not.toThrow();
  });

  it("new scorers in current not present in baseline do not affect the gate", () => {
    const baseline = makeRunRecord("b", "s", { accuracy: 0.8 });
    const current = makeRunRecord("c", "s", {
      accuracy: 0.8,
      newDimension: 0.1,
    });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
  });

  it("scorer absent in current (dropped) is treated as score=0", () => {
    const baseline = makeRunRecord("b", "s", { required: 0.9 });
    const current = makeRunRecord("c", "s", {}); // required metric removed

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("generous threshold prevents alarm even on large regression", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.9 });
    const current = makeRunRecord("c", "s", { score: 0.5 }); // -0.4 drop

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.5,
    });

    expect(result.passed).toBe(true);
  });

  it("RegressionGateError contains all regressed suite names in message", () => {
    const baseline = makeRunRecord("b", "s", {
      "suite-1": 0.9,
      "suite-2": 0.8,
      "suite-3": 0.7,
    });
    const current = makeRunRecord("c", "s", {
      "suite-1": 0.5,
      "suite-2": 0.5,
      "suite-3": 0.5,
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

    expect(caught!.message).toContain("suite-1");
    expect(caught!.message).toContain("suite-2");
    expect(caught!.message).toContain("suite-3");
    expect(caught!.message).toContain("3 suite(s)");
  });
});

// ===========================================================================
// 6. Multi-metric tracking — multiple score dimensions
// ===========================================================================

describe("Multi-metric regression tracking", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("tracks 6 dimensions independently", () => {
    const dims = {
      accuracy: 0.8,
      precision: 0.75,
      recall: 0.7,
      f1: 0.72,
      latency: 0.9,
      cost: 0.95,
    };
    const baseline = makeRunRecord("b", "s", dims);
    // Only 'latency' drops beyond threshold
    const current = makeRunRecord("c", "s", {
      accuracy: 0.85, // improved
      precision: 0.75, // same
      recall: 0.72, // small improvement
      f1: 0.7, // within threshold
      latency: 0.7, // -0.2 > threshold
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

    expect(caught).toBeDefined();
    expect(caught!.regressions).toHaveLength(1);
    expect(caught!.regressions[0]!.suiteName).toBe("latency");
  });

  it("reports all dimensions that regressed beyond threshold", () => {
    const baseline = makeRunRecord("b", "s", {
      dim1: 0.9,
      dim2: 0.8,
      dim3: 0.7,
      dim4: 0.6,
    });
    const current = makeRunRecord("c", "s", {
      dim1: 0.5, // regressed
      dim2: 0.8, // same
      dim3: 0.3, // regressed
      dim4: 0.7, // improved
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

    const regrNames = caught!.regressions
      .map((r: RegressionDetail) => r.suiteName)
      .sort();
    expect(regrNames).toEqual(["dim1", "dim3"]);
  });

  it("EvalRunner.regressionCheck tracks all scorer dimensions", async () => {
    const s1 = makeFixedScorer("precision", 0.85, true);
    const s2 = makeFixedScorer("recall", 0.9, true);
    const s3 = makeFixedScorer("f1", 0.4, false);

    const runner = new EvalRunner({ scorers: [s1, s2, s3] });

    const baseline = new Map([
      ["precision", 0.8],
      ["recall", 0.85],
      ["f1", 0.8], // f1 regressed significantly
    ]);

    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    const failedDims = result.regressions.filter((r) => r.includes("f1"));
    expect(failedDims).toHaveLength(1);
    // precision and recall improved — not in regressions
    expect(result.regressions.every((r) => r.includes("f1"))).toBe(true);
  });

  it("EvalRunner result averages map contains all scorer dimensions", async () => {
    const s1 = makeFixedScorer("accuracy", 0.9, true);
    const s2 = makeFixedScorer("coverage", 0.7, true);
    const s3 = makeFixedScorer("coherence", 0.8, true);

    const runner = new EvalRunner({ scorers: [s1, s2, s3] });
    const result = await runner.regressionCheck(makeDataset(2), new Map());

    expect(result.averages.has("accuracy")).toBe(true);
    expect(result.averages.has("coverage")).toBe(true);
    expect(result.averages.has("coherence")).toBe(true);
    expect(result.averages.get("accuracy")).toBeCloseTo(0.9);
    expect(result.averages.get("coverage")).toBeCloseTo(0.7);
    expect(result.averages.get("coherence")).toBeCloseTo(0.8);
  });
});

// ===========================================================================
// 7. Snapshot storage and retrieval
// ===========================================================================

describe("Snapshot storage and retrieval", () => {
  let store: InMemoryStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryStore();
    orchestrator = makeOrchestrator(store);
  });

  it("getRun returns null for unknown runId", async () => {
    const result = await orchestrator.getRun("non-existent");
    expect(result).toBeNull();
  });

  it("saved run can be retrieved by id", async () => {
    const run = makeRunRecord("snap-1", "s", { score: 0.8 });
    await store.saveRun(run);

    const retrieved = await orchestrator.getRun("snap-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("snap-1");
    expect(retrieved!.result.scores["score"]).toBeCloseTo(0.8);
  });

  it("listRuns returns all stored runs", async () => {
    await store.saveRun(makeRunRecord("r1", "s", { s: 0.7 }));
    await store.saveRun(makeRunRecord("r2", "s", { s: 0.8 }));
    await store.saveRun(makeRunRecord("r3", "s", { s: 0.9 }));

    const page = await orchestrator.listRuns();
    expect(page.data).toHaveLength(3);
  });

  it("listRuns returns empty when no runs saved", async () => {
    const page = await orchestrator.listRuns();
    expect(page.data).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("run record preserves all score dimensions", async () => {
    const scores = { a: 0.1, b: 0.5, c: 0.9 };
    const run = makeRunRecord("snap-x", "s", scores);
    await store.saveRun(run);

    const retrieved = await orchestrator.getRun("snap-x");
    expect(retrieved!.result.scores).toEqual(scores);
  });

  it("BenchmarkTrendStore: appended runs appear in list", async () => {
    const trendMemStore = new InMemoryBenchmarkRunStore();

    const record: TrendRunRecord = {
      runId: "trend-1",
      suiteId: "suite-a",
      targetId: "model-x",
      timestamp: new Date().toISOString(),
      overallScore: 0.8,
      result: makeBenchmarkResult("suite-a", { overall: 0.8 }),
    };

    await trendMemStore.append(record);
    const listed = await trendMemStore.list("suite-a", "model-x");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.runId).toBe("trend-1");
  });

  it("BenchmarkTrendStore: runs for different suite/target are isolated", async () => {
    const trendMemStore = new InMemoryBenchmarkRunStore();

    await trendMemStore.append({
      runId: "r1",
      suiteId: "suite-a",
      targetId: "model-x",
      timestamp: new Date().toISOString(),
      overallScore: 0.8,
      result: makeBenchmarkResult("suite-a", { overall: 0.8 }),
    });
    await trendMemStore.append({
      runId: "r2",
      suiteId: "suite-b",
      targetId: "model-y",
      timestamp: new Date().toISOString(),
      overallScore: 0.5,
      result: makeBenchmarkResult("suite-b", { overall: 0.5 }),
    });

    const forA = await trendMemStore.list("suite-a", "model-x");
    const forB = await trendMemStore.list("suite-b", "model-y");

    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]!.runId).toBe("r1");
    expect(forB[0]!.runId).toBe("r2");
  });
});

// ===========================================================================
// 8. EvalRunner.regressionCheck — deeper baseline comparison
// ===========================================================================

describe("EvalRunner.regressionCheck — baseline comparison", () => {
  it("returns passed=true with empty baseline map", async () => {
    const scorer = makeFixedScorer("s1", 0.5, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const result = await runner.regressionCheck(makeDataset(2), new Map());
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("returns passed=true when all scores exactly match baseline", async () => {
    const scorer = makeFixedScorer("s1", 0.75, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["s1", 0.75]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
  });

  it("detects regression when current < baseline", async () => {
    const scorer = makeFixedScorer("quality", 0.6, false);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["quality", 0.8]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("quality");
    expect(result.regressions[0]).toContain("0.600");
    expect(result.regressions[0]).toContain("0.800");
  });

  it("regression message includes scorer id and both scores", async () => {
    const scorer = makeFixedScorer("factuality", 0.4, false);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["factuality", 0.9]]);
    const result = await runner.regressionCheck(makeDataset(1), baseline);

    const msg = result.regressions[0]!;
    expect(msg).toContain("factuality");
    expect(msg).toContain("0.400");
    expect(msg).toContain("0.900");
  });

  it("passes when score improves over baseline", async () => {
    const scorer = makeFixedScorer("coverage", 0.95, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([["coverage", 0.7]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("ciMode throws instead of returning on regression", async () => {
    const scorer = makeFixedScorer("faithfulness", 0.3, false);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });

    const baseline = new Map([["faithfulness", 0.8]]);

    await expect(
      runner.regressionCheck(makeDataset(1), baseline),
    ).rejects.toThrow("Eval regression detected");
  });

  it("regressions include all failing scorers with their values", async () => {
    const s1 = makeFixedScorer("dim1", 0.3, false);
    const s2 = makeFixedScorer("dim2", 0.4, false);
    const s3 = makeFixedScorer("dim3", 0.9, true);
    const runner = new EvalRunner({ scorers: [s1, s2, s3] });

    const baseline = new Map([
      ["dim1", 0.8],
      ["dim2", 0.7],
      ["dim3", 0.8],
    ]);

    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(2);
    const names = result.regressions.map((r) => r.split(":")[0]).join(",");
    expect(names).toContain("dim1");
    expect(names).toContain("dim2");
    expect(names).not.toContain("dim3");
  });

  it("averages computed correctly across multiple entries", async () => {
    let callCount = 0;
    // Returns 0.8 on odd calls, 0.6 on even calls — average = 0.7
    const scorer: Scorer<EvalInput> = {
      config: { id: "variable", name: "variable", type: "deterministic" },
      score: async () => {
        callCount++;
        const s = callCount % 2 === 1 ? 0.8 : 0.6;
        return {
          scorerId: "variable",
          scores: [{ criterion: "test", score: s, reasoning: "" }],
          aggregateScore: s,
          passed: true,
          durationMs: 0,
        };
      },
    };

    const runner = new EvalRunner({ scorers: [scorer] });
    const result = await runner.regressionCheck(makeDataset(2), new Map());

    // With 2 entries: (0.8 + 0.6) / 2 = 0.7
    expect(result.averages.get("variable")).toBeCloseTo(0.7);
  });
});

// ===========================================================================
// 9. Edge cases
// ===========================================================================

describe("Regression tracking — edge cases", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  it("first run with no prior baseline: gate against empty baseline passes", () => {
    const emptyBaseline = makeRunRecord("baseline-empty", "s", {});
    const current = makeRunRecord("current-1", "s", { score: 0.8 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: emptyBaseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("tied scores (current === baseline) are not regressions", () => {
    const scores = { a: 0.7, b: 0.6, c: 0.9 };
    const baseline = makeRunRecord("b", "s", { ...scores });
    const current = makeRunRecord("c", "s", { ...scores });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("score at 0.0 in baseline, 0.0 in current: not a regression", () => {
    const baseline = makeRunRecord("b", "s", { score: 0.0 });
    const current = makeRunRecord("c", "s", { score: 0.0 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).not.toThrow();
  });

  it("score at 1.0 in baseline, 1.0 in current: not a regression", () => {
    const baseline = makeRunRecord("b", "s", { score: 1.0 });
    const current = makeRunRecord("c", "s", { score: 1.0 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.0,
    });

    expect(result.passed).toBe(true);
  });

  it("EvalRunner with empty dataset returns empty regressions", async () => {
    const scorer = makeFixedScorer("s1", 0.5, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const emptyDataset = EvalDataset.from([]);
    const result = await runner.regressionCheck(
      emptyDataset,
      new Map([["s1", 0.8]]),
    );

    // No entries were evaluated, so byScorerAverage has no s1 entry
    // currentAvg === undefined so the condition is false — no regression
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("RegressionGateError with empty regressions array does not throw (defensive)", () => {
    // Constructing it directly should not throw
    const err = new RegressionGateError([]);
    expect(err).toBeInstanceOf(Error);
    expect(err.regressions).toHaveLength(0);
    expect(err.name).toBe("RegressionGateError");
  });

  it("RegressionGateError formats baseline and current values to 4 decimal places", () => {
    const err = new RegressionGateError([
      {
        suiteName: "perf",
        baseline: 0.123456,
        current: 0.001234,
        delta: -0.122222,
      },
    ]);

    expect(err.message).toContain("0.1235"); // baseline rounded
    expect(err.message).toContain("0.0012"); // current rounded
    expect(err.message).toContain("-0.1222"); // delta rounded
  });

  it("BenchmarkTrendStore: trend with 3 identical scores is stable (no first-run instability)", async () => {
    const trendStore = new BenchmarkTrendStore(new InMemoryBenchmarkRunStore());
    const baseStore = trendStore["store"] as InMemoryBenchmarkRunStore;

    for (let i = 0; i < 3; i++) {
      await baseStore.append({
        runId: `run-${i}`,
        suiteId: "first-suite",
        targetId: "model-a",
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        overallScore: 0.75,
        result: makeBenchmarkResult("first-suite", { overall: 0.75 }),
      });
    }

    const result = await trendStore.trend("first-suite", "model-a");
    expect(result.direction).toBe("stable");
    expect(result.deltaPerWave).toBeCloseTo(0);
  });

  it("compareBenchmarks with identical large-scale scores returns all unchanged", () => {
    const n = 20;
    const scores = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`metric-${i}`, 0.5 + i * 0.02]),
    );
    const current = makeBenchmarkResult("s1", { ...scores });
    const previous = makeBenchmarkResult("s1", { ...scores });

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toHaveLength(0);
    expect(comparison.regressed).toHaveLength(0);
    expect(comparison.unchanged).toHaveLength(n);
  });
});
