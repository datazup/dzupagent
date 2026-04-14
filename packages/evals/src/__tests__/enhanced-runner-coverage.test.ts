/**
 * Enhanced coverage tests for EvalRunner — targeting gaps in
 * strict mode, output/reference separation, error handling,
 * report generation edge cases, and concurrency behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import { EvalDataset } from '../dataset/eval-dataset.js';
import {
  EvalRunner,
  reportToMarkdown,
  reportToCIAnnotations,
  reportToJSON,
} from '../runner/enhanced-runner.js';
import type { EvalReport, EvalReportEntry } from '../runner/enhanced-runner.js';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockScorer(
  id: string,
  scoreFn: (input: EvalInput) => Promise<ScorerResult>,
): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: 'deterministic' };
  return { config, score: scoreFn };
}

function createSimpleScorer(id: string, score: number, passed: boolean): Scorer<EvalInput> {
  return createMockScorer(id, async () => ({
    scorerId: id,
    scores: [{ criterion: 'test', score, reasoning: 'test reason' }],
    aggregateScore: score,
    passed,
    durationMs: 1,
  }));
}

function makeDataset(count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    id: `e${i + 1}`,
    input: `input-${i + 1}`,
    expectedOutput: `expected-${i + 1}`,
  }));
  return EvalDataset.from(entries);
}

// ---------------------------------------------------------------------------
// Output vs Reference separation (the core CODEX_ANALYSIS issue)
// ---------------------------------------------------------------------------

describe('EvalRunner — output vs reference separation', () => {
  it('passes target output as "output" and expectedOutput as "reference"', async () => {
    const capturedInputs: EvalInput[] = [];
    const scorer = createMockScorer('capture', async (input) => {
      capturedInputs.push({ ...input });
      return {
        scorerId: 'capture',
        scores: [{ criterion: 'test', score: 1, reasoning: 'ok' }],
        aggregateScore: 1,
        passed: true,
        durationMs: 1,
      };
    });

    const runner = new EvalRunner({
      scorers: [scorer],
      target: async (input) => ({ output: `target-output-for-${input}` }),
    });

    await runner.evaluateDataset(
      EvalDataset.from([{ id: 'e1', input: 'hello', expectedOutput: 'ref-hello' }]),
    );

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.output).toBe('target-output-for-hello');
    expect(capturedInputs[0]!.reference).toBe('ref-hello');
    expect(capturedInputs[0]!.output).not.toBe(capturedInputs[0]!.reference);
  });

  it('when no target is provided, output falls back to expectedOutput (same as reference)', async () => {
    // This documents the known fallback behavior: output === reference
    const capturedInputs: EvalInput[] = [];
    const scorer = createMockScorer('capture', async (input) => {
      capturedInputs.push({ ...input });
      return {
        scorerId: 'capture',
        scores: [{ criterion: 'test', score: 1, reasoning: 'ok' }],
        aggregateScore: 1,
        passed: true,
        durationMs: 1,
      };
    });

    const runner = new EvalRunner({ scorers: [scorer] });

    await runner.evaluateDataset(
      EvalDataset.from([{ id: 'e1', input: 'hello', expectedOutput: 'expected-hello' }]),
    );

    expect(capturedInputs).toHaveLength(1);
    // Without target, output falls back to expectedOutput — same as reference
    expect(capturedInputs[0]!.output).toBe('expected-hello');
    expect(capturedInputs[0]!.reference).toBe('expected-hello');
    expect(capturedInputs[0]!.output).toBe(capturedInputs[0]!.reference);
  });

  it('when no target and no expectedOutput, output falls back to empty string', async () => {
    const capturedInputs: EvalInput[] = [];
    const scorer = createMockScorer('capture', async (input) => {
      capturedInputs.push({ ...input });
      return {
        scorerId: 'capture',
        scores: [{ criterion: 'test', score: 0, reasoning: 'empty' }],
        aggregateScore: 0,
        passed: false,
        durationMs: 1,
      };
    });

    const runner = new EvalRunner({ scorers: [scorer] });

    await runner.evaluateDataset(
      EvalDataset.from([{ id: 'e1', input: 'hello' }]),
    );

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.output).toBe('');
    expect(capturedInputs[0]!.reference).toBeUndefined();
  });

  it('passes entry tags and metadata through to scorer input', async () => {
    const capturedInputs: EvalInput[] = [];
    const scorer = createMockScorer('capture', async (input) => {
      capturedInputs.push({ ...input });
      return {
        scorerId: 'capture',
        scores: [{ criterion: 'test', score: 1, reasoning: 'ok' }],
        aggregateScore: 1,
        passed: true,
        durationMs: 1,
      };
    });

    const runner = new EvalRunner({
      scorers: [scorer],
      target: async () => ({ output: 'out' }),
    });

    await runner.evaluateDataset(
      EvalDataset.from([
        {
          id: 'e1',
          input: 'hello',
          expectedOutput: 'ref',
          tags: ['tagA', 'tagB'],
          metadata: { domain: 'test' },
        },
      ]),
    );

    expect(capturedInputs[0]!.tags).toEqual(['tagA', 'tagB']);
    expect(capturedInputs[0]!.metadata).toEqual({ domain: 'test' });
  });

  it('passes entry metadata to target executor', async () => {
    const capturedMeta: Array<Record<string, unknown> | undefined> = [];
    const scorer = createSimpleScorer('s1', 1, true);

    const runner = new EvalRunner({
      scorers: [scorer],
      target: async (_input, metadata) => {
        capturedMeta.push(metadata);
        return { output: 'out' };
      },
    });

    await runner.evaluateDataset(
      EvalDataset.from([
        { id: 'e1', input: 'hello', metadata: { key: 'val' } },
      ]),
    );

    expect(capturedMeta).toHaveLength(1);
    expect(capturedMeta[0]).toEqual({ key: 'val' });
  });
});

// ---------------------------------------------------------------------------
// Strict mode
// ---------------------------------------------------------------------------

describe('EvalRunner — strict mode enforcement', () => {
  it('throws in strict mode without target', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({ scorers: [scorer], strict: true });

    await expect(runner.evaluateDataset(makeDataset(1))).rejects.toThrow(
      'EvalRunner strict mode requires a target executor',
    );
  });

  it('does not throw in strict mode with target', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      strict: true,
      target: async () => ({ output: 'out' }),
    });

    const report = await runner.evaluateDataset(makeDataset(1));
    expect(report.entries).toHaveLength(1);
  });

  it('does not throw in non-strict mode without target (default fallback)', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const report = await runner.evaluateDataset(makeDataset(1));
    expect(report.entries).toHaveLength(1);
  });

  it('throws when missingTargetFallback is "error" even without strict', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      missingTargetFallback: 'error',
    });

    await expect(runner.evaluateDataset(makeDataset(1))).rejects.toThrow(
      'missingTargetFallback is "error"',
    );
  });

  it('does not throw when missingTargetFallback is "error" but target exists', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      missingTargetFallback: 'error',
      target: async () => ({ output: 'out' }),
    });

    const report = await runner.evaluateDataset(makeDataset(1));
    expect(report.entries).toHaveLength(1);
  });

  it('missingTargetFallback defaults to expected-output', async () => {
    const capturedInputs: EvalInput[] = [];
    const scorer = createMockScorer('capture', async (input) => {
      capturedInputs.push({ ...input });
      return {
        scorerId: 'capture',
        scores: [{ criterion: 'test', score: 1, reasoning: 'ok' }],
        aggregateScore: 1,
        passed: true,
        durationMs: 1,
      };
    });

    const runner = new EvalRunner({
      scorers: [scorer],
      // missingTargetFallback is undefined, defaults to 'expected-output'
    });

    await runner.evaluateDataset(
      EvalDataset.from([{ id: 'e1', input: 'in', expectedOutput: 'exp' }]),
    );

    // Falls back to expectedOutput as output
    expect(capturedInputs[0]!.output).toBe('exp');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('EvalRunner — error handling', () => {
  it('propagates target executor errors', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      target: async () => {
        throw new Error('target failure');
      },
    });

    await expect(runner.evaluateDataset(makeDataset(1))).rejects.toThrow('target failure');
  });

  it('propagates scorer errors', async () => {
    const errorScorer = createMockScorer('bad', async () => {
      throw new Error('scorer failure');
    });

    const runner = new EvalRunner({
      scorers: [errorScorer],
      target: async () => ({ output: 'out' }),
    });

    await expect(runner.evaluateDataset(makeDataset(1))).rejects.toThrow('scorer failure');
  });

  it('handles empty scorers array — entries have score 0 and do not pass', async () => {
    const runner = new EvalRunner({
      scorers: [],
      target: async () => ({ output: 'out' }),
    });

    const report = await runner.evaluateDataset(makeDataset(2));

    expect(report.entries).toHaveLength(2);
    for (const entry of report.entries) {
      expect(entry.scorerResults).toHaveLength(0);
      expect(entry.aggregateScore).toBe(0);
      // passed requires all scorerResults to pass AND length > 0
      expect(entry.passed).toBe(false);
    }
    expect(report.overallPassRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency validation
// ---------------------------------------------------------------------------

describe('EvalRunner — concurrency validation', () => {
  it('accepts concurrency = 1', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({ scorers: [scorer], concurrency: 1 });

    const report = await runner.evaluateDataset(makeDataset(2));
    expect(report.entries).toHaveLength(2);
  });

  it('accepts large concurrency values', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({ scorers: [scorer], concurrency: 100 });

    const report = await runner.evaluateDataset(makeDataset(3));
    expect(report.entries).toHaveLength(3);
  });

  it('defaults to concurrency 5 when not specified', async () => {
    // We verify this indirectly: if default was invalid, it would throw
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const report = await runner.evaluateDataset(makeDataset(1));
    expect(report.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Regression check
// ---------------------------------------------------------------------------

describe('EvalRunner — regressionCheck edge cases', () => {
  it('passes in ciMode when no regression', async () => {
    const scorer = createSimpleScorer('s1', 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer], ciMode: true });

    const baseline = new Map([['s1', 0.8]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it('ignores baseline scorers not present in results', async () => {
    const scorer = createSimpleScorer('s1', 0.9, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    // Baseline includes 'unknown-scorer' which is not in the results
    const baseline = new Map([
      ['s1', 0.8],
      ['unknown-scorer', 0.95],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    // 'unknown-scorer' has no currentAvg, so condition `currentAvg !== undefined` is false
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it('handles exact baseline match as passing (not strictly less)', async () => {
    const scorer = createSimpleScorer('s1', 0.8, true);
    const runner = new EvalRunner({ scorers: [scorer] });

    const baseline = new Map([['s1', 0.8]]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(true);
  });

  it('reports multiple regressions', async () => {
    const s1 = createSimpleScorer('s1', 0.3, false);
    const s2 = createSimpleScorer('s2', 0.4, false);
    const runner = new EvalRunner({ scorers: [s1, s2] });

    const baseline = new Map([
      ['s1', 0.9],
      ['s2', 0.8],
    ]);
    const result = await runner.regressionCheck(makeDataset(2), baseline);

    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(2);
    expect(result.regressions[0]).toContain('s1');
    expect(result.regressions[1]).toContain('s2');
  });

  it('ciMode regression error message includes all regressed scorers', async () => {
    const s1 = createSimpleScorer('s1', 0.3, false);
    const s2 = createSimpleScorer('s2', 0.4, false);
    const runner = new EvalRunner({ scorers: [s1, s2], ciMode: true });

    const baseline = new Map([
      ['s1', 0.9],
      ['s2', 0.8],
    ]);

    await expect(runner.regressionCheck(makeDataset(1), baseline)).rejects.toThrow(/s1.*s2/s);
  });
});

// ---------------------------------------------------------------------------
// Report formatters — edge cases
// ---------------------------------------------------------------------------

describe('reportToMarkdown — edge cases', () => {
  it('handles empty report', () => {
    const report: EvalReport = {
      entries: [],
      byScorerAverage: new Map(),
      overallPassRate: 0,
      overallAvgScore: 0,
      totalDurationMs: 0,
    };

    const md = reportToMarkdown(report);
    expect(md).toContain('Entry');
    expect(md).toContain('Score');
    expect(md).toContain('**Overall**');
    expect(md).toContain('0%');
  });

  it('handles entries with no scorer results', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [],
          aggregateScore: 0,
          passed: false,
        },
      ],
      byScorerAverage: new Map(),
      overallPassRate: 0,
      overallAvgScore: 0,
      totalDurationMs: 10,
    };

    const md = reportToMarkdown(report);
    expect(md).toContain('e1');
    expect(md).toContain('FAIL');
  });
});

describe('reportToJSON — edge cases', () => {
  it('serializes Map to object', () => {
    const report: EvalReport = {
      entries: [],
      byScorerAverage: new Map([['s1', 0.85], ['s2', 0.72]]),
      overallPassRate: 1,
      overallAvgScore: 0.785,
      totalDurationMs: 42,
    };

    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const avgs = parsed['byScorerAverage'] as Record<string, number>;

    expect(avgs['s1']).toBeCloseTo(0.85);
    expect(avgs['s2']).toBeCloseTo(0.72);
  });

  it('preserves all entry fields in JSON', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [{ criterion: 'c', score: 0.9, reasoning: 'good' }], aggregateScore: 0.9, passed: true, durationMs: 5 },
          ],
          aggregateScore: 0.9,
          passed: true,
          targetLatencyMs: 100,
          targetCostCents: 0.5,
          traceId: 'abc-123',
        },
      ],
      byScorerAverage: new Map([['s1', 0.9]]),
      overallPassRate: 1,
      overallAvgScore: 0.9,
      totalDurationMs: 50,
    };

    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as { entries: Array<Record<string, unknown>> };

    expect(parsed.entries[0]!['targetLatencyMs']).toBe(100);
    expect(parsed.entries[0]!['targetCostCents']).toBe(0.5);
    expect(parsed.entries[0]!['traceId']).toBe('abc-123');
  });
});

describe('reportToCIAnnotations — edge cases', () => {
  it('produces no error annotations when all entries pass', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [{ scorerId: 's1', scores: [], aggregateScore: 1, passed: true, durationMs: 1 }],
          aggregateScore: 1,
          passed: true,
        },
      ],
      byScorerAverage: new Map([['s1', 1]]),
      overallPassRate: 1,
      overallAvgScore: 1,
      totalDurationMs: 10,
    };

    const annotations = reportToCIAnnotations(report);
    expect(annotations).toHaveLength(0);
  });

  it('includes multiple failed scorers in single entry annotation', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.2, passed: false, durationMs: 1 },
            { scorerId: 's2', scores: [], aggregateScore: 0.3, passed: false, durationMs: 1 },
          ],
          aggregateScore: 0.25,
          passed: false,
        },
      ],
      byScorerAverage: new Map([['s1', 0.2], ['s2', 0.3]]),
      overallPassRate: 0,
      overallAvgScore: 0.25,
      totalDurationMs: 10,
    };

    const annotations = reportToCIAnnotations(report);
    const errorLine = annotations.find((a) => a.startsWith('::error::'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('s1');
    expect(errorLine).toContain('s2');
  });

  it('handles empty report', () => {
    const report: EvalReport = {
      entries: [],
      byScorerAverage: new Map(),
      overallPassRate: 0,
      overallAvgScore: 0,
      totalDurationMs: 0,
    };

    const annotations = reportToCIAnnotations(report);
    // overallPassRate < 1.0 => warning
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain('::warning::');
  });
});

// ---------------------------------------------------------------------------
// Target result fields propagation
// ---------------------------------------------------------------------------

describe('EvalRunner — target result field propagation', () => {
  it('does not set latencyMs/costCents/traceId when target omits them', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      target: async () => ({ output: 'out' }),
    });

    const report = await runner.evaluateDataset(makeDataset(1));

    expect(report.entries[0]!.targetLatencyMs).toBeUndefined();
    expect(report.entries[0]!.targetCostCents).toBeUndefined();
    expect(report.entries[0]!.traceId).toBeUndefined();
  });

  it('propagates all target result fields when present', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      target: async () => ({
        output: 'out',
        latencyMs: 42,
        costCents: 0.01,
        traceId: 'trace-abc',
      }),
    });

    const report = await runner.evaluateDataset(makeDataset(1));

    expect(report.entries[0]!.targetLatencyMs).toBe(42);
    expect(report.entries[0]!.targetCostCents).toBe(0.01);
    expect(report.entries[0]!.traceId).toBe('trace-abc');
  });

  it('handles latencyMs of 0 (falsy but valid)', async () => {
    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      target: async () => ({
        output: 'out',
        latencyMs: 0,
        costCents: 0,
      }),
    });

    const report = await runner.evaluateDataset(makeDataset(1));

    // typeof 0 === 'number' so these should be set
    expect(report.entries[0]!.targetLatencyMs).toBe(0);
    expect(report.entries[0]!.targetCostCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort signal edge case
// ---------------------------------------------------------------------------

describe('EvalRunner — abort before start', () => {
  it('produces empty report when aborted before evaluation starts', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const scorer = createSimpleScorer('s1', 1, true);
    const runner = new EvalRunner({
      scorers: [scorer],
      signal: controller.signal,
    });

    const report = await runner.evaluateDataset(makeDataset(5));

    expect(report.entries).toHaveLength(0);
    expect(report.overallAvgScore).toBe(0);
    expect(report.overallPassRate).toBe(0);
  });
});
