/**
 * BenchmarkOrchestrator — suite runner + baseline management.
 *
 * Moved from @dzupagent/server (packages/server/src/services/benchmark-orchestrator.ts)
 * to @dzupagent/evals in MC-A02 to eliminate the server -> evals layer
 * inversion. Server consumes it via dependency injection through the
 * BenchmarkOrchestratorLike contract in @dzupagent/eval-contracts.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkBaselineRecord,
  BenchmarkCompareResult,
  BenchmarkOrchestratorLike,
  BenchmarkRunArtifactRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkRunRecord,
  BenchmarkRunStore,
  BenchmarkSuite,
} from "@dzupagent/eval-contracts";
import {
  compareBenchmarks,
  runBenchmark,
} from "../benchmarks/benchmark-runner.js";

// ---------------------------------------------------------------------------
// Regression gate types
// ---------------------------------------------------------------------------

/**
 * A single suite regression detail — emitted when a suite score drops below
 * the allowed delta from baseline.
 */
export interface RegressionDetail {
  /** The suite identifier that regressed */
  suiteName: string;
  /** Baseline average score (0–1) */
  baseline: number;
  /** Current average score (0–1) */
  current: number;
  /** current - baseline (negative when regressed) */
  delta: number;
}

/**
 * Result returned by {@link BenchmarkOrchestrator.regressionGate} when the
 * gate passes (no regressions beyond the threshold).
 */
export interface RegressionGateResult {
  passed: boolean;
  regressions: RegressionDetail[];
}

/**
 * Error thrown by {@link BenchmarkOrchestrator.regressionGate} when one or
 * more suites regress beyond the allowed threshold.
 *
 * The error carries the full list of failing suites so callers and CI scripts
 * can surface actionable details.
 */
export class RegressionGateError extends Error {
  public readonly regressions: RegressionDetail[];

  constructor(regressions: RegressionDetail[]) {
    const lines = regressions.map(
      (r) =>
        `  ${r.suiteName}: baseline=${r.baseline.toFixed(4)} current=${r.current.toFixed(4)} delta=${r.delta.toFixed(4)}`,
    );
    super(
      `Regression gate failed — ${regressions.length} suite(s) regressed beyond threshold:\n${lines.join("\n")}`,
    );
    this.name = "RegressionGateError";
    this.regressions = regressions;
  }
}

/**
 * Options accepted by {@link BenchmarkOrchestrator.regressionGate}.
 */
export interface RegressionGateOptions {
  /**
   * The current benchmark run to compare against the baseline.
   * Obtain this from a preceding {@link BenchmarkOrchestrator.runSuite} call.
   */
  currentRun: BenchmarkRunRecord;
  /**
   * The baseline benchmark run to compare against.
   * Obtain this from {@link BenchmarkOrchestrator.getBaseline} / a prior saved run.
   */
  baselineRun: BenchmarkRunRecord;
  /**
   * Maximum allowed score drop before a suite is considered regressed.
   * E.g. 0.05 means a 5-percentage-point drop is acceptable; anything
   * beyond that triggers the gate.  Must be a non-negative number.
   */
  threshold: number;
}

export interface BenchmarkOrchestratorConfig {
  suites: Record<string, BenchmarkSuite>;
  executeTarget: (
    targetId: string,
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>;
  allowNonStrictExecution?: boolean;
  store: BenchmarkRunStore;
}

export interface BenchmarkRunArtifactInput extends BenchmarkRunArtifactRecord {}

export class BenchmarkOrchestrator implements BenchmarkOrchestratorLike {
  constructor(private readonly config: BenchmarkOrchestratorConfig) {}

  async runSuite(input: {
    suiteId: string;
    targetId: string;
    strict?: boolean;
    metadata?: Record<string, unknown>;
    artifact?: BenchmarkRunArtifactInput;
  }): Promise<BenchmarkRunRecord> {
    const suite = this.config.suites[input.suiteId];
    if (!suite) {
      // Safe-prefixed so the route-error sanitizer forwards this actionable,
      // non-sensitive message to the client (and maps it to 404).
      throw new Error(`NotFound: Benchmark suite "${input.suiteId}" not found`);
    }

    const strict = input.strict === false ? false : true;
    if (!strict && this.config.allowNonStrictExecution !== true) {
      // Safe-prefixed (BadRequest → 400) deliberate validation guidance.
      throw new Error(
        "BadRequest: Benchmark non-strict execution is disabled. Set allowNonStrictExecution to true to opt out of strict mode.",
      );
    }

    const benchmarkConfig = strict
      ? ({ strict: true } as unknown as Parameters<typeof runBenchmark>[2])
      : undefined;

    const result = await runBenchmark(
      suite,
      async (datasetInput) =>
        this.config.executeTarget(input.targetId, datasetInput, input.metadata),
      benchmarkConfig,
    );

    const record: BenchmarkRunRecord = {
      id: randomUUID(),
      suiteId: suite.id,
      targetId: input.targetId,
      result,
      strict,
      createdAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.artifact ? { artifact: input.artifact } : {}),
    };
    await this.config.store.saveRun(record);
    return record;
  }

  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.config.store.getRun(runId);
  }

  async listRuns(
    filter?: BenchmarkRunListFilter,
  ): Promise<BenchmarkRunListPage> {
    return this.config.store.listRuns(filter);
  }

  async compareRuns(
    currentRunId: string,
    previousRunId: string,
  ): Promise<BenchmarkCompareResult> {
    const currentRun = await this.config.store.getRun(currentRunId);
    if (!currentRun) throw new Error(`Current run "${currentRunId}" not found`);
    const previousRun = await this.config.store.getRun(previousRunId);
    if (!previousRun)
      throw new Error(`Previous run "${previousRunId}" not found`);

    return {
      currentRun,
      previousRun,
      comparison: compareBenchmarks(currentRun.result, previousRun.result),
    };
  }

  async setBaseline(input: {
    suiteId: string;
    targetId: string;
    runId: string;
  }): Promise<BenchmarkBaselineRecord> {
    const run = await this.config.store.getRun(input.runId);
    if (!run) {
      throw new Error(`Run "${input.runId}" not found`);
    }
    if (run.suiteId !== input.suiteId) {
      throw new Error(
        `Run "${input.runId}" does not belong to suite "${input.suiteId}"`,
      );
    }
    if (run.targetId !== input.targetId) {
      throw new Error(
        `Run "${input.runId}" does not belong to target "${input.targetId}"`,
      );
    }

    const baseline: BenchmarkBaselineRecord = {
      suiteId: input.suiteId,
      targetId: input.targetId,
      runId: run.id,
      result: run.result,
      updatedAt: new Date().toISOString(),
    };
    await this.config.store.saveBaseline(baseline);
    return baseline;
  }

  async getBaseline(
    suiteId: string,
    targetId: string,
  ): Promise<BenchmarkBaselineRecord | null> {
    return this.config.store.getBaseline(suiteId, targetId);
  }

  async listBaselines(filter?: {
    suiteId?: string;
    targetId?: string;
  }): Promise<BenchmarkBaselineRecord[]> {
    return this.config.store.listBaselines(filter);
  }

  /**
   * Compare a current benchmark run against a baseline and enforce a regression
   * threshold.
   *
   * For every scorer present in the baseline run's result the method computes:
   *   delta = averageScore(current) - averageScore(baseline)
   *
   * A suite is considered **regressed** when `delta < -threshold`.
   *
   * When no regressions are found, returns `{ passed: true, regressions: [] }`.
   * When regressions are found, throws {@link RegressionGateError} containing
   * the full list of failing suites — this ensures the process exits non-zero
   * when wired into a CLI script.
   *
   * @throws {RegressionGateError} when any suite regresses beyond `threshold`.
   */
  regressionGate(opts: RegressionGateOptions): RegressionGateResult {
    const { currentRun, baselineRun, threshold } = opts;

    if (threshold < 0) {
      throw new RangeError(
        `regressionGate: threshold must be >= 0, got ${threshold}`,
      );
    }

    // Collect all scorer IDs present in the baseline scores
    const baselineScores = baselineRun.result.scores;
    const currentScores = currentRun.result.scores;

    const regressions: RegressionDetail[] = [];

    // A small epsilon prevents floating-point representation errors from
    // turning a score drop that is exactly equal to the threshold into a false
    // regression (e.g. 0.70 - 0.75 = -0.050000000000000044 in IEEE 754).
    // A drop is considered a regression only when it is STRICTLY GREATER than
    // the threshold: (baseline - current) > threshold.
    const EPSILON = 1e-9;

    for (const scorerId of Object.keys(baselineScores)) {
      const baseline = baselineScores[scorerId] ?? 0;
      const current = currentScores[scorerId] ?? 0;
      const delta = current - baseline;

      if (delta < -(threshold + EPSILON)) {
        regressions.push({
          suiteName: scorerId,
          baseline,
          current,
          delta,
        });
      }
    }

    if (regressions.length > 0) {
      throw new RegressionGateError(regressions);
    }

    return { passed: true, regressions: [] };
  }
}
