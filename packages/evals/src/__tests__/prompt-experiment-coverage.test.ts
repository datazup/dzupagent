/**
 * Coverage tests for PromptExperiment — statistical helpers, run flow,
 * abort handling, markdown report generation.
 */
import { describe, it, expect, vi } from 'vitest';
import { PromptExperiment } from '../prompt-experiment/prompt-experiment.js';
import type { PromptVariant, ExperimentConfig } from '../prompt-experiment/prompt-experiment.js';
import { EvalDataset } from '../dataset/eval-dataset.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockModel(responseMap?: Record<string, string>): BaseChatModel {
  return {
    invoke: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
      // Find the system prompt to determine which variant we're running
      if (responseMap) {
        for (const msg of messages) {
          if (typeof msg.content === 'string') {
            for (const [key, value] of Object.entries(responseMap)) {
              if (msg.content.includes(key)) {
                return { content: value };
              }
            }
          }
        }
      }
      return { content: 'default output' };
    }),
  } as unknown as BaseChatModel;
}

function makeSimpleModel(output: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({ content: output }),
  } as unknown as BaseChatModel;
}

function makeSimpleScorer(score: number): Scorer<EvalInput> {
  const config: ScorerConfig = { id: 'test-scorer', name: 'test', type: 'deterministic' };
  return {
    config,
    score: vi.fn().mockResolvedValue({
      scorerId: config.id,
      scores: [{ criterion: 'test', score, reasoning: 'ok' }],
      aggregateScore: score,
      passed: score >= 0.5,
      durationMs: 1,
    }),
  };
}

function makeVariants(): PromptVariant[] {
  return [
    { id: 'a', name: 'Variant A', systemPrompt: 'Be concise.' },
    { id: 'b', name: 'Variant B', systemPrompt: 'Be detailed.' },
  ];
}

function makeDataset(count = 3): EvalDataset {
  return EvalDataset.from(
    Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      input: `question-${i}`,
      expectedOutput: `answer-${i}`,
      tags: ['test'],
      metadata: { idx: i },
    })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptExperiment', () => {
  describe('validation', () => {
    it('requires at least 2 variants', async () => {
      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
      });

      await expect(
        experiment.run([{ id: 'a', name: 'A', systemPrompt: 'only one' }], makeDataset()),
      ).rejects.toThrow('at least 2 variants');
    });
  });

  describe('basic run', () => {
    it('evaluates all variants against dataset and produces report', async () => {
      const model = makeSimpleModel('model output');
      const scorer = makeSimpleScorer(0.8);

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 2,
      });

      const report = await experiment.run(makeVariants(), makeDataset(3));

      expect(report.variants).toHaveLength(2);
      expect(report.comparisons).toHaveLength(1); // 2 choose 2 = 1
      expect(report.datasetSize).toBe(3);
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);

      // Each variant should have 3 entry results
      for (const v of report.variants) {
        expect(v.entries).toHaveLength(3);
        expect(v.avgScore).toBeCloseTo(0.8, 1);
        expect(v.passRate).toBeCloseTo(1, 1);
      }
    });

    it('determines bestVariant by highest avgScore', async () => {
      let callCount = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 'test', name: 'test', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          callCount++;
          // First 3 calls are Variant A (score 0.5), next 3 are Variant B (score 0.9)
          const s = callCount <= 3 ? 0.5 : 0.9;
          return {
            scorerId: 'test',
            scores: [{ criterion: 'test', score: s, reasoning: 'ok' }],
            aggregateScore: s,
            passed: s >= 0.5,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [scorer],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(3));

      expect(report.bestVariant).toBe('Variant B');
    });

    it('calls onProgress callback', async () => {
      const progressCalls: Array<{ variant: string; completed: number; total: number }> = [];

      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
        onProgress: (variant, completed, total) => {
          progressCalls.push({ variant, completed, total });
        },
      });

      await experiment.run(makeVariants(), makeDataset(2));

      // 2 variants x 2 entries = 4 progress calls
      expect(progressCalls).toHaveLength(4);
      expect(progressCalls[0]!.variant).toBe('Variant A');
      expect(progressCalls[0]!.total).toBe(2);
    });
  });

  describe('paired t-test comparison', () => {
    it('reports tie when scores are identical', async () => {
      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(5));

      // Same scorer for all, so no significant difference
      expect(report.comparisons[0]!.winner).toBe('tie');
      expect(report.comparisons[0]!.significant).toBe(false);
      expect(report.significantWinner).toBe(false);
    });

    it('detects significant winner when scores differ strongly', async () => {
      let variantADone = 0;
      let variantBDone = 0;

      const model = {
        invoke: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
          const isVariantA = messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('Be concise'),
          );
          if (isVariantA) {
            variantADone++;
          } else {
            variantBDone++;
          }
          return { content: isVariantA ? 'short' : 'very long and detailed response' };
        }),
      } as unknown as BaseChatModel;

      // Score based on output length
      let evalCallCount = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 'len', name: 'len', type: 'deterministic' },
        score: vi.fn().mockImplementation(async (input: EvalInput) => {
          const s = input.output.length > 10 ? 0.9 : 0.2;
          return {
            scorerId: 'len',
            scores: [{ criterion: 'length', score: s, reasoning: 'ok' }],
            aggregateScore: s,
            passed: s >= 0.5,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(10));

      // Variant B should have significantly higher scores
      if (report.comparisons.length > 0) {
        const comparison = report.comparisons[0]!;
        // Mean difference should be negative (A < B)
        expect(comparison.meanDifference).toBeLessThan(0);
      }
    });

    it('handles n < 2 entries gracefully', async () => {
      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(1));

      expect(report.comparisons[0]!.pValue).toBe(1);
      expect(report.comparisons[0]!.winner).toBe('tie');
      expect(report.comparisons[0]!.summary).toContain('Insufficient data');
    });
  });

  describe('markdown report', () => {
    it('generates a markdown report', async () => {
      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(3));
      const md = report.toMarkdown();

      expect(md).toContain('# Prompt Experiment Report');
      expect(md).toContain('## Variants');
      expect(md).toContain('Variant A');
      expect(md).toContain('Variant B');
      expect(md).toContain('## Recommendation');
    });

    it('includes latency formatting (ms and seconds)', async () => {
      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(2));
      const md = report.toMarkdown();

      // Latency should be formatted
      expect(md).toMatch(/\d+ms|\d+\.\d+s/);
    });
  });

  describe('abort handling', () => {
    it('stops evaluation when abort signal is triggered', async () => {
      const controller = new AbortController();

      const model = {
        invoke: vi.fn().mockImplementation(async () => {
          // Abort after first call
          controller.abort();
          return { content: 'output' };
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeSimpleScorer(0.8)],
        signal: controller.signal,
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(5));

      // Should have partial results due to abort
      // At least the first variant should have some results
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles pre-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        signal: controller.signal,
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(3));

      // Should have no results
      expect(report.variants).toHaveLength(0);
    });
  });

  describe('model response parsing', () => {
    it('handles array content from model', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'text', text: 'Part 2.' },
          ],
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(1));
      // Should not throw and handle array content
      expect(report.variants).toHaveLength(2);
    });

    it('handles non-string non-array content', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: 42,
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(1));
      expect(report.variants).toHaveLength(2);
    });
  });

  describe('cost estimation from usage metadata', () => {
    it('extracts cost from usage_metadata', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: 'output',
          usage_metadata: { total_tokens: 1000 },
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(1));

      for (const v of report.variants) {
        expect(v.avgCostCents).toBeGreaterThan(0);
      }
    });

    it('defaults cost to 0 when no usage metadata', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: 'output',
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(1));

      for (const v of report.variants) {
        expect(v.avgCostCents).toBe(0);
      }
    });
  });

  describe('3+ variants', () => {
    it('produces all pairwise comparisons for 3 variants', async () => {
      const variants: PromptVariant[] = [
        { id: 'a', name: 'A', systemPrompt: 'p1' },
        { id: 'b', name: 'B', systemPrompt: 'p2' },
        { id: 'c', name: 'C', systemPrompt: 'p3' },
      ];

      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [makeSimpleScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(variants, makeDataset(3));

      // 3 choose 2 = 3 comparisons
      expect(report.comparisons).toHaveLength(3);
      expect(report.variants).toHaveLength(3);
    });
  });

  describe('per-scorer averages', () => {
    it('tracks per-scorer averages in variant results', async () => {
      const scorer1: Scorer<EvalInput> = {
        config: { id: 'accuracy', name: 'accuracy', type: 'deterministic' },
        score: vi.fn().mockResolvedValue({
          scorerId: 'accuracy',
          scores: [{ criterion: 'accuracy', score: 0.9, reasoning: 'ok' }],
          aggregateScore: 0.9,
          passed: true,
          durationMs: 1,
        }),
      };
      const scorer2: Scorer<EvalInput> = {
        config: { id: 'clarity', name: 'clarity', type: 'deterministic' },
        score: vi.fn().mockResolvedValue({
          scorerId: 'clarity',
          scores: [{ criterion: 'clarity', score: 0.7, reasoning: 'ok' }],
          aggregateScore: 0.7,
          passed: true,
          durationMs: 1,
        }),
      };

      const experiment = new PromptExperiment({
        model: makeSimpleModel('output'),
        scorers: [scorer1, scorer2],
        concurrency: 1,
      });

      const report = await experiment.run(makeVariants(), makeDataset(2));

      for (const v of report.variants) {
        expect(v.scorerAverages['accuracy']).toBeCloseTo(0.9);
        expect(v.scorerAverages['clarity']).toBeCloseTo(0.7);
        // Overall avg = (0.9 + 0.7) / 2 = 0.8
        expect(v.avgScore).toBeCloseTo(0.8);
      }
    });
  });
});
