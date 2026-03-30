/**
 * ECO-115: Enhanced Eval Runner — concurrent evaluation with progress,
 * abort support, regression checks, and report formatting.
 */

import type { EvalDataset, EvalEntry } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalRunnerConfig {
  scorers: Scorer<EvalInput>[];
  /** Optional target executor to produce real outputs for each entry. */
  target?: (
    input: string,
    metadata?: Record<string, unknown>,
  ) => Promise<EvalTargetResult>;
  /** Max concurrent evaluations (default: 5) */
  concurrency?: number;
  /** AbortSignal to cancel evaluation */
  signal?: AbortSignal;
  /** Called after each entry is evaluated */
  onProgress?: (completed: number, total: number, latest: EvalReportEntry) => void;
  /** If true, regressionCheck throws on regression instead of returning */
  ciMode?: boolean;
}

export interface EvalTargetResult {
  output: string;
  latencyMs?: number;
  costCents?: number;
  traceId?: string;
}

export interface EvalReportEntry {
  entryId: string;
  scorerResults: ScorerResult[];
  aggregateScore: number;
  passed: boolean;
  targetLatencyMs?: number;
  targetCostCents?: number;
  traceId?: string;
}

export interface EvalReport {
  entries: EvalReportEntry[];
  byScorerAverage: Map<string, number>;
  overallPassRate: number;
  overallAvgScore: number;
  totalDurationMs: number;
}

export interface RegressionResult {
  passed: boolean;
  regressions: string[];
  averages: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private _current = 0;
  private readonly _max: number;
  private readonly _queue: Array<() => void> = [];

  constructor(max: number) {
    this._max = max;
  }

  async acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(() => {
        this._current++;
        resolve();
      });
    });
  }

  release(): void {
    this._current--;
    const next = this._queue.shift();
    if (next) {
      next();
    }
  }
}

// ---------------------------------------------------------------------------
// EvalRunner
// ---------------------------------------------------------------------------

export class EvalRunner {
  private readonly config: EvalRunnerConfig;

  constructor(config: EvalRunnerConfig) {
    this.config = config;
  }

  /**
   * Evaluate all entries in a dataset against all scorers.
   */
  async evaluateDataset(dataset: EvalDataset): Promise<EvalReport> {
    const { scorers, concurrency = 5, signal, onProgress, target } = this.config;
    const startTime = Date.now();
    const sem = new Semaphore(concurrency);
    const entries: EvalReportEntry[] = [];
    let completed = 0;

    const promises = dataset.entries.map(async (entry: EvalEntry) => {
      if (signal?.aborted) return;

      await sem.acquire();
      try {
        if (signal?.aborted) return;

        const scorerResults: ScorerResult[] = [];
        let targetResult: EvalTargetResult | null = null;
        if (target) {
          targetResult = await target(entry.input, entry.metadata);
        }

        for (const scorer of scorers) {
          if (signal?.aborted) break;

          const evalInput: EvalInput = {
            input: entry.input,
            output: targetResult?.output ?? entry.expectedOutput ?? '',
            reference: entry.expectedOutput,
            tags: entry.tags,
            metadata: entry.metadata,
          };

          const result = await scorer.score(evalInput);
          scorerResults.push(result);
        }

        if (signal?.aborted) return;

        const aggregateScore =
          scorerResults.length > 0
            ? scorerResults.reduce((sum, sr) => sum + sr.aggregateScore, 0) /
              scorerResults.length
            : 0;

        const reportEntry: EvalReportEntry = {
          entryId: entry.id,
          scorerResults,
          aggregateScore,
          passed: scorerResults.length > 0 && scorerResults.every((sr) => sr.passed),
          ...(typeof targetResult?.latencyMs === 'number'
            ? { targetLatencyMs: targetResult.latencyMs }
            : {}),
          ...(typeof targetResult?.costCents === 'number'
            ? { targetCostCents: targetResult.costCents }
            : {}),
          ...(typeof targetResult?.traceId === 'string'
            ? { traceId: targetResult.traceId }
            : {}),
        };

        entries.push(reportEntry);
        completed++;

        if (onProgress) {
          onProgress(completed, dataset.size, reportEntry);
        }
      } finally {
        sem.release();
      }
    });

    await Promise.all(promises);

    return buildReport(entries, startTime);
  }

  /**
   * Check for regressions against a baseline of scorer averages.
   */
  async regressionCheck(
    dataset: EvalDataset,
    baseline: Map<string, number>,
  ): Promise<RegressionResult> {
    const report = await this.evaluateDataset(dataset);
    const regressions: string[] = [];

    for (const [scorerId, baselineAvg] of baseline.entries()) {
      const currentAvg = report.byScorerAverage.get(scorerId);
      if (currentAvg !== undefined && currentAvg < baselineAvg) {
        regressions.push(
          `${scorerId}: ${currentAvg.toFixed(3)} < baseline ${baselineAvg.toFixed(3)}`,
        );
      }
    }

    const passed = regressions.length === 0;

    if (!passed && this.config.ciMode) {
      throw new Error(
        `Eval regression detected:\n${regressions.join('\n')}`,
      );
    }

    return {
      passed,
      regressions,
      averages: report.byScorerAverage,
    };
  }
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function buildReport(entries: EvalReportEntry[], startTime: number): EvalReport {
  const totalDurationMs = Date.now() - startTime;

  // Compute per-scorer averages
  const scorerSums = new Map<string, { total: number; count: number }>();

  for (const entry of entries) {
    for (const sr of entry.scorerResults) {
      const existing = scorerSums.get(sr.scorerId);
      if (existing) {
        existing.total += sr.aggregateScore;
        existing.count++;
      } else {
        scorerSums.set(sr.scorerId, { total: sr.aggregateScore, count: 1 });
      }
    }
  }

  const byScorerAverage = new Map<string, number>();
  for (const [scorerId, { total, count }] of scorerSums.entries()) {
    byScorerAverage.set(scorerId, count > 0 ? total / count : 0);
  }

  const overallPassRate =
    entries.length > 0
      ? entries.filter((e) => e.passed).length / entries.length
      : 0;

  const overallAvgScore =
    entries.length > 0
      ? entries.reduce((sum, e) => sum + e.aggregateScore, 0) / entries.length
      : 0;

  return {
    entries,
    byScorerAverage,
    overallPassRate,
    overallAvgScore,
    totalDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Report formatters
// ---------------------------------------------------------------------------

/**
 * Format an eval report as a Markdown table.
 */
export function reportToMarkdown(report: EvalReport): string {
  // Collect scorer IDs from entries
  const scorerIds = new Set<string>();
  for (const entry of report.entries) {
    for (const sr of entry.scorerResults) {
      scorerIds.add(sr.scorerId);
    }
  }
  const scorerColumns = [...scorerIds];

  // Header
  const headers = ['Entry', 'Score', 'Pass', ...scorerColumns];
  const separator = headers.map(() => '------');

  const rows = report.entries.map((entry) => {
    const passSymbol = entry.passed ? 'PASS' : 'FAIL';
    const scorerScores = scorerColumns.map((sid) => {
      const sr = entry.scorerResults.find((r) => r.scorerId === sid);
      return sr ? sr.aggregateScore.toFixed(2) : 'N/A';
    });
    return [
      entry.entryId,
      entry.aggregateScore.toFixed(2),
      passSymbol,
      ...scorerScores,
    ];
  });

  // Summary row
  const summaryRow = [
    '**Overall**',
    report.overallAvgScore.toFixed(2),
    `${(report.overallPassRate * 100).toFixed(0)}%`,
    ...scorerColumns.map((sid) => {
      const avg = report.byScorerAverage.get(sid);
      return avg !== undefined ? avg.toFixed(2) : 'N/A';
    }),
  ];

  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    `| ${summaryRow.join(' | ')} |`,
  ];

  return lines.join('\n');
}

/**
 * Format an eval report as a JSON string.
 */
export function reportToJSON(report: EvalReport): string {
  const serializable = {
    entries: report.entries,
    byScorerAverage: Object.fromEntries(report.byScorerAverage),
    overallPassRate: report.overallPassRate,
    overallAvgScore: report.overallAvgScore,
    totalDurationMs: report.totalDurationMs,
  };
  return JSON.stringify(serializable, null, 2);
}

/**
 * Format an eval report as GitHub Actions annotation strings.
 */
export function reportToCIAnnotations(report: EvalReport): string[] {
  const annotations: string[] = [];

  for (const entry of report.entries) {
    if (!entry.passed) {
      const failedScorers = entry.scorerResults
        .filter((sr) => !sr.passed)
        .map((sr) => `${sr.scorerId}=${sr.aggregateScore.toFixed(2)}`)
        .join(', ');

      annotations.push(
        `::error::Eval entry "${entry.entryId}" failed (score=${entry.aggregateScore.toFixed(2)}): ${failedScorers}`,
      );
    }
  }

  if (report.overallPassRate < 1.0) {
    annotations.push(
      `::warning::Overall eval pass rate: ${(report.overallPassRate * 100).toFixed(0)}% (avg score: ${report.overallAvgScore.toFixed(2)})`,
    );
  }

  return annotations;
}
