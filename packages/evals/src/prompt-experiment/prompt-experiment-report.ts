/**
 * Markdown report formatter for PromptExperiment results.
 *
 * Extracted from `prompt-experiment.ts` so the runner does not own
 * presentation logic. The function is pure: given an `ExperimentReport`
 * it returns a markdown string.
 */

import type { ExperimentReport } from './prompt-experiment-types.js';

export function buildMarkdownReport(report: ExperimentReport): string {
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
    lines.push('| A vs B | Δ Score | 95% CI | p-value | Winner |');
    lines.push('|--------|---------|--------|---------|--------|');
    for (const c of report.comparisons) {
      const ciStr = `[${c.confidenceInterval[0].toFixed(2)}, ${c.confidenceInterval[1].toFixed(2)}]`;
      const winnerStr = c.winner === 'tie' ? 'tie' : `${c.winner} ✓`;
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
