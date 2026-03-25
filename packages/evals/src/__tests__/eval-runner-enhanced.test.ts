import { describe, it, expect, vi } from 'vitest';
import { EvalDataset } from '../dataset/eval-dataset.js';
import {
  EvalRunner,
  reportToMarkdown,
  reportToCIAnnotations,
  reportToJSON,
} from '../runner/enhanced-runner.js';
import type { EvalReportEntry } from '../runner/enhanced-runner.js';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

function createMockScorer(
  id: string,
  scoreFn: (input: EvalInput) => Promise<ScorerResult>,
): Scorer<EvalInput> {
  const config: ScorerConfig = {
    id,
    name: id,
    type: 'deterministic',
  };
  return { config, score: scoreFn };
}

function createSimpleScorer(id: string, score: number, passed: boolean): Scorer<EvalInput> {
  return createMockScorer(id, async () => ({
    scorerId: id,
    scores: [{ criterion: 'test', score, reasoning: 'test reason' }],
    aggregateScore: score,
    passed,
    durationMs: 10,
  }));
}

function makeDataset(count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    id: `e${i + 1}`,
    input: `input-${i + 1}`,
    expectedOutput: `output-${i + 1}`,
  }));
  return EvalDataset.from(entries);
}

describe('EvalRunner', () => {
  describe('evaluateDataset', () => {
    it('scores all entries', async () => {
      const scorer = createSimpleScorer('s1', 0.9, true);
      const runner = new EvalRunner({ scorers: [scorer] });
      const dataset = makeDataset(3);

      const report = await runner.evaluateDataset(dataset);

      expect(report.entries).toHaveLength(3);
      expect(report.overallAvgScore).toBeCloseTo(0.9);
      expect(report.overallPassRate).toBe(1.0);
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('uses multiple scorers', async () => {
      const s1 = createSimpleScorer('s1', 1.0, true);
      const s2 = createSimpleScorer('s2', 0.5, false);
      const runner = new EvalRunner({ scorers: [s1, s2] });
      const dataset = makeDataset(2);

      const report = await runner.evaluateDataset(dataset);

      expect(report.entries).toHaveLength(2);
      // Each entry has aggregate (1.0 + 0.5) / 2 = 0.75
      expect(report.overallAvgScore).toBeCloseTo(0.75);
      // passed requires all scorers to pass, s2 fails so all entries fail
      expect(report.overallPassRate).toBe(0.0);
      // byScorerAverage
      expect(report.byScorerAverage.get('s1')).toBeCloseTo(1.0);
      expect(report.byScorerAverage.get('s2')).toBeCloseTo(0.5);
    });

    it('handles empty dataset', async () => {
      const scorer = createSimpleScorer('s1', 1.0, true);
      const runner = new EvalRunner({ scorers: [scorer] });
      const dataset = EvalDataset.from([]);

      const report = await runner.evaluateDataset(dataset);

      expect(report.entries).toHaveLength(0);
      expect(report.overallAvgScore).toBe(0);
      expect(report.overallPassRate).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('respects concurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const scorer = createMockScorer('conc-scorer', async () => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) {
          maxConcurrent = currentConcurrent;
        }
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 50));
        currentConcurrent--;
        return {
          scorerId: 'conc-scorer',
          scores: [{ criterion: 'test', score: 1.0, reasoning: 'ok' }],
          aggregateScore: 1.0,
          passed: true,
          durationMs: 50,
        };
      });

      const runner = new EvalRunner({ scorers: [scorer], concurrency: 2 });
      const dataset = makeDataset(6);

      await runner.evaluateDataset(dataset);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(maxConcurrent).toBeGreaterThan(0);
    });
  });

  describe('onProgress', () => {
    it('called after each entry', async () => {
      const scorer = createSimpleScorer('s1', 0.8, true);
      const progressCalls: Array<{ completed: number; total: number; entryId: string }> = [];

      const runner = new EvalRunner({
        scorers: [scorer],
        concurrency: 1,
        onProgress: (completed, total, latest) => {
          progressCalls.push({ completed, total, entryId: latest.entryId });
        },
      });

      const dataset = makeDataset(3);
      await runner.evaluateDataset(dataset);

      expect(progressCalls).toHaveLength(3);
      // With concurrency=1, progress should be sequential
      expect(progressCalls[0]!.completed).toBe(1);
      expect(progressCalls[0]!.total).toBe(3);
      expect(progressCalls[1]!.completed).toBe(2);
      expect(progressCalls[2]!.completed).toBe(3);
    });
  });

  describe('AbortSignal', () => {
    it('cancels evaluation', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const scorer = createMockScorer('abort-scorer', async () => {
        callCount++;
        if (callCount >= 2) {
          controller.abort();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          scorerId: 'abort-scorer',
          scores: [{ criterion: 'test', score: 1.0, reasoning: 'ok' }],
          aggregateScore: 1.0,
          passed: true,
          durationMs: 10,
        };
      });

      const runner = new EvalRunner({
        scorers: [scorer],
        concurrency: 1,
        signal: controller.signal,
      });

      const dataset = makeDataset(10);
      const report = await runner.evaluateDataset(dataset);

      // Should have stopped early — not all 10 entries evaluated
      expect(report.entries.length).toBeLessThan(10);
    });
  });

  describe('regressionCheck', () => {
    it('passes when above baseline', async () => {
      const scorer = createSimpleScorer('s1', 0.9, true);
      const runner = new EvalRunner({ scorers: [scorer] });
      const dataset = makeDataset(3);

      const baseline = new Map([['s1', 0.8]]);
      const result = await runner.regressionCheck(dataset, baseline);

      expect(result.passed).toBe(true);
      expect(result.regressions).toHaveLength(0);
      expect(result.averages.get('s1')).toBeCloseTo(0.9);
    });

    it('fails when below baseline', async () => {
      const scorer = createSimpleScorer('s1', 0.5, false);
      const runner = new EvalRunner({ scorers: [scorer] });
      const dataset = makeDataset(3);

      const baseline = new Map([['s1', 0.8]]);
      const result = await runner.regressionCheck(dataset, baseline);

      expect(result.passed).toBe(false);
      expect(result.regressions).toHaveLength(1);
      expect(result.regressions[0]).toContain('s1');
    });

    it('throws in ciMode on regression', async () => {
      const scorer = createSimpleScorer('s1', 0.3, false);
      const runner = new EvalRunner({ scorers: [scorer], ciMode: true });
      const dataset = makeDataset(2);

      const baseline = new Map([['s1', 0.8]]);

      await expect(runner.regressionCheck(dataset, baseline)).rejects.toThrow(
        'regression',
      );
    });
  });
});

describe('reportToMarkdown', () => {
  it('produces valid markdown table', () => {
    const report = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.9, passed: true, durationMs: 10 },
            { scorerId: 's2', scores: [], aggregateScore: 0.8, passed: true, durationMs: 10 },
          ],
          aggregateScore: 0.85,
          passed: true,
        },
        {
          entryId: 'e2',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.4, passed: false, durationMs: 10 },
            { scorerId: 's2', scores: [], aggregateScore: 0.6, passed: false, durationMs: 10 },
          ],
          aggregateScore: 0.5,
          passed: false,
        },
      ] as EvalReportEntry[],
      byScorerAverage: new Map([['s1', 0.65], ['s2', 0.7]]),
      overallPassRate: 0.5,
      overallAvgScore: 0.675,
      totalDurationMs: 100,
    };

    const md = reportToMarkdown(report);

    // Should contain header row
    expect(md).toContain('Entry');
    expect(md).toContain('Score');
    expect(md).toContain('Pass');
    expect(md).toContain('s1');
    expect(md).toContain('s2');
    // Should contain entry rows
    expect(md).toContain('e1');
    expect(md).toContain('e2');
    expect(md).toContain('PASS');
    expect(md).toContain('FAIL');
    // Should contain separator
    expect(md).toContain('------');
    // Should be pipe-separated
    expect(md).toContain('|');
  });
});

describe('reportToJSON', () => {
  it('produces valid JSON string', () => {
    const report = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [],
          aggregateScore: 0.9,
          passed: true,
        },
      ] as EvalReportEntry[],
      byScorerAverage: new Map([['s1', 0.9]]),
      overallPassRate: 1.0,
      overallAvgScore: 0.9,
      totalDurationMs: 50,
    };

    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed).toHaveProperty('entries');
    expect(parsed).toHaveProperty('byScorerAverage');
    expect(parsed).toHaveProperty('overallPassRate', 1.0);
    expect(parsed).toHaveProperty('overallAvgScore', 0.9);
  });
});

describe('reportToCIAnnotations', () => {
  it('produces annotation strings for failed entries', () => {
    const report = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.4, passed: false, durationMs: 10 },
          ],
          aggregateScore: 0.4,
          passed: false,
        },
        {
          entryId: 'e2',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.9, passed: true, durationMs: 10 },
          ],
          aggregateScore: 0.9,
          passed: true,
        },
      ] as EvalReportEntry[],
      byScorerAverage: new Map([['s1', 0.65]]),
      overallPassRate: 0.5,
      overallAvgScore: 0.65,
      totalDurationMs: 50,
    };

    const annotations = reportToCIAnnotations(report);

    // Should have error for e1 and warning for overall
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    const errorAnnotation = annotations.find((a) => a.startsWith('::error::'));
    expect(errorAnnotation).toBeDefined();
    expect(errorAnnotation).toContain('e1');
    expect(errorAnnotation).toContain('s1');

    const warningAnnotation = annotations.find((a) => a.startsWith('::warning::'));
    expect(warningAnnotation).toBeDefined();
    expect(warningAnnotation).toContain('50%');
  });

  it('produces no annotations for all-passing report', () => {
    const report = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 1.0, passed: true, durationMs: 10 },
          ],
          aggregateScore: 1.0,
          passed: true,
        },
      ] as EvalReportEntry[],
      byScorerAverage: new Map([['s1', 1.0]]),
      overallPassRate: 1.0,
      overallAvgScore: 1.0,
      totalDurationMs: 10,
    };

    const annotations = reportToCIAnnotations(report);
    expect(annotations).toHaveLength(0);
  });
});
