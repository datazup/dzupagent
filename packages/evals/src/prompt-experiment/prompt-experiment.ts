/**
 * PromptExperiment — A/B testing harness for system prompts.
 *
 * Takes 2+ system prompt variants and a test dataset, runs each variant
 * through an LLM + scorers, and determines which prompt is statistically
 * better via paired t-tests.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { EvalDataset, EvalEntry } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PromptVariant {
  id: string;
  name: string;
  systemPrompt: string;
  metadata?: Record<string, unknown>;
}

export interface ExperimentConfig {
  /** The LLM model to use for generating outputs */
  model: BaseChatModel;
  /** Scorers to evaluate outputs */
  scorers: Scorer<EvalInput>[];
  /** Max concurrent evaluations (default: 3) */
  concurrency?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: (variant: string, completed: number, total: number) => void;
}

export interface VariantResultEntry {
  entryId: string;
  output: string;
  scorerResults: ScorerResult[];
  aggregateScore: number;
}

export interface VariantResult {
  variantId: string;
  variantName: string;
  /** Per-entry results */
  entries: VariantResultEntry[];
  /** Aggregate metrics */
  avgScore: number;
  passRate: number;
  avgLatencyMs: number;
  avgCostCents: number;
  /** Per-scorer averages */
  scorerAverages: Record<string, number>;
}

export interface PairedComparison {
  variantA: string;
  variantB: string;
  /** Mean difference (A - B), positive means A is better */
  meanDifference: number;
  /** Standard error of the difference */
  standardError: number;
  /** 95% confidence interval [lower, upper] */
  confidenceInterval: [number, number];
  /** Two-tailed p-value (paired t-test) */
  pValue: number;
  /** Is the difference statistically significant at alpha=0.05? */
  significant: boolean;
  /** Winner or 'tie' */
  winner: string | 'tie';
  /** Human-readable summary */
  summary: string;
}

export interface ExperimentReport {
  /** Results per variant */
  variants: VariantResult[];
  /** Pairwise comparisons between all variants */
  comparisons: PairedComparison[];
  /** Overall winner (by highest avg score) */
  bestVariant: string;
  /** Is the winner significantly better than all others? */
  significantWinner: boolean;
  /** Total experiment duration */
  totalDurationMs: number;
  /** Number of entries evaluated per variant */
  datasetSize: number;
  /** Markdown-formatted report */
  toMarkdown(): string;
}

// ---------------------------------------------------------------------------
// Semaphore (concurrency limiter)
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
// Statistical helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  let sumSq = 0;
  for (const v of values) {
    const diff = v - avg;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Approximate the two-tailed p-value from a t-statistic and degrees of freedom.
 *
 * For df > 30 we use a normal approximation. For smaller df we use a rational
 * approximation of the incomplete beta function that backs the t-distribution CDF.
 */
function twoTailedPValue(t: number, df: number): number {
  const absT = Math.abs(t);

  if (df > 30) {
    // Normal approximation via the error function complement
    return erfc(absT / Math.SQRT2);
  }

  // Regularised incomplete beta function approach:
  // p = I_{x}(a, b) where x = df/(df + t^2), a = df/2, b = 0.5
  const x = df / (df + absT * absT);
  const a = df / 2;
  const b = 0.5;
  const ibeta = regularisedIncompleteBeta(x, a, b);
  return ibeta;
}

/**
 * Complementary error function approximation (Abramowitz & Stegun 7.1.26).
 */
function erfc(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 1 - sign * y;
}

/**
 * Regularised incomplete beta function I_x(a, b) via continued fraction
 * (Lentz's algorithm). Good enough for the t-distribution CDF with small df.
 */
function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use the symmetry relation if x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularisedIncompleteBeta(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (Lentz)
  const maxIter = 200;
  const eps = 1e-14;
  let f = 1.0;
  let c = 1.0;
  let d = 1.0 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < eps) d = eps;
  d = 1.0 / d;
  f = d;

  for (let m = 1; m <= maxIter; m++) {
    // Even step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1.0 + numerator * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1.0 + numerator / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1.0 / d;
    f *= c * d;

    // Odd step
    numerator =
      -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));
    d = 1.0 + numerator * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1.0 + numerator / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1.0 / d;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1.0) < eps) break;
  }

  return front * f;
}

/**
 * Log-gamma via Lanczos approximation.
 */
function lnGamma(z: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coefficients[0]!;
  for (let i = 1; i < g + 2; i++) {
    x += coefficients[i]! / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Perform a paired t-test between two arrays of scores (same length, paired by index).
 */
function pairedTTest(
  scoresA: number[],
  scoresB: number[],
  variantAName: string,
  variantBName: string,
): PairedComparison {
  const n = scoresA.length;

  if (n < 2) {
    return {
      variantA: variantAName,
      variantB: variantBName,
      meanDifference: 0,
      standardError: 0,
      confidenceInterval: [0, 0],
      pValue: 1,
      significant: false,
      winner: 'tie',
      summary: `Insufficient data (n=${n}) to compare ${variantAName} vs ${variantBName}.`,
    };
  }

  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    diffs.push(scoresA[i]! - scoresB[i]!);
  }

  const meanD = mean(diffs);
  const stdD = stddev(diffs, meanD);
  const se = stdD / Math.sqrt(n);

  let pValue: number;
  if (se === 0) {
    pValue = meanD === 0 ? 1 : 0;
  } else {
    const tStat = meanD / se;
    pValue = twoTailedPValue(tStat, n - 1);
  }

  // Clamp p-value to [0, 1]
  pValue = Math.max(0, Math.min(1, pValue));

  const ci: [number, number] = [meanD - 1.96 * se, meanD + 1.96 * se];
  const significant = pValue < 0.05;

  let winner: string | 'tie';
  if (!significant) {
    winner = 'tie';
  } else {
    winner = meanD > 0 ? variantAName : variantBName;
  }

  const directionWord = meanD > 0 ? 'better' : meanD < 0 ? 'worse' : 'equal to';
  const summary = significant
    ? `${variantAName} is significantly ${directionWord} ${variantBName} (p=${pValue.toFixed(4)})`
    : `No significant difference between ${variantAName} and ${variantBName} (p=${pValue.toFixed(4)})`;

  return {
    variantA: variantAName,
    variantB: variantBName,
    meanDifference: meanD,
    standardError: se,
    confidenceInterval: ci,
    pValue,
    significant,
    winner,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Markdown report formatter
// ---------------------------------------------------------------------------

function buildMarkdownReport(report: ExperimentReport): string {
  const lines: string[] = [];

  lines.push('# Prompt Experiment Report');
  lines.push('');

  // Variants table
  lines.push('## Variants');
  lines.push('| Variant | Avg Score | Pass Rate | Avg Latency |');
  lines.push('|---------|-----------|-----------|-------------|');
  for (const v of report.variants) {
    const latency = v.avgLatencyMs < 1000
      ? `${v.avgLatencyMs.toFixed(0)}ms`
      : `${(v.avgLatencyMs / 1000).toFixed(1)}s`;
    lines.push(
      `| ${v.variantName} | ${v.avgScore.toFixed(2)} | ${(v.passRate * 100).toFixed(0)}% | ${latency} |`,
    );
  }
  lines.push('');

  // Pairwise comparisons
  if (report.comparisons.length > 0) {
    lines.push('## Pairwise Comparisons');
    lines.push('| A vs B | \u0394 Score | 95% CI | p-value | Winner |');
    lines.push('|--------|---------|--------|---------|--------|');
    for (const c of report.comparisons) {
      const ciStr = `[${c.confidenceInterval[0].toFixed(2)}, ${c.confidenceInterval[1].toFixed(2)}]`;
      const winnerStr = c.winner === 'tie' ? 'tie' : `${c.winner} \u2713`;
      lines.push(
        `| ${c.variantA} vs ${c.variantB} | ${c.meanDifference >= 0 ? '' : ''}${c.meanDifference.toFixed(2)} | ${ciStr} | ${c.pValue.toFixed(4)} | ${winnerStr} |`,
      );
    }
    lines.push('');
  }

  // Recommendation
  lines.push('## Recommendation');
  if (report.significantWinner) {
    // Find the best comparison p-value for the winner
    const winnerComparisons = report.comparisons.filter(
      (c) => c.winner === report.bestVariant,
    );
    const bestP = winnerComparisons.length > 0
      ? Math.max(...winnerComparisons.map((c) => c.pValue))
      : 0;
    lines.push(
      `**${report.bestVariant}** is the winner (significantly better, p=${bestP.toFixed(4)})`,
    );
  } else {
    lines.push(
      `**${report.bestVariant}** has the highest average score, but the difference is not statistically significant.`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PromptExperiment
// ---------------------------------------------------------------------------

export class PromptExperiment {
  private readonly config: ExperimentConfig;

  constructor(config: ExperimentConfig) {
    this.config = config;
  }

  /**
   * Run the experiment across all variants.
   */
  async run(
    variants: PromptVariant[],
    dataset: EvalDataset,
  ): Promise<ExperimentReport> {
    if (variants.length < 2) {
      throw new Error('PromptExperiment requires at least 2 variants');
    }

    const { model, scorers, concurrency = 3, signal, onProgress } = this.config;
    const startTime = Date.now();
    const sem = new Semaphore(concurrency);

    const variantResults: VariantResult[] = [];

    for (const variant of variants) {
      if (signal?.aborted) break;

      const entryResults: VariantResultEntry[] = [];
      const latencies: number[] = [];
      const costs: number[] = [];
      let completed = 0;

      const promises = dataset.entries.map(async (entry: EvalEntry) => {
        if (signal?.aborted) return;

        await sem.acquire();
        try {
          if (signal?.aborted) return;

          // Invoke model
          const invokeStart = Date.now();
          const messages = [
            new SystemMessage(variant.systemPrompt),
            new HumanMessage(entry.input),
          ];
          const response = await model.invoke(messages);
          const latencyMs = Date.now() - invokeStart;
          latencies.push(latencyMs);

          // Extract output text
          const output =
            typeof response.content === 'string'
              ? response.content
              : Array.isArray(response.content)
                ? response.content
                    .filter(
                      (block): block is { type: 'text'; text: string } =>
                        typeof block === 'object' &&
                        block !== null &&
                        'type' in block &&
                        block.type === 'text',
                    )
                    .map((block) => block.text)
                    .join('')
                : String(response.content);

          // Extract cost if available from usage metadata
          const usageMetadata = response.usage_metadata as
            | { total_tokens?: number }
            | undefined;
          const costCents = usageMetadata?.total_tokens
            ? (usageMetadata.total_tokens / 1000) * 0.1
            : 0;
          costs.push(costCents);

          // Build eval input and run scorers
          const evalInput: EvalInput = {
            input: entry.input,
            output,
            reference: entry.expectedOutput,
            tags: entry.tags,
            latencyMs,
            costCents,
            metadata: entry.metadata,
          };

          const scorerResults: ScorerResult[] = [];
          for (const scorer of scorers) {
            if (signal?.aborted) break;
            const result = await scorer.score(evalInput);
            scorerResults.push(result);
          }

          if (signal?.aborted) return;

          const aggregateScore =
            scorerResults.length > 0
              ? scorerResults.reduce((sum, sr) => sum + sr.aggregateScore, 0) /
                scorerResults.length
              : 0;

          entryResults.push({
            entryId: entry.id,
            output,
            scorerResults,
            aggregateScore,
          });

          completed++;
          if (onProgress) {
            onProgress(variant.name, completed, dataset.size);
          }
        } finally {
          sem.release();
        }
      });

      await Promise.all(promises);

      if (signal?.aborted) break;

      // Compute variant-level aggregates
      const avgScore =
        entryResults.length > 0
          ? entryResults.reduce((s, e) => s + e.aggregateScore, 0) / entryResults.length
          : 0;

      const passRate =
        entryResults.length > 0
          ? entryResults.filter((e) =>
              e.scorerResults.length > 0 && e.scorerResults.every((sr) => sr.passed),
            ).length / entryResults.length
          : 0;

      const avgLatencyMs =
        latencies.length > 0 ? mean(latencies) : 0;

      const avgCostCents =
        costs.length > 0 ? mean(costs) : 0;

      // Per-scorer averages
      const scorerSums = new Map<string, { total: number; count: number }>();
      for (const entry of entryResults) {
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
      const scorerAverages: Record<string, number> = {};
      for (const [scorerId, { total, count }] of scorerSums.entries()) {
        scorerAverages[scorerId] = count > 0 ? total / count : 0;
      }

      variantResults.push({
        variantId: variant.id,
        variantName: variant.name,
        entries: entryResults,
        avgScore,
        passRate,
        avgLatencyMs,
        avgCostCents,
        scorerAverages,
      });
    }

    // Pairwise paired t-tests
    const comparisons: PairedComparison[] = [];
    for (let i = 0; i < variantResults.length; i++) {
      for (let j = i + 1; j < variantResults.length; j++) {
        const vA = variantResults[i]!;
        const vB = variantResults[j]!;

        // Align scores by entryId
        const entryIdOrder = dataset.entries.map((e: EvalEntry) => e.id);
        const scoresAByEntry = new Map<string, number>();
        const scoresBByEntry = new Map<string, number>();
        for (const e of vA.entries) scoresAByEntry.set(e.entryId, e.aggregateScore);
        for (const e of vB.entries) scoresBByEntry.set(e.entryId, e.aggregateScore);

        const scoresA: number[] = [];
        const scoresB: number[] = [];
        for (const id of entryIdOrder) {
          const a = scoresAByEntry.get(id);
          const b = scoresBByEntry.get(id);
          if (a !== undefined && b !== undefined) {
            scoresA.push(a);
            scoresB.push(b);
          }
        }

        comparisons.push(
          pairedTTest(scoresA, scoresB, vA.variantName, vB.variantName),
        );
      }
    }

    // Determine best variant
    let bestVariantName = variantResults[0]?.variantName ?? '';
    let bestAvgScore = variantResults[0]?.avgScore ?? 0;
    for (const v of variantResults) {
      if (v.avgScore > bestAvgScore) {
        bestAvgScore = v.avgScore;
        bestVariantName = v.variantName;
      }
    }

    // Check if the winner is significantly better than ALL others
    const significantWinner = comparisons
      .filter((c) => c.winner === bestVariantName)
      .length ===
      variantResults.length - 1;

    const totalDurationMs = Date.now() - startTime;

    const report: ExperimentReport = {
      variants: variantResults,
      comparisons,
      bestVariant: bestVariantName,
      significantWinner,
      totalDurationMs,
      datasetSize: dataset.size,
      toMarkdown() {
        return buildMarkdownReport(this);
      },
    };

    return report;
  }
}
