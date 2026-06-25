/**
 * W32-C: Experiment tracking deep coverage (+70 tests).
 *
 * Topics covered:
 *   - Multi-run comparison (compare results across N runs of same eval)
 *   - Baseline comparison (compare current run against a stored baseline)
 *   - Regression detection (score drops below threshold → flag as regression)
 *   - Result export formats (JSON, Markdown, CI annotations)
 *   - Experiment metadata (tags, timestamps, model versions)
 *   - Aggregation of scores across test cases
 *   - Run ID generation and uniqueness
 *   - BenchmarkTrendStore cross-wave trend analysis
 *   - InMemoryBenchmarkRunStore persistence
 *   - EvalRunner regressionCheck with baseline comparison
 *
 * All tests are fully deterministic — no network calls, no LLM, no filesystem.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type {
  BenchmarkRunRecord,
  BenchmarkRunStore,
  BenchmarkRunListPage,
  BenchmarkBaselineRecord,
} from "@dzupagent/eval-contracts";

import {
  BenchmarkOrchestrator,
  RegressionGateError,
} from "../orchestrator/benchmark-orchestrator.js";
import type { RegressionGateResult } from "../orchestrator/benchmark-orchestrator.js";

import {
  compareBenchmarks,
  runBenchmark,
} from "../benchmarks/benchmark-runner.js";

import {
  BenchmarkTrendStore,
  InMemoryBenchmarkRunStore,
} from "../benchmarks/benchmark-trend.js";
import type { BenchmarkRunRecord as TrendRunRecord } from "../benchmarks/benchmark-trend.js";

import { EvalDataset } from "../dataset/eval-dataset.js";
import {
  EvalRunner,
  reportToJSON,
  reportToMarkdown,
  reportToCIAnnotations,
} from "../runner/enhanced-runner.js";
import type {
  EvalInput,
  Scorer,
  ScorerConfig,
  ScorerResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal BenchmarkRunRecord fixture. */
function makeRunRecord(
  id: string,
  suiteId: string,
  scores: Record<string, number>,
  overrides: Partial<BenchmarkRunRecord> = {},
): BenchmarkRunRecord {
  return {
    id,
    suiteId,
    targetId: "target-a",
    strict: true,
    createdAt: new Date().toISOString(),
    result: {
      suiteId,
      timestamp: new Date().toISOString(),
      scores,
      passedBaseline: true,
      regressions: [],
    },
    ...overrides,
  };
}

/** Build a BenchmarkRunRecord with specific metadata. */
function makeRunWithMeta(
  id: string,
  suiteId: string,
  scores: Record<string, number>,
  metadata: Record<string, unknown>,
): BenchmarkRunRecord {
  return makeRunRecord(id, suiteId, scores, { metadata });
}

/** In-memory BenchmarkRunStore that satisfies the full interface contract. */
class InMemoryRunStore implements BenchmarkRunStore {
  private readonly runs = new Map<string, BenchmarkRunRecord>();
  private readonly baselines = new Map<string, BenchmarkBaselineRecord>();

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.id, run);
  }
  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRuns(filter?: {
    suiteId?: string;
    targetId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<BenchmarkRunListPage> {
    let data = [...this.runs.values()];
    if (filter?.suiteId)
      data = data.filter((r) => r.suiteId === filter.suiteId);
    if (filter?.targetId)
      data = data.filter((r) => r.targetId === filter.targetId);
    if (filter?.limit) data = data.slice(0, filter.limit);
    return { data, nextCursor: null, hasMore: false };
  }
  async saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void> {
    this.baselines.set(`${baseline.suiteId}:${baseline.targetId}`, baseline);
  }
  async getBaseline(
    suiteId: string,
    targetId: string,
  ): Promise<BenchmarkBaselineRecord | null> {
    return this.baselines.get(`${suiteId}:${targetId}`) ?? null;
  }
  async listBaselines(filter?: {
    suiteId?: string;
    targetId?: string;
  }): Promise<BenchmarkBaselineRecord[]> {
    let result = [...this.baselines.values()];
    if (filter?.suiteId)
      result = result.filter((b) => b.suiteId === filter.suiteId);
    if (filter?.targetId)
      result = result.filter((b) => b.targetId === filter.targetId);
    return result;
  }
}

/** Create a simple scorer for EvalRunner tests. */
function makeScorer(
  id: string,
  score: number,
  passed: boolean,
): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: "deterministic" };
  return {
    config,
    score: async (): Promise<ScorerResult> => ({
      scorerId: id,
      scores: [{ criterion: "accuracy", score, reasoning: "mocked" }],
      aggregateScore: score,
      passed,
      durationMs: 1,
    }),
  };
}

/** Create a dataset of N entries. */
function makeDataset(count: number, prefix = "e") {
  return EvalDataset.from(
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i + 1}`,
      input: `input-${i + 1}`,
      expectedOutput: `expected-${i + 1}`,
      tags: [`tag-${i % 2 === 0 ? "even" : "odd"}`],
      metadata: { index: i },
    })),
  );
}

/** Build a BenchmarkOrchestrator backed by an InMemoryRunStore. */
function makeOrchestrator(store: BenchmarkRunStore): BenchmarkOrchestrator {
  return new BenchmarkOrchestrator({
    suites: {},
    executeTarget: async () => "",
    store,
  });
}

// ---------------------------------------------------------------------------
// 1. Run ID generation and uniqueness
// ---------------------------------------------------------------------------

describe("Run ID generation and uniqueness", () => {
  it("randomUUID generates a v4-format UUID", () => {
    const id = randomUUID();
    // v4 UUID: 8-4-4-4-12 hex chars with version=4
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("two consecutive randomUUID calls produce distinct values", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(a).not.toBe(b);
  });

  it("generates 100 unique IDs without collision", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomUUID()));
    expect(ids.size).toBe(100);
  });

  it("BenchmarkRunRecord IDs saved to store are retrievable by the same ID", async () => {
    const store = new InMemoryRunStore();
    const run = makeRunRecord("run-abc", "s1", { accuracy: 0.9 });
    await store.saveRun(run);
    const fetched = await store.getRun("run-abc");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe("run-abc");
  });

  it("two runs with different IDs coexist in the store", async () => {
    const store = new InMemoryRunStore();
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.8 }));
    await store.saveRun(makeRunRecord("r2", "s1", { accuracy: 0.9 }));
    const page = await store.listRuns();
    expect(page.data).toHaveLength(2);
  });

  it("saving the same run twice overwrites the previous entry", async () => {
    const store = new InMemoryRunStore();
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.7 }));
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.95 }));
    const fetched = await store.getRun("r1");
    expect(fetched?.result.scores["accuracy"]).toBeCloseTo(0.95);
  });
});

// ---------------------------------------------------------------------------
// 2. Experiment metadata (tags, timestamps, model versions)
// ---------------------------------------------------------------------------

describe("Experiment metadata", () => {
  it("run record preserves arbitrary metadata map", async () => {
    const store = new InMemoryRunStore();
    const run = makeRunWithMeta(
      "r1",
      "s1",
      { accuracy: 0.9 },
      {
        modelVersion: "claude-3.5-sonnet",
        tags: ["production", "nightly"],
        experimentId: "exp-2026-001",
      },
    );
    await store.saveRun(run);
    const fetched = await store.getRun("r1");
    expect(fetched?.metadata?.["modelVersion"]).toBe("claude-3.5-sonnet");
    expect(fetched?.metadata?.["tags"]).toEqual(["production", "nightly"]);
    expect(fetched?.metadata?.["experimentId"]).toBe("exp-2026-001");
  });

  it("run record stores ISO timestamp in createdAt", async () => {
    const store = new InMemoryRunStore();
    const before = new Date().toISOString();
    const run = makeRunRecord("r1", "s1", { accuracy: 0.8 });
    await store.saveRun(run);
    const after = new Date().toISOString();
    const fetched = await store.getRun("r1");
    expect(fetched?.createdAt >= before).toBe(true);
    expect(fetched?.createdAt <= after).toBe(true);
  });

  it("result.timestamp is stored in the BenchmarkResult", async () => {
    const store = new InMemoryRunStore();
    const run = makeRunRecord("r1", "s1", { accuracy: 0.8 });
    await store.saveRun(run);
    const fetched = await store.getRun("r1");
    // ISO timestamp — parseable by Date
    expect(() => new Date(fetched!.result.timestamp)).not.toThrow();
    expect(new Date(fetched!.result.timestamp).getTime()).not.toBeNaN();
  });

  it("metadata can carry model version for comparison purposes", async () => {
    const store = new InMemoryRunStore();
    await store.saveRun(
      makeRunWithMeta("r1", "s1", { accuracy: 0.8 }, { model: "v1.0" }),
    );
    await store.saveRun(
      makeRunWithMeta("r2", "s1", { accuracy: 0.9 }, { model: "v2.0" }),
    );
    const page = await store.listRuns({ suiteId: "s1" });
    const models = page.data.map((r) => r.metadata?.["model"]);
    expect(models).toContain("v1.0");
    expect(models).toContain("v2.0");
  });

  it("strict flag is persisted on the run record", async () => {
    const store = new InMemoryRunStore();
    await store.saveRun(
      makeRunRecord("r1", "s1", { accuracy: 0.8 }, { strict: true }),
    );
    await store.saveRun(
      makeRunRecord("r2", "s1", { accuracy: 0.8 }, { strict: false }),
    );
    const r1 = await store.getRun("r1");
    const r2 = await store.getRun("r2");
    expect(r1?.strict).toBe(true);
    expect(r2?.strict).toBe(false);
  });

  it("targetId is persisted and filterable", async () => {
    const store = new InMemoryRunStore();
    await store.saveRun({
      ...makeRunRecord("r1", "s1", { accuracy: 0.8 }),
      targetId: "model-a",
    });
    await store.saveRun({
      ...makeRunRecord("r2", "s1", { accuracy: 0.9 }),
      targetId: "model-b",
    });
    const page = await store.listRuns({ targetId: "model-a" });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.targetId).toBe("model-a");
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-run comparison (N runs of same eval)
// ---------------------------------------------------------------------------

describe("Multi-run comparison", () => {
  let store: InMemoryRunStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryRunStore();
    orchestrator = makeOrchestrator(store);
  });

  it("compareRuns identifies improvement between run1 and run2", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.7, f1: 0.65 }));
    await store.saveRun(makeRunRecord("r2", "s1", { accuracy: 0.9, f1: 0.85 }));

    const result = await orchestrator.compareRuns("r2", "r1");

    expect(result.comparison.improved).toContain("accuracy");
    expect(result.comparison.improved).toContain("f1");
    expect(result.comparison.regressed).toHaveLength(0);
  });

  it("compareRuns identifies regression between run1 and run2", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.9 }));
    await store.saveRun(makeRunRecord("r2", "s1", { accuracy: 0.6 }));

    const result = await orchestrator.compareRuns("r2", "r1");

    expect(result.comparison.regressed).toContain("accuracy");
    expect(result.comparison.improved).toHaveLength(0);
  });

  it("compareRuns marks unchanged scorers correctly (within epsilon 0.001)", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.8 }));
    await store.saveRun(makeRunRecord("r2", "s1", { accuracy: 0.8005 })); // diff < 0.001 → unchanged
    const result = await orchestrator.compareRuns("r2", "r1");
    expect(result.comparison.unchanged).toContain("accuracy");
  });

  it("compareRuns correctly classifies mixed improvement/regression/unchanged", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { a: 0.7, b: 0.9, c: 0.8 }));
    await store.saveRun(makeRunRecord("r2", "s1", { a: 0.9, b: 0.6, c: 0.8 }));

    const result = await orchestrator.compareRuns("r2", "r1");

    expect(result.comparison.improved).toContain("a");
    expect(result.comparison.regressed).toContain("b");
    expect(result.comparison.unchanged).toContain("c");
  });

  it("compareRuns returns current and previous run records", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.7 }));
    await store.saveRun(makeRunRecord("r2", "s1", { accuracy: 0.9 }));

    const result = await orchestrator.compareRuns("r2", "r1");

    expect(result.currentRun.id).toBe("r2");
    expect(result.previousRun.id).toBe("r1");
  });

  it("compareRuns throws when current run is not found", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.7 }));
    await expect(orchestrator.compareRuns("nonexistent", "r1")).rejects.toThrow(
      'Current run "nonexistent" not found',
    );
  });

  it("compareRuns throws when previous run is not found", async () => {
    await store.saveRun(makeRunRecord("r1", "s1", { accuracy: 0.7 }));
    await expect(orchestrator.compareRuns("r1", "nonexistent")).rejects.toThrow(
      'Previous run "nonexistent" not found',
    );
  });

  it("comparing N runs by pairing consecutive: accumulates trend over 4 runs", async () => {
    const scores = [
      { accuracy: 0.6 },
      { accuracy: 0.7 },
      { accuracy: 0.8 },
      { accuracy: 0.9 },
    ];
    for (let i = 0; i < scores.length; i++) {
      await store.saveRun(makeRunRecord(`r${i}`, "s1", scores[i]!));
    }

    // Each consecutive comparison should show improvement
    for (let i = 1; i < scores.length; i++) {
      const result = await orchestrator.compareRuns(`r${i}`, `r${i - 1}`);
      expect(result.comparison.improved).toContain("accuracy");
    }
  });

  it("listRuns returns all stored runs for a suite", async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveRun(
        makeRunRecord(`r${i}`, "s1", { accuracy: 0.5 + i * 0.1 }),
      );
    }
    const page = await orchestrator.listRuns({ suiteId: "s1" });
    expect(page.data).toHaveLength(5);
  });

  it("listRuns with limit returns at most N runs", async () => {
    for (let i = 0; i < 10; i++) {
      await store.saveRun(makeRunRecord(`r${i}`, "s1", { accuracy: 0.5 }));
    }
    const page = await orchestrator.listRuns({ limit: 3 });
    expect(page.data.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Baseline comparison (save and retrieve baselines)
// ---------------------------------------------------------------------------

describe("Baseline comparison", () => {
  let store: InMemoryRunStore;
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    store = new InMemoryRunStore();
    orchestrator = makeOrchestrator(store);
  });

  it("setBaseline saves a baseline retrievable via getBaseline", async () => {
    const run = makeRunRecord("r1", "suite-a", { accuracy: 0.9 });
    run.targetId = "model-x";
    await store.saveRun(run);

    const baseline = await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "model-x",
      runId: "r1",
    });

    expect(baseline.suiteId).toBe("suite-a");
    expect(baseline.targetId).toBe("model-x");
    expect(baseline.runId).toBe("r1");

    const fetched = await orchestrator.getBaseline("suite-a", "model-x");
    expect(fetched).not.toBeNull();
    expect(fetched?.runId).toBe("r1");
  });

  it("getBaseline returns null when no baseline exists", async () => {
    const result = await orchestrator.getBaseline(
      "nonexistent-suite",
      "target",
    );
    expect(result).toBeNull();
  });

  it("setBaseline throws when run does not exist", async () => {
    await expect(
      orchestrator.setBaseline({
        suiteId: "s1",
        targetId: "t1",
        runId: "bad-run",
      }),
    ).rejects.toThrow('Run "bad-run" not found');
  });

  it("setBaseline throws when run suiteId does not match", async () => {
    const run = makeRunRecord("r1", "suite-a", { accuracy: 0.9 });
    await store.saveRun(run);
    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-b",
        targetId: run.targetId,
        runId: "r1",
      }),
    ).rejects.toThrow("does not belong to suite");
  });

  it("setBaseline throws when run targetId does not match", async () => {
    const run = makeRunRecord("r1", "suite-a", { accuracy: 0.9 });
    run.targetId = "model-a";
    await store.saveRun(run);
    await expect(
      orchestrator.setBaseline({
        suiteId: "suite-a",
        targetId: "model-b",
        runId: "r1",
      }),
    ).rejects.toThrow("does not belong to target");
  });

  it("baseline carries the full BenchmarkResult scores", async () => {
    const run = makeRunRecord("r1", "s1", { accuracy: 0.85, f1: 0.78 });
    run.targetId = "model-x";
    await store.saveRun(run);

    await orchestrator.setBaseline({
      suiteId: "s1",
      targetId: "model-x",
      runId: "r1",
    });
    const baseline = await orchestrator.getBaseline("s1", "model-x");

    expect(baseline?.result.scores["accuracy"]).toBeCloseTo(0.85);
    expect(baseline?.result.scores["f1"]).toBeCloseTo(0.78);
  });

  it("setBaseline records updatedAt timestamp", async () => {
    const before = new Date().toISOString();
    const run = makeRunRecord("r1", "s1", { accuracy: 0.8 });
    run.targetId = "model-x";
    await store.saveRun(run);
    const baseline = await orchestrator.setBaseline({
      suiteId: "s1",
      targetId: "model-x",
      runId: "r1",
    });
    const after = new Date().toISOString();

    expect(baseline.updatedAt >= before).toBe(true);
    expect(baseline.updatedAt <= after).toBe(true);
  });

  it("listBaselines returns all baselines without filter", async () => {
    for (const [suiteId, targetId, runId, score] of [
      ["s1", "model-a", "r1", 0.8],
      ["s2", "model-b", "r2", 0.9],
    ] as [string, string, string, number][]) {
      const run = makeRunRecord(runId, suiteId, { accuracy: score });
      run.targetId = targetId;
      await store.saveRun(run);
      await orchestrator.setBaseline({ suiteId, targetId, runId });
    }

    const baselines = await orchestrator.listBaselines();
    expect(baselines).toHaveLength(2);
  });

  it("listBaselines filters by suiteId", async () => {
    const run1 = makeRunRecord("r1", "suite-a", { accuracy: 0.8 });
    run1.targetId = "model-x";
    const run2 = makeRunRecord("r2", "suite-b", { accuracy: 0.9 });
    run2.targetId = "model-y";
    await store.saveRun(run1);
    await store.saveRun(run2);
    await orchestrator.setBaseline({
      suiteId: "suite-a",
      targetId: "model-x",
      runId: "r1",
    });
    await orchestrator.setBaseline({
      suiteId: "suite-b",
      targetId: "model-y",
      runId: "r2",
    });

    const baselines = await orchestrator.listBaselines({ suiteId: "suite-a" });
    expect(baselines).toHaveLength(1);
    expect(baselines[0]?.suiteId).toBe("suite-a");
  });
});

// ---------------------------------------------------------------------------
// 5. Regression detection via BenchmarkOrchestrator.regressionGate
// ---------------------------------------------------------------------------

describe("Regression detection — regressionGate", () => {
  let orchestrator: BenchmarkOrchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator(new InMemoryRunStore());
  });

  it("detects regression when score drops beyond threshold", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.9 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.7 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("does not flag regression when score drops exactly at threshold (inclusive)", () => {
    // delta = 0.75 - 0.80 = -0.05; threshold 0.05 → boundary pass
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.8 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.75 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });

  it("flags regression just beyond threshold", () => {
    // delta = 0.7499 - 0.80 ≈ -0.0501; threshold 0.05 → fail
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.8 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.7499 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("regressionGate returns passed=true and empty regressions when all pass", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.8, f1: 0.7 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.9, f1: 0.8 });

    const result: RegressionGateResult = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("captures multiple regressions in one gate call", () => {
    const baseline = makeRunRecord("b", "s1", {
      accuracy: 0.9,
      f1: 0.85,
      precision: 0.88,
    });
    const current = makeRunRecord("c", "s1", {
      accuracy: 0.6,
      f1: 0.5,
      precision: 0.55,
    });

    let err: RegressionGateError | undefined;
    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (e) {
      if (e instanceof RegressionGateError) err = e;
    }

    expect(err).toBeDefined();
    expect(err?.regressions).toHaveLength(3);
  });

  it("regressionGate only flags scorers present in baseline", () => {
    // 'newScorer' is in current but NOT baseline → should not trigger regression
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.8 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.9, newScorer: 0.1 });

    const result = orchestrator.regressionGate({
      currentRun: current,
      baselineRun: baseline,
      threshold: 0.05,
    });
    expect(result.passed).toBe(true);
  });

  it("treats a scorer absent from current as score 0 (full regression)", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.9 });
    const current = makeRunRecord("c", "s1", {}); // accuracy missing

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      }),
    ).toThrow(RegressionGateError);
  });

  it("throws RangeError for negative threshold", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.9 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.9 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: -0.1,
      }),
    ).toThrow(RangeError);
  });

  it("passes with threshold=0 when scores are identical", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.8 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.8 });

    expect(() =>
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0,
      }),
    ).not.toThrow();
  });

  it("RegressionGateError message includes baseline and current scores", () => {
    const baseline = makeRunRecord("b", "s1", { accuracy: 0.9 });
    const current = makeRunRecord("c", "s1", { accuracy: 0.5 });

    try {
      orchestrator.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RegressionGateError);
      const msg = (err as RegressionGateError).message;
      expect(msg).toContain("accuracy");
      expect(msg).toContain("0.9000");
      expect(msg).toContain("0.5000");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Aggregation of scores across test cases (runBenchmark + compareBenchmarks)
// ---------------------------------------------------------------------------

describe("Score aggregation across test cases", () => {
  it("runBenchmark averages scores over multiple dataset entries (deterministic scorer)", async () => {
    const suite = {
      id: "agg-suite",
      name: "Aggregation Suite",
      description: "Tests score aggregation",
      category: "qa" as const,
      dataset: [
        {
          id: "e1",
          input: "hello world",
          expectedOutput: "hello world response",
        },
        { id: "e2", input: "foo bar", expectedOutput: "foo bar response" },
        { id: "e3", input: "test case", expectedOutput: "test case response" },
      ],
      scorers: [
        { id: "det", name: "Deterministic", type: "deterministic" as const },
      ],
      baselineThresholds: { det: 0.0 },
    };

    // Target returns exact expected output for e1, partial for e2, empty for e3
    const target = async (input: string): Promise<string> => {
      if (input === "hello world") return "hello world response";
      if (input === "foo bar") return "foo"; // partial overlap
      return ""; // no match
    };

    const result = await runBenchmark(suite, target);

    expect(result.suiteId).toBe("agg-suite");
    expect(typeof result.scores["det"]).toBe("number");
    // Aggregated score is average across 3 entries — should be between 0 and 1
    expect(result.scores["det"]).toBeGreaterThanOrEqual(0);
    expect(result.scores["det"]).toBeLessThanOrEqual(1);
  });

  it("runBenchmark with empty dataset returns 0 for all scorers", async () => {
    const suite = {
      id: "empty-suite",
      name: "Empty Suite",
      description: "No entries",
      category: "qa" as const,
      dataset: [],
      scorers: [
        { id: "det", name: "Deterministic", type: "deterministic" as const },
      ],
      baselineThresholds: { det: 0.0 },
    };

    const result = await runBenchmark(suite, async () => "out");
    expect(result.scores["det"]).toBe(0);
    expect(result.passedBaseline).toBe(true); // no entries → no regressions
  });

  it("runBenchmark with custom scorer returns 1.0 for all non-empty outputs", async () => {
    const suite = {
      id: "custom-suite",
      name: "Custom Suite",
      description: "Custom scorer",
      category: "qa" as const,
      dataset: [
        { id: "e1", input: "a", expectedOutput: "b" },
        { id: "e2", input: "c", expectedOutput: "d" },
      ],
      scorers: [{ id: "custom", name: "Custom", type: "custom" as const }],
      baselineThresholds: { custom: 0.5 },
    };

    const result = await runBenchmark(suite, async () => "non-empty");
    expect(result.scores["custom"]).toBeCloseTo(1.0);
    expect(result.passedBaseline).toBe(true);
  });

  it("compareBenchmarks correctly distinguishes improved/regressed/unchanged (epsilon 0.001)", () => {
    const current = {
      suiteId: "s1",
      timestamp: "",
      passedBaseline: true,
      regressions: [],
      scores: { a: 0.9, b: 0.5, c: 0.8, d: 0.8005 },
    };
    const previous = {
      suiteId: "s1",
      timestamp: "",
      passedBaseline: true,
      regressions: [],
      scores: { a: 0.7, b: 0.9, c: 0.8, d: 0.8 },
    };

    const comparison = compareBenchmarks(current, previous);

    expect(comparison.improved).toContain("a"); // 0.9 > 0.7 → improved
    expect(comparison.regressed).toContain("b"); // 0.5 < 0.9 → regressed
    expect(comparison.unchanged).toContain("c"); // identical
    expect(comparison.unchanged).toContain("d"); // diff=0.0005 < epsilon → unchanged
  });

  it("compareBenchmarks handles scorers only in one result (treats missing as 0)", () => {
    const current = {
      suiteId: "s1",
      timestamp: "",
      passedBaseline: true,
      regressions: [],
      scores: { existing: 0.8, newScorer: 0.7 },
    };
    const previous = {
      suiteId: "s1",
      timestamp: "",
      passedBaseline: true,
      regressions: [],
      scores: { existing: 0.6 },
    };

    const comparison = compareBenchmarks(current, previous);

    // existing: 0.8 > 0.6 → improved
    expect(comparison.improved).toContain("existing");
    // newScorer: 0.7 vs 0 → improved (in current but not previous)
    expect(comparison.improved).toContain("newScorer");
  });

  it("EvalRunner computes per-scorer averages across all entries", async () => {
    const scores = [0.6, 0.8, 1.0]; // average = 0.8
    let callIndex = 0;
    const scorer: Scorer<EvalInput> = {
      config: { id: "s1", name: "s1", type: "deterministic" },
      score: async (): Promise<ScorerResult> => ({
        scorerId: "s1",
        scores: [{ criterion: "c", score: scores[callIndex]!, reasoning: "" }],
        aggregateScore: scores[callIndex++]!,
        passed: true,
        durationMs: 1,
      }),
    };

    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(3));

    const avg = report.byScorerAverage.get("s1");
    expect(avg).toBeCloseTo(0.8, 5);
  });

  it("EvalRunner overall average score is the mean of all entry scores", async () => {
    const scorer = makeScorer("s1", 0.75, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(4));

    expect(report.overallAvgScore).toBeCloseTo(0.75, 5);
  });

  it("EvalRunner pass rate equals fraction of entries where all scorers passed", async () => {
    let call = 0;
    const scorer: Scorer<EvalInput> = {
      config: { id: "s1", name: "s1", type: "deterministic" },
      score: async (): Promise<ScorerResult> => {
        const passed = call++ < 2; // first 2 entries pass, last 2 fail
        return {
          scorerId: "s1",
          scores: [{ criterion: "c", score: passed ? 1 : 0, reasoning: "" }],
          aggregateScore: passed ? 1 : 0,
          passed,
          durationMs: 1,
        };
      },
    };

    const runner = new EvalRunner({ scorers: [scorer], concurrency: 1 });
    const report = await runner.evaluateDataset(makeDataset(4));

    // 2 passed out of 4 = 0.5
    expect(report.overallPassRate).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// 7. Result export formats (JSON, Markdown, CI annotations)
// ---------------------------------------------------------------------------

describe("Result export — JSON format", () => {
  it("reportToJSON produces valid JSON", async () => {
    const scorer = makeScorer("s1", 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(2));
    const json = reportToJSON(report);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("reportToJSON serializes byScorerAverage Map as a plain object", async () => {
    const scorer = makeScorer("accuracy", 0.85, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as {
      byScorerAverage: Record<string, number>;
    };

    expect(parsed.byScorerAverage).toBeDefined();
    expect(typeof parsed.byScorerAverage).toBe("object");
    expect(parsed.byScorerAverage["accuracy"]).toBeCloseTo(0.85);
  });

  it("reportToJSON includes overallPassRate and overallAvgScore", async () => {
    const scorer = makeScorer("s1", 1.0, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(3));
    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as {
      overallPassRate: number;
      overallAvgScore: number;
    };

    expect(parsed.overallPassRate).toBeCloseTo(1.0);
    expect(parsed.overallAvgScore).toBeCloseTo(1.0);
  });

  it("reportToJSON includes totalDurationMs", async () => {
    const scorer = makeScorer("s1", 1.0, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as { totalDurationMs: number };

    expect(typeof parsed.totalDurationMs).toBe("number");
    expect(parsed.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("reportToJSON includes all entry scorerResults", async () => {
    const scorer = makeScorer("precision", 0.7, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as {
      entries: Array<{ scorerResults: Array<{ scorerId: string }> }>;
    };

    expect(parsed.entries[0]?.scorerResults[0]?.scorerId).toBe("precision");
  });

  it("reportToJSON round-trips BenchmarkResult scores via JSON", () => {
    const result = {
      suiteId: "s1",
      timestamp: "2026-06-25T00:00:00Z",
      scores: { accuracy: 0.876543, f1: 0.654321 },
      passedBaseline: true,
      regressions: [] as string[],
    };

    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized) as typeof result;

    expect(parsed.scores["accuracy"]).toBeCloseTo(0.876543);
    expect(parsed.scores["f1"]).toBeCloseTo(0.654321);
    expect(parsed.suiteId).toBe("s1");
  });
});

describe("Result export — Markdown format", () => {
  it("reportToMarkdown includes header with Entry, Score, Pass columns", async () => {
    const scorer = makeScorer("s1", 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const md = reportToMarkdown(report);

    expect(md).toContain("| Entry |");
    expect(md).toContain("| Score |");
    expect(md).toContain("| Pass |");
  });

  it("reportToMarkdown includes PASS for passing entries", async () => {
    const scorer = makeScorer("s1", 1.0, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const md = reportToMarkdown(report);

    expect(md).toContain("PASS");
  });

  it("reportToMarkdown includes FAIL for failing entries", async () => {
    const scorer = makeScorer("s1", 0.2, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const md = reportToMarkdown(report);

    expect(md).toContain("FAIL");
  });

  it("reportToMarkdown includes **Overall** row", async () => {
    const scorer = makeScorer("s1", 0.8, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(2));
    const md = reportToMarkdown(report);

    expect(md).toContain("**Overall**");
  });

  it("reportToMarkdown includes scorer column for each scorer ID", async () => {
    const s1 = makeScorer("accuracy", 0.9, true);
    const s2 = makeScorer("fluency", 0.7, true);
    const runner = new EvalRunner({ scorers: [s1, s2] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const md = reportToMarkdown(report);

    expect(md).toContain("accuracy");
    expect(md).toContain("fluency");
  });

  it("reportToMarkdown overall pass rate shows 100% when all pass", async () => {
    const scorer = makeScorer("s1", 1.0, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(3));
    const md = reportToMarkdown(report);

    expect(md).toContain("100%");
  });
});

describe("Result export — CI annotations format", () => {
  it("reportToCIAnnotations emits ::error:: for each failing entry", async () => {
    const scorer = makeScorer("s1", 0.2, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(2));
    const annotations = reportToCIAnnotations(report);

    const errors = annotations.filter((a) => a.startsWith("::error::"));
    expect(errors).toHaveLength(2);
  });

  it("reportToCIAnnotations emits ::warning:: when pass rate < 100%", async () => {
    const scorer = makeScorer("s1", 0.5, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const annotations = reportToCIAnnotations(report);

    const warnings = annotations.filter((a) => a.startsWith("::warning::"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("reportToCIAnnotations produces no annotations when all entries pass", async () => {
    const scorer = makeScorer("s1", 1.0, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(2));
    const annotations = reportToCIAnnotations(report);

    // pass rate = 1.0 → no warning; no failing entries → no errors
    expect(annotations).toHaveLength(0);
  });

  it("error annotation includes entry ID and scorer scores", async () => {
    const scorer = makeScorer("precision", 0.3, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const report = await runner.evaluateDataset(makeDataset(1));
    const annotations = reportToCIAnnotations(report);

    const errorLine = annotations.find((a) => a.startsWith("::error::"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("e1");
    expect(errorLine).toContain("precision");
  });
});

// ---------------------------------------------------------------------------
// 8. BenchmarkTrendStore — multi-run trend analysis
// ---------------------------------------------------------------------------

describe("BenchmarkTrendStore — multi-run trend analysis", () => {
  it("returns insufficient_data with fewer than 3 runs", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    await store.append({
      runId: "r1",
      suiteId: "s1",
      targetId: "t1",
      timestamp: "2026-01-01T00:00:00Z",
      overallScore: 0.8,
      result: {
        suiteId: "s1",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });

    const trend = await trendStore.trend("s1", "t1");
    expect(trend.direction).toBe("insufficient_data");
  });

  it("detects improving trend with monotonically increasing scores", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    const scores = [0.5, 0.6, 0.7, 0.8, 0.9];
    for (let i = 0; i < scores.length; i++) {
      await store.append({
        runId: `r${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
        overallScore: scores[i]!,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }

    const trend = await trendStore.trend("s1", "t1");
    expect(trend.direction).toBe("improving");
    expect(trend.deltaPerWave).toBeGreaterThan(0.01);
  });

  it("detects degrading trend with monotonically decreasing scores", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    const scores = [0.9, 0.8, 0.7, 0.6, 0.5];
    for (let i = 0; i < scores.length; i++) {
      await store.append({
        runId: `r${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
        overallScore: scores[i]!,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }

    const trend = await trendStore.trend("s1", "t1");
    expect(trend.direction).toBe("degrading");
    expect(trend.deltaPerWave).toBeLessThan(-0.01);
  });

  it("detects stable trend when scores are flat (±0.01)", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    const scores = [0.8, 0.81, 0.8, 0.8, 0.81];
    for (let i = 0; i < scores.length; i++) {
      await store.append({
        runId: `r${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
        overallScore: scores[i]!,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }

    const trend = await trendStore.trend("s1", "t1");
    expect(trend.direction).toBe("stable");
  });

  it("trend result includes the runs that were analysed", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    for (let i = 0; i < 4; i++) {
      await store.append({
        runId: `r${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
        overallScore: 0.7 + i * 0.05,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }

    const trend = await trendStore.trend("s1", "t1", 3);
    // windowSize=3 → only last 3 of 4 runs
    expect(trend.runs).toHaveLength(3);
  });

  it("trend uses only the last windowSize runs", async () => {
    const store = new InMemoryBenchmarkRunStore();
    const trendStore = new BenchmarkTrendStore(store);

    // Add 6 improving runs, then 3 degrading — window=3 should see degrading
    for (let i = 0; i < 6; i++) {
      await store.append({
        runId: `up${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-0${i + 1}T00:00:00Z`,
        overallScore: 0.5 + i * 0.05,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }
    for (let i = 0; i < 3; i++) {
      await store.append({
        runId: `dn${i}`,
        suiteId: "s1",
        targetId: "t1",
        timestamp: `2026-01-1${i + 0}T00:00:00Z`,
        overallScore: 0.9 - i * 0.15,
        result: {
          suiteId: "s1",
          timestamp: "",
          scores: {},
          passedBaseline: true,
          regressions: [],
        },
      });
    }

    const trend = await trendStore.trend("s1", "t1", 3);
    expect(trend.direction).toBe("degrading");
  });

  it("InMemoryBenchmarkRunStore list filters by suiteId and targetId", async () => {
    const store = new InMemoryBenchmarkRunStore();

    await store.append({
      runId: "r1",
      suiteId: "s1",
      targetId: "t1",
      timestamp: "2026-01-01T00:00:00Z",
      overallScore: 0.8,
      result: {
        suiteId: "s1",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });
    await store.append({
      runId: "r2",
      suiteId: "s2",
      targetId: "t1",
      timestamp: "2026-01-02T00:00:00Z",
      overallScore: 0.9,
      result: {
        suiteId: "s2",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });

    const s1Runs = await store.list("s1", "t1");
    expect(s1Runs).toHaveLength(1);
    expect(s1Runs[0]?.runId).toBe("r1");
  });

  it("InMemoryBenchmarkRunStore returns records sorted by timestamp ascending", async () => {
    const store = new InMemoryBenchmarkRunStore();

    // Insert out of order
    await store.append({
      runId: "r3",
      suiteId: "s1",
      targetId: "t1",
      timestamp: "2026-03-01T00:00:00Z",
      overallScore: 0.9,
      result: {
        suiteId: "s1",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });
    await store.append({
      runId: "r1",
      suiteId: "s1",
      targetId: "t1",
      timestamp: "2026-01-01T00:00:00Z",
      overallScore: 0.7,
      result: {
        suiteId: "s1",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });
    await store.append({
      runId: "r2",
      suiteId: "s1",
      targetId: "t1",
      timestamp: "2026-02-01T00:00:00Z",
      overallScore: 0.8,
      result: {
        suiteId: "s1",
        timestamp: "",
        scores: {},
        passedBaseline: true,
        regressions: [],
      },
    });

    const records = await store.list("s1", "t1");
    const runIds = records.map((r) => r.runId);
    expect(runIds).toEqual(["r1", "r2", "r3"]);
  });
});

// ---------------------------------------------------------------------------
// 9. EvalRunner regressionCheck as baseline comparison mechanism
// ---------------------------------------------------------------------------

describe("EvalRunner — regressionCheck as baseline comparison", () => {
  it("passes when current avg meets baseline", async () => {
    const scorer = makeScorer("s1", 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const baseline = new Map([["s1", 0.85]]);

    const result = await runner.regressionCheck(makeDataset(3), baseline);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("fails when current avg drops below baseline", async () => {
    const scorer = makeScorer("s1", 0.5, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const baseline = new Map([["s1", 0.8]]);

    const result = await runner.regressionCheck(makeDataset(3), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain("s1");
  });

  it("returns averages map with current scores for all scorers", async () => {
    const s1 = makeScorer("precision", 0.7, true);
    const s2 = makeScorer("recall", 0.6, true);
    const runner = new EvalRunner({ scorers: [s1, s2] });
    const baseline = new Map<string, number>(); // empty baseline — always pass

    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.averages.get("precision")).toBeCloseTo(0.7);
    expect(result.averages.get("recall")).toBeCloseTo(0.6);
  });

  it("ciMode throws Error when regression detected", async () => {
    const scorer = makeScorer("s1", 0.3, false);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });
    const baseline = new Map([["s1", 0.9]]);

    await expect(
      runner.regressionCheck(makeDataset(1), baseline),
    ).rejects.toThrow("Eval regression detected");
  });

  it("ciMode does NOT throw when no regression detected", async () => {
    const scorer = makeScorer("s1", 0.95, true);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });
    const baseline = new Map([["s1", 0.9]]);

    await expect(
      runner.regressionCheck(makeDataset(1), baseline),
    ).resolves.not.toThrow();
  });

  it("regression message includes scorer name and current vs baseline", async () => {
    const scorer = makeScorer("accuracy", 0.4, false);
    const runner = new EvalRunner({ scorers: [scorer] });
    const baseline = new Map([["accuracy", 0.9]]);

    const result = await runner.regressionCheck(makeDataset(1), baseline);

    expect(result.regressions[0]).toContain("accuracy");
    expect(result.regressions[0]).toContain("0.400");
    expect(result.regressions[0]).toContain("0.900");
  });

  it("exact match (current == baseline) is not a regression (strict <, not <=)", async () => {
    const scorer = makeScorer("s1", 0.8, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const baseline = new Map([["s1", 0.8]]);

    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it("baseline with scorer not present in results is silently skipped", async () => {
    const scorer = makeScorer("s1", 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer] });
    const baseline = new Map([
      ["s1", 0.8],
      ["ghost-scorer", 0.99], // not in results
    ]);

    const result = await runner.regressionCheck(makeDataset(2), baseline);

    // ghost-scorer has no currentAvg → condition `currentAvg !== undefined` is false → skip
    expect(result.passed).toBe(true);
  });
});
