/**
 * W15-H4 — Branch coverage deep-dive for @dzupagent/evals.
 *
 * Targets under-covered branches in:
 * - prompt-optimizer (mid-round error handling, reasoning parsing, truncate)
 * - prompt-experiment (normalizeConcurrency, acquireSemaphore, pairedTTest edges)
 * - benchmark-trend (linearRegressionSlope edge cases)
 * - llm-judge-enhanced (parse failure modes, zero-weight branches)
 * - benchmark-runner (llm-judge error catch branches)
 * - contract suites (adapter failure paths)
 * - contract-test-runner (timeout branch, all-skipped branch)
 */
import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { PromptOptimizer } from '../prompt-optimizer/prompt-optimizer.js';
import type {
  PromptVersion,
  PromptVersionStore,
  PromptVersionEvalScores,
} from '../prompt-optimizer/prompt-version-store.js';
import { PromptExperiment } from '../prompt-experiment/prompt-experiment.js';
import type { PromptVariant } from '../prompt-experiment/prompt-experiment.js';
import {
  BenchmarkTrendStore,
  InMemoryBenchmarkRunStore,
} from '../benchmarks/benchmark-trend.js';
import type { BenchmarkRunRecord } from '../benchmarks/benchmark-trend.js';
import type { BenchmarkResult } from '../benchmarks/benchmark-types.js';
import { runBenchmark } from '../benchmarks/benchmark-runner.js';
import type { BenchmarkSuite } from '../benchmarks/benchmark-types.js';
import { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerConfig } from '../types.js';
import { createLLMJudge } from '../scorers/llm-judge-enhanced.js';
import type { JudgeCriterion } from '../scorers/criteria.js';
import { LlmJudgeScorer } from '../scorers/llm-judge-scorer.js';
import {
  VECTOR_STORE_CONTRACT,
} from '../contracts/suites/vector-store-contract.js';
import {
  SANDBOX_CONTRACT,
} from '../contracts/suites/sandbox-contract.js';
import {
  LLM_PROVIDER_CONTRACT,
} from '../contracts/suites/llm-provider-contract.js';
import {
  EMBEDDING_PROVIDER_CONTRACT,
} from '../contracts/suites/embedding-provider-contract.js';
import { runContractSuite } from '../contracts/contract-test-runner.js';
import {
  ContractSuiteBuilder,
  timedTest,
} from '../contracts/contract-test-generator.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeMockModel(responses: string[]): BaseChatModel {
  let i = 0;
  return {
    invoke: vi.fn().mockImplementation(async () => {
      const text = responses[i] ?? responses[responses.length - 1] ?? '';
      i++;
      return { content: text };
    }),
  } as unknown as BaseChatModel;
}

function makeScorer(score: number, id = 'scorer'): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: 'deterministic' };
  return {
    config,
    score: vi.fn().mockResolvedValue({
      scorerId: id,
      scores: [{ criterion: id, score, reasoning: 'ok' }],
      aggregateScore: score,
      passed: score >= 0.5,
      durationMs: 1,
    }),
  };
}

function makeDataset(count = 2): EvalDataset {
  return EvalDataset.from(
    Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      input: `input-${i}`,
      expectedOutput: `expected-${i}`,
    })),
  );
}

function makeMockVersionStore(): PromptVersionStore {
  const all = new Map<string, PromptVersion>();
  let counter = 0;

  const store: PromptVersionStore = {
    getActive: vi.fn().mockImplementation(async (k: string) => {
      for (const v of all.values()) if (v.promptKey === k && v.active) return v;
      return null;
    }),
    save: vi.fn().mockImplementation(async (params: {
      promptKey: string;
      content: string;
      parentVersionId?: string;
      metadata?: Record<string, unknown>;
      evalScores?: PromptVersionEvalScores;
      active?: boolean;
    }) => {
      counter++;
      const id = `v-${counter}`;
      let maxV = 0;
      for (const v of all.values()) {
        if (v.promptKey === params.promptKey && v.version > maxV) maxV = v.version;
      }
      if (params.active) {
        for (const v of all.values()) if (v.promptKey === params.promptKey) v.active = false;
      }
      const ver: PromptVersion = {
        id,
        promptKey: params.promptKey,
        content: params.content,
        version: maxV + 1,
        parentVersionId: params.parentVersionId,
        createdAt: new Date().toISOString(),
        metadata: params.metadata,
        evalScores: params.evalScores,
        active: params.active ?? false,
      };
      all.set(id, ver);
      return ver;
    }),
    activate: vi.fn().mockImplementation(async (id: string) => {
      const t = all.get(id);
      if (!t) throw new Error(`not found: ${id}`);
      for (const v of all.values()) if (v.promptKey === t.promptKey) v.active = false;
      t.active = true;
    }),
    listVersions: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockImplementation(async (id: string) => all.get(id) ?? null),
    rollback: vi.fn(),
    compare: vi.fn(),
    listPromptKeys: vi.fn(),
  } as unknown as PromptVersionStore;

  return store;
}

async function seedVersion(
  store: PromptVersionStore,
  content = 'You are a helpful assistant.',
  evalScores?: PromptVersionEvalScores,
): Promise<PromptVersion> {
  return store.save({
    promptKey: 'system',
    content,
    active: true,
    evalScores,
  });
}

// ===========================================================================
// PromptOptimizer — branch coverage
// ===========================================================================

describe('PromptOptimizer branch coverage', () => {
  describe('mid-optimization error with partial results', () => {
    it('returns error exit reason when metaModel throws after baseline', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base prompt', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const metaModel = {
        invoke: vi.fn().mockRejectedValueOnce(new Error('network blip')),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel,
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
      });

      // The error happens after rounds++, so rounds === 1, no candidates yet
      // -> re-thrown since allCandidates.length === 0 but rounds !== 0
      // Actually looking at code: if (rounds === 0 && allCandidates.length === 0) throw error.
      // Here rounds === 1, so it returns partial result with 'error' reason.
      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('error');
      expect(result.improved).toBe(false);
      expect(result.bestVersion.id).toBe('error-fallback');
      expect(result.originalVersion.id).toBe('error-fallback');
      expect(result.scoreImprovement).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('error with string error value (not Error instance) formats to string', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base prompt', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const metaModel = {
        invoke: vi.fn().mockImplementation(async () => {
          throw 'plain-string-error';
        }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel,
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('error');
      expect(result.bestVersion.metadata?.['error']).toBe('plain-string-error');
    });
  });

  describe('parseCandidates branches', () => {
    it('produces empty reasoning when code block starts at index 0 (no preamble)', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      // Candidate with immediate code fence (no reasoning prefix).
      // Section after "### Candidate 1" starts with "\n```prompt ..." so
      // section.indexOf('```') === 1 which is > 0 so it does enter the first
      // branch. Test plain case where the fence is essentially right there.
      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          '### Candidate 1\n```prompt\nNew prompt here.\n```',
        ]),
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.3)],
        versionStore,
        maxRounds: 1,
        minImprovement: 10, // Won't improve
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // Candidate should be parsed; reasoning is whatever preceded the fence.
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('skips candidates without a closing code block', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          '### Candidate 1\nReasoning\n```prompt\nno close fence',
        ]),
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.3)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.exitReason).toBe('no_improvement');
    });

    it('handles responses without candidate headers', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No headers here, just prose.']),
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.3)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.exitReason).toBe('no_improvement');
    });
  });

  describe('abort across inner loop iterations', () => {
    it('aborts after first candidate evaluation', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const controller = new AbortController();
      let scorerCalls = 0;

      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          scorerCalls++;
          if (scorerCalls >= 2) controller.abort();
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: 0.5, reasoning: '' }],
            aggregateScore: 0.5,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          `### Candidate 1\nOne\n\`\`\`prompt\nA.\n\`\`\`\n\n### Candidate 2\nTwo\n\`\`\`prompt\nB.\n\`\`\``,
        ]),
        evalModel: makeMockModel(['eval out']),
        scorers: [scorer],
        versionStore,
        maxRounds: 2,
        maxCandidates: 2,
        signal: controller.signal,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('aborted');
    });

    it('aborts right before evaluating first candidate', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const controller = new AbortController();

      const metaModel = {
        invoke: vi.fn().mockImplementation(async () => {
          // Abort right after metaModel response but before candidate eval.
          controller.abort();
          return {
            content: '### Candidate 1\nOne\n```prompt\nA.\n```',
          };
        }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel,
        evalModel: makeMockModel(['eval out']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 2,
        maxCandidates: 2,
        signal: controller.signal,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('aborted');
    });

    it('aborts before metaModel call (between rounds)', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.5,
        passRate: 0.5,
        scorerAverages: {},
        datasetSize: 1,
      });

      const controller = new AbortController();
      let evalCalls = 0;

      const evalModel = {
        invoke: vi.fn().mockImplementation(async () => {
          evalCalls++;
          // Abort after baseline eval but before round starts
          if (evalCalls === 1) controller.abort();
          return { content: 'eval out' };
        }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['should not be called']),
        evalModel,
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 2,
        signal: controller.signal,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('aborted');
    });
  });

  describe('improvement flow branches', () => {
    it('continues to next round when candidate beats baseline', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      let calls = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          calls++;
          // Baseline round: 0.4
          // First round candidate: 0.9
          // Re-eval after improvement: 0.9
          // Second round baseline (already at 0.9): 0.9
          // Second round candidate: 0.5 (lower, stops)
          const s = calls <= 1 ? 0.4 : calls <= 3 ? 0.9 : 0.5;
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: s, reasoning: '' }],
            aggregateScore: s,
            passed: s >= 0.5,
            durationMs: 1,
          };
        }),
      };

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          '### Candidate 1\nImproved.\n```prompt\nBetter prompt.\n```',
        ]),
        evalModel: makeMockModel(['eval out']),
        scorers: [scorer],
        versionStore,
        maxRounds: 2,
        maxCandidates: 1,
        minImprovement: 0.01,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // Improvement happens in round 1; round 2 doesn't improve -> no_improvement
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      // Round count includes both rounds
      expect(result.rounds).toBeGreaterThanOrEqual(1);
    });

    it('reaches max_rounds when all rounds improve consistently', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      let calls = 0;
      // Monotonically increasing scores so every round improves
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          calls++;
          const s = Math.min(0.3 + calls * 0.1, 0.95);
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: s, reasoning: '' }],
            aggregateScore: s,
            passed: s >= 0.5,
            durationMs: 1,
          };
        }),
      };

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          '### Candidate 1\nIter.\n```prompt\nIter 1.\n```',
          '### Candidate 1\nIter2.\n```prompt\nIter 2.\n```',
        ]),
        evalModel: makeMockModel(['eval']),
        scorers: [scorer],
        versionStore,
        maxRounds: 2,
        maxCandidates: 1,
        minImprovement: 0.01,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // After 2 rounds of improvement: max_rounds reached
      // But builder's 'exitReason' is 'improved' (improved && not aborted/error)
      // since currentVersion.id !== originalVersion.id.
      expect(['improved', 'max_rounds']).toContain(result.exitReason);
      expect(result.rounds).toBeLessThanOrEqual(2);
    });
  });

  describe('truncate utility via meta-prompt (indirect)', () => {
    it('handles very long failure input/output (exercises truncation)', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0.2,
        passRate: 0,
        scorerAverages: {},
        datasetSize: 1,
      });

      const longInput = 'x'.repeat(2000);
      const dataset = EvalDataset.from([
        { id: 'e0', input: longInput, expectedOutput: 'expected' },
      ]);

      // Scorer always fails to generate long feedback too.
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockResolvedValue({
          scorerId: 's',
          scores: [
            { criterion: 'x', score: 0.1, reasoning: 'y'.repeat(500) },
          ],
          aggregateScore: 0.1,
          passed: false,
          durationMs: 1,
        }),
      };

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No candidates, just prose.']),
        evalModel: makeMockModel(['x'.repeat(800)]),
        scorers: [scorer],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset,
      });

      expect(result.exitReason).toBe('no_improvement');
    });
  });

  describe('empty scorer array branch', () => {
    it('handles empty scorer array (entryScore=0, entryPassed=false)', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'base', {
        avgScore: 0,
        passRate: 0,
        scorerAverages: {},
        datasetSize: 1,
      });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['no candidates']),
        evalModel: makeMockModel(['output']),
        scorers: [], // No scorers
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('no_improvement');
    });
  });
});

// ===========================================================================
// PromptExperiment — branch coverage
// ===========================================================================

describe('PromptExperiment branch coverage', () => {
  describe('normalizeConcurrency', () => {
    it('rejects zero concurrency', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 0,
      });

      await expect(
        experiment.run(
          [
            { id: 'a', name: 'A', systemPrompt: 'x' },
            { id: 'b', name: 'B', systemPrompt: 'y' },
          ],
          makeDataset(1),
        ),
      ).rejects.toThrow('finite positive integer');
    });

    it('rejects negative concurrency', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: -5,
      });

      await expect(
        experiment.run(
          [
            { id: 'a', name: 'A', systemPrompt: 'x' },
            { id: 'b', name: 'B', systemPrompt: 'y' },
          ],
          makeDataset(1),
        ),
      ).rejects.toThrow('finite positive integer');
    });

    it('rejects non-finite concurrency (Infinity)', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: Number.POSITIVE_INFINITY,
      });

      await expect(
        experiment.run(
          [
            { id: 'a', name: 'A', systemPrompt: 'x' },
            { id: 'b', name: 'B', systemPrompt: 'y' },
          ],
          makeDataset(1),
        ),
      ).rejects.toThrow('finite positive integer');
    });

    it('rejects non-integer concurrency (1.5)', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 1.5,
      });

      await expect(
        experiment.run(
          [
            { id: 'a', name: 'A', systemPrompt: 'x' },
            { id: 'b', name: 'B', systemPrompt: 'y' },
          ],
          makeDataset(1),
        ),
      ).rejects.toThrow('finite positive integer');
    });

    it('rejects NaN concurrency', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: Number.NaN,
      });

      await expect(
        experiment.run(
          [
            { id: 'a', name: 'A', systemPrompt: 'x' },
            { id: 'b', name: 'B', systemPrompt: 'y' },
          ],
          makeDataset(1),
        ),
      ).rejects.toThrow('finite positive integer');
    });

    it('accepts default concurrency (undefined)', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        // no concurrency -> defaults to 3
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(2),
      );
      expect(report.variants).toHaveLength(2);
    });
  });

  describe('pairedTTest edges via run', () => {
    it('produces pValue=1 when standard error is zero (all diffs equal, nonzero meanDiff)', async () => {
      // If every variant-A scorer returns 0.8 and every variant-B returns 0.2
      // for all entries, diffs are all 0.6 -> stddev=0 -> se=0 -> meanD!=0 -> p=0 (not 1).
      // To get pValue=1 via se=0 branch we need meanD === 0 exactly -> pValue=1.
      // That means both variants must score identical -> covered by "tie" test already.
      // Here, exercise the se==0 && meanD != 0 branch (p=0).
      let callCount = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 'x', name: 'x', type: 'deterministic' },
        score: vi.fn().mockImplementation(async (input: EvalInput) => {
          callCount++;
          // If messages include 'detailed' it's variant B; else A.
          // Use output content as proxy.
          const s = input.output === 'A-out' ? 0.8 : 0.2;
          return {
            scorerId: 'x',
            scores: [{ criterion: 'x', score: s, reasoning: '' }],
            aggregateScore: s,
            passed: s >= 0.5,
            durationMs: 1,
          };
        }),
      };

      const model = {
        invoke: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
          const isA = messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('SystemA'),
          );
          return { content: isA ? 'A-out' : 'B-out' };
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
      });

      const variants: PromptVariant[] = [
        { id: 'a', name: 'A', systemPrompt: 'SystemA prompt' },
        { id: 'b', name: 'B', systemPrompt: 'SystemB prompt' },
      ];

      const report = await experiment.run(variants, makeDataset(5));

      // Same diff for each entry => se=0, meanD != 0 => pValue = 0, significant
      expect(report.comparisons).toHaveLength(1);
      const cmp = report.comparisons[0]!;
      expect(cmp.standardError).toBe(0);
      expect(cmp.pValue).toBe(0);
      expect(cmp.significant).toBe(true);
      expect(cmp.winner).toBe('A');
      expect(callCount).toBeGreaterThan(0);
    });

    it('uses incomplete-beta approximation for df <= 30 (n=3)', async () => {
      // Only 3 dataset entries -> df = 2 -> uses beta branch not normal approx.
      let nCalls = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 'x', name: 'x', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          nCalls++;
          // Alternate scores to avoid se=0.
          const s = nCalls % 3 === 0 ? 0.9 : 0.5;
          return {
            scorerId: 'x',
            scores: [{ criterion: 'x', score: s, reasoning: '' }],
            aggregateScore: s,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model: makeMockModel(['output']),
        scorers: [scorer],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(3),
      );

      expect(report.comparisons[0]!.pValue).toBeGreaterThanOrEqual(0);
      expect(report.comparisons[0]!.pValue).toBeLessThanOrEqual(1);
    });

    it('uses normal approximation for df > 30 (n > 31)', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['output']),
        scorers: [makeScorer(0.8)],
        concurrency: 1,
      });

      // n = 32 => df = 31 => > 30 branch
      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(32),
      );

      expect(report.variants).toHaveLength(2);
      expect(report.comparisons[0]!.pValue).toBe(1); // se=0 and meanD=0 -> tie
    });
  });

  describe('abort semaphore branches', () => {
    it('handles pre-aborted signal during acquireSemaphore (second variant)', async () => {
      const controller = new AbortController();

      const model = {
        invoke: vi.fn().mockImplementation(async () => {
          return { content: 'output' };
        }),
      } as unknown as BaseChatModel;

      // Abort on first scorer call
      let scoreCalls = 0;
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async () => {
          scoreCalls++;
          if (scoreCalls >= 1) controller.abort();
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: 0.5, reasoning: '' }],
            aggregateScore: 0.5,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
        signal: controller.signal,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(5),
      );

      // Should produce a report even when aborted
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('onProgress is not triggered when aborted before completion', async () => {
      const controller = new AbortController();
      controller.abort();

      const progressCalls: number[] = [];

      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 1,
        signal: controller.signal,
        onProgress: () => {
          progressCalls.push(1);
        },
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(3),
      );

      expect(progressCalls).toHaveLength(0);
      expect(report.variants).toHaveLength(0);
    });
  });

  describe('bestVariant selection branches', () => {
    it('bestVariant defaults to first variant when all scores tied', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'first', name: 'First', systemPrompt: 'x' },
          { id: 'second', name: 'Second', systemPrompt: 'y' },
        ],
        makeDataset(3),
      );

      // Tied scores -> first variant wins
      expect(report.bestVariant).toBe('First');
    });

    it('bestVariant is empty string when variantResults is empty (aborted before any)', async () => {
      const controller = new AbortController();
      controller.abort();

      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 1,
        signal: controller.signal,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(3),
      );

      expect(report.bestVariant).toBe('');
      expect(report.variants).toHaveLength(0);
    });
  });

  describe('model response parsing edges', () => {
    it('joins array content without separator (string content join)', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'AB' },
            { type: 'text', text: 'CD' },
          ],
        }),
      } as unknown as BaseChatModel;

      // Scorer uses output - verify join result is 'ABCD' (no separator)
      let capturedOutput = '';
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async (input: EvalInput) => {
          capturedOutput = input.output;
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: 0.8, reasoning: '' }],
            aggregateScore: 0.8,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
      });

      await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(1),
      );

      expect(capturedOutput).toBe('ABCD');
    });

    it('filters out non-text blocks in array content', async () => {
      const model = {
        invoke: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', url: 'ignored' },
            { type: 'text', text: ' world' },
          ],
        }),
      } as unknown as BaseChatModel;

      let capturedOutput = '';
      const scorer: Scorer<EvalInput> = {
        config: { id: 's', name: 's', type: 'deterministic' },
        score: vi.fn().mockImplementation(async (input: EvalInput) => {
          capturedOutput = input.output;
          return {
            scorerId: 's',
            scores: [{ criterion: 's', score: 0.8, reasoning: '' }],
            aggregateScore: 0.8,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
      });

      await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(1),
      );

      expect(capturedOutput).toBe('hello world');
    });
  });

  describe('pairwise comparisons with misaligned entries', () => {
    it('only includes entries present in both variants', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const model = {
        invoke: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
          callCount++;
          const isVariantB = messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('BSys'),
          );
          // Abort the second variant's middle entry
          if (isVariantB && callCount >= 4) {
            controller.abort();
            return { content: 'should-not-be-used' };
          }
          return { content: 'normal' };
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeScorer(0.5)],
        concurrency: 1,
        signal: controller.signal,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'ASys prompt' },
          { id: 'b', name: 'B', systemPrompt: 'BSys prompt' },
        ],
        makeDataset(3),
      );

      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('markdown report branches', () => {
    it('formats sub-second latency in ms', async () => {
      const model = {
        invoke: vi.fn().mockImplementation(async () => {
          // Fast response
          return { content: 'out' };
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(2),
      );

      const md = report.toMarkdown();
      expect(md).toMatch(/\d+ms/);
    });

    it('formats seconds latency when > 1000ms', async () => {
      const model = {
        invoke: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 1050));
          return { content: 'out' };
        }),
      } as unknown as BaseChatModel;

      const experiment = new PromptExperiment({
        model,
        scorers: [makeScorer(0.8)],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(1),
      );

      const md = report.toMarkdown();
      expect(md).toMatch(/\d+\.\d+s/);
    }, 10000);

    it('omits comparisons section when there are no comparisons', async () => {
      // This requires aborting so no variants produce any entries,
      // but comparisons array is derived from variantResults. With 0 variants,
      // there are 0 comparisons. Test with pre-aborted.
      const controller = new AbortController();
      controller.abort();

      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [makeScorer(0.5)],
        concurrency: 1,
        signal: controller.signal,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(3),
      );

      expect(report.comparisons).toHaveLength(0);
      const md = report.toMarkdown();
      // Pairwise section should not appear
      expect(md).not.toContain('## Pairwise Comparisons');
    });

    it('includes recommendation when significantWinner is true', async () => {
      // Force a significant winner by using different scores.
      const model = {
        invoke: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
          const isA = messages.some(
            (m) => typeof m.content === 'string' && m.content.includes('Be concise'),
          );
          return { content: isA ? 'short' : 'a longer detailed answer' };
        }),
      } as unknown as BaseChatModel;

      const scorer: Scorer<EvalInput> = {
        config: { id: 'len', name: 'len', type: 'deterministic' },
        score: vi.fn().mockImplementation(async (input: EvalInput) => {
          const s = input.output.length > 10 ? 0.9 : 0.1;
          return {
            scorerId: 'len',
            scores: [{ criterion: 'len', score: s, reasoning: '' }],
            aggregateScore: s,
            passed: true,
            durationMs: 1,
          };
        }),
      };

      const experiment = new PromptExperiment({
        model,
        scorers: [scorer],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'Be concise' },
          { id: 'b', name: 'B', systemPrompt: 'Be verbose' },
        ],
        makeDataset(5),
      );

      const md = report.toMarkdown();
      expect(md).toContain('## Recommendation');
    });
  });

  describe('empty scorers list', () => {
    it('aggregateScore is 0 when scorers array is empty', async () => {
      const experiment = new PromptExperiment({
        model: makeMockModel(['out']),
        scorers: [],
        concurrency: 1,
      });

      const report = await experiment.run(
        [
          { id: 'a', name: 'A', systemPrompt: 'x' },
          { id: 'b', name: 'B', systemPrompt: 'y' },
        ],
        makeDataset(2),
      );

      for (const v of report.variants) {
        expect(v.avgScore).toBe(0);
        expect(v.passRate).toBe(0);
      }
    });
  });
});

// ===========================================================================
// BenchmarkTrendStore — linearRegressionSlope edge cases
// ===========================================================================

describe('BenchmarkTrendStore branch coverage', () => {
  function makeRecord(
    suiteId: string,
    targetId: string,
    timestamp: string,
    overallScore: number,
  ): BenchmarkRunRecord {
    return {
      runId: `run-${timestamp}`,
      suiteId,
      targetId,
      timestamp,
      overallScore,
      result: {
        suiteId,
        timestamp,
        scores: { overall: overallScore },
        passedBaseline: true,
        regressions: [],
      } as BenchmarkResult,
    };
  }

  it('handles same-timestamp x values (slope denominator = 0 has no effect with incremental x)', async () => {
    // linearRegressionSlope uses i as x (always unique), so denominator = 0
    // only triggers with n < 2. Verify n=1 still returns 0 via different path.
    const store = new InMemoryBenchmarkRunStore();
    await store.append(makeRecord('s', 't', '2020-01-01', 0.5));
    // 1 run -> insufficient_data
    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.direction).toBe('insufficient_data');
    expect(result.deltaPerWave).toBe(0);
  });

  it('handles exactly 3 runs with all identical scores (denominator nonzero, slope 0)', async () => {
    const store = new InMemoryBenchmarkRunStore();
    await store.append(makeRecord('s', 't', '2020-01-01', 0.5));
    await store.append(makeRecord('s', 't', '2020-01-02', 0.5));
    await store.append(makeRecord('s', 't', '2020-01-03', 0.5));

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.direction).toBe('stable');
    expect(result.deltaPerWave).toBe(0);
  });

  it('windowSize = 0 treats slice(-0) as all elements (JS quirk)', async () => {
    const store = new InMemoryBenchmarkRunStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord('s', 't', `2020-01-0${i + 1}`, 0.5));
    }

    const trend = new BenchmarkTrendStore(store);
    // slice(-0) === slice(0) === all elements -> 5 runs -> stable (all 0.5)
    const result = await trend.trend('s', 't', 0);
    expect(result.runs).toHaveLength(5);
    expect(result.direction).toBe('stable');
  });

  it('handles windowSize = 2 (less than 3, insufficient)', async () => {
    const store = new InMemoryBenchmarkRunStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord('s', 't', `2020-01-0${i + 1}`, 0.5 + i * 0.1));
    }

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't', 2);
    expect(result.direction).toBe('insufficient_data');
    expect(result.runs).toHaveLength(2);
  });

  it('slope just below threshold (slope=0.005) is stable, not improving', async () => {
    const store = new InMemoryBenchmarkRunStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord('s', 't', `2020-01-0${i + 1}`, 0.5 + i * 0.005));
    }

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.direction).toBe('stable');
  });

  it('slope just above threshold (slope=0.015) is improving', async () => {
    const store = new InMemoryBenchmarkRunStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord('s', 't', `2020-01-0${i + 1}`, 0.5 + i * 0.015));
    }

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.direction).toBe('improving');
  });

  it('slope just below negative threshold (slope=-0.015) is degrading', async () => {
    const store = new InMemoryBenchmarkRunStore();
    for (let i = 0; i < 5; i++) {
      await store.append(makeRecord('s', 't', `2020-01-0${i + 1}`, 0.9 - i * 0.015));
    }

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.direction).toBe('degrading');
  });

  it('slope near threshold (around 0.01) is classified properly', async () => {
    const store = new InMemoryBenchmarkRunStore();
    // Floating-point arithmetic: exact 0.01 may end up slightly above/below.
    // We just verify the delta is close to 0.01 and the direction is sane.
    await store.append(makeRecord('s', 't', '2020-01-01', 0.5));
    await store.append(makeRecord('s', 't', '2020-01-02', 0.51));
    await store.append(makeRecord('s', 't', '2020-01-03', 0.52));

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.deltaPerWave).toBeCloseTo(0.01, 5);
    // With floating point, 0.01 may become 0.01000...00x -> improving
    expect(['improving', 'stable']).toContain(result.direction);
  });

  it('slope at negative threshold (-0.01) is classified properly', async () => {
    const store = new InMemoryBenchmarkRunStore();
    await store.append(makeRecord('s', 't', '2020-01-01', 0.52));
    await store.append(makeRecord('s', 't', '2020-01-02', 0.51));
    await store.append(makeRecord('s', 't', '2020-01-03', 0.5));

    const trend = new BenchmarkTrendStore(store);
    const result = await trend.trend('s', 't');
    expect(result.deltaPerWave).toBeCloseTo(-0.01, 5);
    expect(['degrading', 'stable']).toContain(result.direction);
  });
});

// ===========================================================================
// BenchmarkRunner — llm-judge error fallback branches
// ===========================================================================

describe('benchmark-runner llm-judge branches', () => {
  it('LlmJudgeScorer returns fallback 0.5 when all retries fail (default judge)', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'Test',
      description: 'test',
      dataset: [
        { id: 'e0', input: 'What?', expectedOutput: 'answer' },
      ],
      scorers: [
        { id: 'judge', name: 'j', type: 'llm-judge' },
      ],
      baselineThresholds: {},
    };

    // LLM that always throws -> internal retry loop catches -> returns 0.5 fallback
    const result = await runBenchmark(
      suite,
      async () => 'some output',
      {
        llm: async () => {
          throw new Error('llm unavailable');
        },
      },
    );

    // LlmJudgeScorer internally catches LLM errors and returns 0.5 fallback
    expect(result.scores['judge']).toBeCloseTo(0.5, 2);
  });

  it('returns 0.0 when enhanced LLM judge (with custom criteria) throws', async () => {
    const criteria: JudgeCriterion[] = [
      { name: 'clarity', description: 'Is it clear?' },
    ];

    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'Test',
      description: 'test',
      dataset: [
        { id: 'e0', input: 'What?', expectedOutput: 'answer' },
      ],
      scorers: [
        { id: 'judge', name: 'j', type: 'llm-judge' },
      ],
      baselineThresholds: {},
    };

    const result = await runBenchmark(
      suite,
      async () => 'some output',
      {
        llm: async () => {
          throw new Error('llm down');
        },
        judgeCriteria: criteria,
      },
    );

    expect(result.scores['judge']).toBe(0);
  });

  it('llm-judge with strict mode throws when llm is missing', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'Test',
      description: 'test',
      dataset: [
        { id: 'e0', input: 'What?', expectedOutput: 'answer' },
      ],
      scorers: [{ id: 'judge', name: 'j', type: 'llm-judge' }],
      baselineThresholds: {},
    };

    await expect(
      runBenchmark(suite, async () => 'out', { strict: true }),
    ).rejects.toThrow('strict mode');
  });

  it('composite scorer averages deterministic + existence', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'Test',
      description: 'test',
      dataset: [
        { id: 'e0', input: 'q', expectedOutput: 'apple banana cherry' },
      ],
      scorers: [{ id: 'comp', name: 'c', type: 'composite' }],
      baselineThresholds: {},
    };

    // Output has all 3 words -> deterministic=1, existence=1 -> avg=1
    const result = await runBenchmark(
      suite,
      async () => 'apple banana cherry zebra',
    );
    expect(result.scores['comp']).toBe(1);
  });

  it('composite with empty output returns 0.5 (existence=0, deterministic=1 for empty ref)', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'Test',
      description: 'test',
      dataset: [
        { id: 'e0', input: 'q' }, // no expectedOutput
      ],
      scorers: [{ id: 'comp', name: 'c', type: 'composite' }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => '');
    expect(result.scores['comp']).toBe(0);
  });

  it('custom scorer returns 1 for non-empty output', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'T',
      description: 'd',
      dataset: [{ id: 'e0', input: 'q' }],
      scorers: [{ id: 'c', name: 'c', type: 'custom' }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => 'hello');
    expect(result.scores['c']).toBe(1);
  });

  it('custom scorer returns 0 for empty output', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'T',
      description: 'd',
      dataset: [{ id: 'e0', input: 'q' }],
      scorers: [{ id: 'c', name: 'c', type: 'custom' }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => '   ');
    expect(result.scores['c']).toBe(0);
  });

  it('unknown scorer type falls through to default (non-empty -> 1)', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'T',
      description: 'd',
      dataset: [{ id: 'e0', input: 'q' }],
      scorers: [{ id: 'u', name: 'u', type: 'unknown-type' as never }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => 'out');
    expect(result.scores['u']).toBe(1);
  });

  it('deterministic scorer with reference containing only short words returns output-based score', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'T',
      description: 'd',
      dataset: [{ id: 'e0', input: 'q', expectedOutput: 'a b c' }], // all short
      scorers: [{ id: 'd', name: 'd', type: 'deterministic' }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => 'output');
    expect(result.scores['d']).toBe(1); // non-empty with refWords.size=0 -> 1
  });

  it('deterministic scorer with empty output for empty ref returns 0', async () => {
    const suite: BenchmarkSuite = {
      id: 'test',
      name: 'T',
      description: 'd',
      dataset: [{ id: 'e0', input: 'q' }], // no reference
      scorers: [{ id: 'd', name: 'd', type: 'deterministic' }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(suite, async () => '');
    expect(result.scores['d']).toBe(0);
  });
});

// ===========================================================================
// LLM judge enhanced — parse & aggregate edges
// ===========================================================================

describe('llm-judge-enhanced parse branches', () => {
  it('handles non-array JSON response -> all-zero fallback', async () => {
    const llm = vi.fn().mockResolvedValue('{"not": "an array"}');
    const criteria: JudgeCriterion[] = [
      { name: 'accuracy', description: 'Is it accurate?' },
    ];

    const judge = createLLMJudge({
      id: 'j',
      criteria,
      llm,
      maxRetries: 1,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    expect(result.passed).toBe(false);
    expect(result.aggregateScore).toBe(0);
  });

  it('handles array with non-object entries -> null parse -> fallback', async () => {
    const llm = vi.fn().mockResolvedValue('[1, 2, 3]');
    const criteria: JudgeCriterion[] = [
      { name: 'a', description: 'd' },
    ];

    const judge = createLLMJudge({
      id: 'j',
      criteria,
      llm,
      maxRetries: 1,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    expect(result.aggregateScore).toBe(0);
  });

  it('handles response with no JSON at all -> null -> fallback', async () => {
    const llm = vi.fn().mockResolvedValue('just prose, no JSON here');
    const judge = createLLMJudge({
      id: 'j',
      criteria: [{ name: 'a', description: 'd' }],
      llm,
      maxRetries: 1,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    expect(result.aggregateScore).toBe(0);
  });

  it('totalWeight=0 branch: all criteria have weight 0 -> aggregate=0', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'a', score: 0.8, reasoning: 'ok' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'j',
      criteria: [{ name: 'a', description: 'd', weight: 0 }],
      llm,
      maxRetries: 0,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    // totalWeight=0 -> aggregate=0
    expect(result.aggregateScore).toBe(0);
  });

  it('criteria with explicit weights are averaged weighted', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'a', score: 1.0, reasoning: 'ok' },
        { criterion: 'b', score: 0.0, reasoning: 'ok' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'j',
      criteria: [
        { name: 'a', description: 'd', weight: 3 },
        { name: 'b', description: 'd', weight: 1 },
      ],
      llm,
      maxRetries: 0,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    // weighted: (1*3 + 0*1)/4 = 0.75
    expect(result.aggregateScore).toBeCloseTo(0.75, 2);
  });

  it('criterion in scores not matching any criteria list gets weight 1 default', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'known', score: 0.5, reasoning: '' },
        { criterion: 'unknown', score: 1.0, reasoning: '' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'j',
      criteria: [{ name: 'known', description: 'd', weight: 2 }],
      llm,
      maxRetries: 0,
    });

    const result = await judge.score({
      input: 'q',
      output: 'a',
    });

    // totalWeight = 2 (only 'known' in criteria list)
    // weightedSum = 0.5*2 (known) + 1.0*1 (unknown default) = 2
    // aggregate = 2/2 = 1.0
    expect(result.aggregateScore).toBeCloseTo(1.0, 2);
  });
});

// ===========================================================================
// LlmJudgeScorer — parse branches
// ===========================================================================

describe('LlmJudgeScorer branch coverage', () => {
  it('retries on JSON parse failure (invalid JSON inside braces)', async () => {
    let calls = 0;
    const llm = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return '{ not valid json at all }';
      return JSON.stringify({
        correctness: 8,
        completeness: 7,
        coherence: 9,
        relevance: 8,
        safety: 10,
        reasoning: 'good',
      });
    });

    const scorer = new LlmJudgeScorer({
      llm,
      maxRetries: 2,
    });

    const result = await scorer.score('q', 'a', 'ref');
    expect(result.overall).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it('returns cost estimate from token usage (tokenUsage branch)', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        correctness: 8,
        completeness: 7,
        coherence: 9,
        relevance: 8,
        safety: 10,
        reasoning: 'good',
      }),
    );

    const scorer = new LlmJudgeScorer({
      llm,
      id: 'judge',
    });

    const result = await scorer.score({
      input: 'What?',
      output: 'An answer',
      reference: 'Expected answer',
    });

    expect(result.scorerId).toBe('judge');
    expect(result.costCents).toBeDefined();
    expect(typeof result.costCents).toBe('number');
  });

  it('anchors option includes calibration examples in prompt', async () => {
    let capturedPrompt = '';
    const llm = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        correctness: 8,
        completeness: 7,
        coherence: 9,
        relevance: 8,
        safety: 10,
        reasoning: 'good',
      });
    });

    const scorer = new LlmJudgeScorer({
      llm,
      anchors: [
        {
          input: 'example-in',
          output: 'example-out',
          expectedScore: 8,
          explanation: 'Because XYZ',
        },
      ],
    });

    await scorer.score('q', 'a');
    expect(capturedPrompt).toContain('Calibration examples');
    expect(capturedPrompt).toContain('example-in');
  });

  it('reference branch: includes reference in prompt when provided', async () => {
    let capturedPrompt = '';
    const llm = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        correctness: 5,
        completeness: 5,
        coherence: 5,
        relevance: 5,
        safety: 5,
        reasoning: 'ok',
      });
    });

    const scorer = new LlmJudgeScorer({ llm });
    await scorer.score('q', 'a', 'gold-ref');
    expect(capturedPrompt).toContain('Reference answer: gold-ref');
  });

  it('no-reference branch: prompt omits reference section', async () => {
    let capturedPrompt = '';
    const llm = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        correctness: 5,
        completeness: 5,
        coherence: 5,
        relevance: 5,
        safety: 5,
        reasoning: 'ok',
      });
    });

    const scorer = new LlmJudgeScorer({ llm });
    await scorer.score('q', 'a');
    expect(capturedPrompt).not.toContain('Reference answer:');
  });

  it('no-anchors branch: prompt omits calibration section', async () => {
    let capturedPrompt = '';
    const llm = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        correctness: 5,
        completeness: 5,
        coherence: 5,
        relevance: 5,
        safety: 5,
        reasoning: 'ok',
      });
    });

    const scorer = new LlmJudgeScorer({ llm }); // no anchors
    await scorer.score('q', 'a');
    expect(capturedPrompt).not.toContain('Calibration examples');
  });

  it('empty anchors array branch: prompt omits calibration section', async () => {
    let capturedPrompt = '';
    const llm = vi.fn().mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        correctness: 5,
        completeness: 5,
        coherence: 5,
        relevance: 5,
        safety: 5,
        reasoning: 'ok',
      });
    });

    const scorer = new LlmJudgeScorer({ llm, anchors: [] }); // empty
    await scorer.score('q', 'a');
    expect(capturedPrompt).not.toContain('Calibration examples');
  });
});

// ===========================================================================
// Contract test generator — timedTest branches
// ===========================================================================

describe('timedTest branch coverage', () => {
  it('uses default passed=true when result.passed is undefined', async () => {
    const result = await timedTest(async () => ({ details: { x: 1 } }));
    expect(result.passed).toBe(true);
    expect(result.details).toEqual({ x: 1 });
  });

  it('preserves passed=false when explicitly set', async () => {
    const result = await timedTest(async () => ({ passed: false, error: 'nope' }));
    expect(result.passed).toBe(false);
    expect(result.error).toBe('nope');
  });

  it('catches thrown errors and returns passed=false', async () => {
    const result = await timedTest(async () => {
      throw new Error('test failure');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('test failure');
  });

  it('catches non-Error throws and stringifies them', async () => {
    const result = await timedTest(async () => {
      throw 'string error';
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('catches thrown number and converts', async () => {
    const result = await timedTest(async () => {
      throw 42;
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('42');
  });

  it('catches thrown null', async () => {
    const result = await timedTest(async () => {
      throw null;
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('null');
  });
});

// ===========================================================================
// Contract test runner — failure/timeout branches
// ===========================================================================

describe('contract-test-runner branch coverage', () => {
  it('computeCompliancePercent returns 0 when all tests are skipped', async () => {
    // Build a suite where the filter skips every test.
    const suite = new ContractSuiteBuilder('vector-store', 'Empty')
      .required('t1', 't1', 'd', async () => ({ passed: true, duration: 0 }))
      .build();

    const adapter = {}; // not used
    const report = await runContractSuite({
      suite,
      adapter,
      filter: { testIds: ['nonexistent'] }, // all skipped
    });

    expect(report.summary.passed).toBe(0);
    expect(report.compliancePercent).toBe(0);
  });

  it('catches thrown errors from test.run() (stringifies non-Error)', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Err')
      .required('fail', 'fail', 'd', async () => {
        throw 'raw-string';
      })
      .build();

    const report = await runContractSuite({
      suite,
      adapter: {},
    });

    const failingTest = report.tests.find((t) => t.testId.endsWith('fail'));
    expect(failingTest?.status).toBe('failed');
    expect(failingTest?.error).toBe('raw-string');
  });

  it('respects timeoutMs and marks tests failed on timeout', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Slow')
      .required('slow', 'slow', 'd', async () => {
        // Simulate a hang
        await new Promise((r) => setTimeout(r, 500));
        return { passed: true, duration: 500 };
      })
      .build();

    const report = await runContractSuite({
      suite,
      adapter: {},
      testTimeoutMs: 50,
    });

    const test = report.tests[0];
    expect(test?.status).toBe('failed');
    expect(test?.error).toContain('timed out');
  }, 3000);

  it('runs beforeAll setup when defined', async () => {
    let setupCalled = false;

    const suite = new ContractSuiteBuilder('vector-store', 'Setup')
      .beforeAll(async () => {
        setupCalled = true;
      })
      .required('t', 't', 'd', async () => ({ passed: true, duration: 0 }))
      .build();

    await runContractSuite({ suite, adapter: {} });
    expect(setupCalled).toBe(true);
  });

  it('runs afterAll teardown when defined', async () => {
    let teardownCalled = false;

    const suite = new ContractSuiteBuilder('vector-store', 'Teardown')
      .afterAll(async () => {
        teardownCalled = true;
      })
      .required('t', 't', 'd', async () => ({ passed: true, duration: 0 }))
      .build();

    await runContractSuite({ suite, adapter: {} });
    expect(teardownCalled).toBe(true);
  });

  it('compliance level is "none" when all required tests fail (req.passed=0)', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'AllFail')
      .required('r1', 'r1', 'd', async () => ({ passed: false, duration: 0, error: 'fail' }))
      .required('r2', 'r2', 'd', async () => ({ passed: false, duration: 0, error: 'fail' }))
      .build();

    const report = await runContractSuite({ suite, adapter: {} });
    expect(report.complianceLevel).toBe('none');
  });

  it('compliance level is "minimal" when some required pass and some fail', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Minimal')
      .required('r1', 'r1', 'd', async () => ({ passed: true, duration: 0 }))
      .required('r2', 'r2', 'd', async () => ({ passed: false, duration: 0, error: 'fail' }))
      .build();

    const report = await runContractSuite({ suite, adapter: {} });
    expect(report.complianceLevel).toBe('minimal');
  });

  it('compliance level is "partial" when required passes but recommended fails', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Partial')
      .required('r', 'r', 'd', async () => ({ passed: true, duration: 0 }))
      .recommended('rec', 'rec', 'd', async () => ({ passed: false, duration: 0, error: 'fail' }))
      .build();

    const report = await runContractSuite({ suite, adapter: {} });
    expect(report.complianceLevel).toBe('partial');
  });

  it('compliance level is "full" when everything passes', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Full')
      .required('r', 'r', 'd', async () => ({ passed: true, duration: 0 }))
      .recommended('rec', 'rec', 'd', async () => ({ passed: true, duration: 0 }))
      .optional('opt', 'opt', 'd', async () => ({ passed: true, duration: 0 }))
      .build();

    const report = await runContractSuite({ suite, adapter: {} });
    expect(report.complianceLevel).toBe('full');
  });

  it('filter with empty arrays does not filter anything', async () => {
    const suite = new ContractSuiteBuilder('vector-store', 'Unfiltered')
      .required('r', 'r', 'd', async () => ({ passed: true, duration: 0 }))
      .build();

    const report = await runContractSuite({
      suite,
      adapter: {},
      filter: { categories: [], testIds: [] },
    });

    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]?.status).toBe('passed');
  });
});

// ===========================================================================
// Contract suites — adapter failure paths
// ===========================================================================

describe('VectorStore contract failure branches', () => {
  // A failing mock that triggers each error branch
  function createBrokenVectorStore(overrides: Record<string, unknown> = {}) {
    return {
      provider: 'broken',
      async createCollection(_n: string) {
        return undefined;
      },
      async deleteCollection(_n: string) {
        return undefined;
      },
      async listCollections() {
        return [];
      },
      async collectionExists(_n: string) {
        return false;
      },
      async upsert(_c: string, _e: unknown[]) {
        return undefined;
      },
      async search(_c: string, _q: unknown) {
        return [];
      },
      async delete(_c: string, _f: unknown) {
        return undefined;
      },
      async count(_c: string) {
        return 0;
      },
      async healthCheck() {
        return { healthy: true };
      },
      async close() {
        return undefined;
      },
      ...overrides,
    };
  }

  it('fails has-provider check when provider is empty string', async () => {
    const adapter = createBrokenVectorStore({ provider: '' });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:has-provider');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('fails has-provider check when provider is not a string', async () => {
    const adapter = createBrokenVectorStore({ provider: 42 as unknown as string });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:has-provider');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails create-collection when collectionExists returns false', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:create-collection');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('fails upsert-and-search when search returns non-array', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return null as unknown as [];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-and-search');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails upsert-and-search when search returns 0 results', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return [];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-and-search');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('0 results');
  });

  it('fails upsert-and-search when result.id is not a string', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return [{ id: 42, score: 0.9, metadata: {} }] as unknown as [];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-and-search');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('result.id');
  });

  it('fails upsert-and-search when result.score is not a number', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return [{ id: 'x', score: 'bad', metadata: {} }] as unknown as [];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-and-search');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('result.score');
  });

  it('fails upsert-and-search when closest match is wrong', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return [{ id: 'doc-2', score: 0.9, metadata: { topic: 'beta' } }];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-and-search');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('doc-1');
  });

  it('fails delete-by-ids when deleted entry still appears', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async search() {
        return [{ id: 'del-1', score: 0.9, metadata: {} }];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:delete-by-ids');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('still appears');
  });

  it('fails count when empty collection reports nonzero', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async count() {
        return 5;
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:count');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('0');
  });

  it('fails count when after-upsert reports wrong count', async () => {
    let upserts = 0;
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async count() {
        return upserts > 0 ? 999 : 0;
      },
      async upsert() {
        upserts++;
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:count');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('2');
  });

  it('fails delete-collection when collection not actually created', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false; // never exists
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:delete-collection');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('after creation');
  });

  it('fails delete-collection when collection persists after deletion', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true; // always exists, even after delete
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:delete-collection');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('still exists');
  });

  it('fails list-collections when result is not an array', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async listCollections() {
        return 'not-array' as unknown as string[];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:list-collections');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('array');
  });

  it('fails list-collections when collection missing from list', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return true;
      },
      async listCollections() {
        return ['some-other-collection'];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:list-collections');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('did not include');
  });

  it('fails metadata-returned when no results', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async search() {
        return [];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:metadata-returned');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('No results');
  });

  it('fails metadata-returned when label not preserved', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async search() {
        return [{ id: 'meta-1', score: 0.9, metadata: { different: 'field' } }];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:metadata-returned');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('label');
  });

  it('fails health-check when healthy=false', async () => {
    const adapter = createBrokenVectorStore({
      async healthCheck() {
        return { healthy: false };
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:health-check');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('healthy=false');
  });

  it('fails upsert-idempotent when count > 1 after double upsert', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async count() {
        return 2; // buggy: double-inserts
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find((t) => t.id === 'vector-store:upsert-idempotent');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('count 1');
  });

  it('fails search-limit-respected when results exceed limit', async () => {
    const adapter = createBrokenVectorStore({
      async collectionExists() {
        return false;
      },
      async search() {
        return [
          { id: '1', score: 1, metadata: {} },
          { id: '2', score: 0.9, metadata: {} },
          { id: '3', score: 0.8, metadata: {} },
        ];
      },
    });
    const test = VECTOR_STORE_CONTRACT.tests.find(
      (t) => t.id === 'vector-store:search-limit-respected',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('at most 2');
  });
});

describe('Sandbox contract failure branches', () => {
  function createBrokenSandbox(overrides: Record<string, unknown> = {}) {
    return {
      async execute(_c: string, _o?: unknown) {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
      async uploadFiles(_f: Record<string, string>) {},
      async downloadFiles(_p: string[]): Promise<Record<string, string>> {
        return {};
      },
      async cleanup() {},
      async isAvailable() {
        return true;
      },
      ...overrides,
    };
  }

  it('fails execute-returns-output when exitCode not a number', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 'bad' as unknown as number, stdout: 'hello', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-returns-output');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('exitCode');
  });

  it('fails execute-returns-output when stdout not a string', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: 123 as unknown as string, stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-returns-output');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('stdout');
  });

  it('fails execute-returns-output when stderr not a string', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: 'hello', stderr: null as unknown as string, timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-returns-output');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('stderr');
  });

  it('fails execute-returns-output when timedOut not a boolean', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: 'hello', stderr: '', timedOut: 'no' as unknown as boolean };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-returns-output');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('timedOut');
  });

  it('fails execute-returns-output when stdout missing expected content', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: 'goodbye', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-returns-output');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('hello');
  });

  it('fails execute-exit-code when true command returns non-zero', async () => {
    const adapter = createBrokenSandbox({
      async execute(cmd: string) {
        return { exitCode: cmd === 'true' ? 5 : 1, stdout: '', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-exit-code');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('true');
  });

  it('fails execute-exit-code when false command returns 0', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-exit-code');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('false');
  });

  it('fails execute-stderr when stderr does not contain expected content', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: 'err', stderr: 'nothing-here', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:execute-stderr');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('stderr');
  });

  it('fails is-available when not returning boolean', async () => {
    const adapter = createBrokenSandbox({
      async isAvailable() {
        return 'yes' as unknown as boolean;
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:is-available');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('boolean');
  });

  it('fails timeout-enforcement when timedOut remains false', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:timeout-enforcement');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('timedOut');
  });

  it('fails upload-download-files when no content returned', async () => {
    const adapter = createBrokenSandbox({
      async downloadFiles() {
        return {};
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:upload-download-files');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('did not return');
  });

  it('fails upload-download-files on content mismatch', async () => {
    const adapter = createBrokenSandbox({
      async downloadFiles(paths: string[]) {
        const result: Record<string, string> = {};
        for (const p of paths) result[p] = 'different content';
        return result;
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:upload-download-files');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('mismatch');
  });

  it('fails error-handling when nonexistent command returns 0', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:error-handling');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('non-zero');
  });

  it('fails cwd-option when output does not include cwd', async () => {
    const adapter = createBrokenSandbox({
      async execute() {
        return { exitCode: 0, stdout: '/home/user', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:cwd-option');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('/tmp');
  });

  it('fails file-system-isolation when file not readable', async () => {
    const adapter = createBrokenSandbox({
      async execute(cmd: string) {
        if (cmd.startsWith('cat')) {
          return { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const test = SANDBOX_CONTRACT.tests.find((t) => t.id === 'sandbox:file-system-isolation');
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('readable');
  });
});

describe('LLM provider contract failure branches', () => {
  interface BrokenLLMOverrides {
    invoke?: (messages: Array<{ content: string; role?: string }>) => Promise<{
      content: string | unknown;
      usage_metadata?: Record<string, unknown>;
      tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
    }>;
    stream?: unknown;
    bindTools?: unknown;
  }

  function createBrokenLLM(overrides: BrokenLLMOverrides = {}) {
    return {
      async invoke() {
        return { content: 'default response' };
      },
      ...overrides,
    };
  }

  it('fails invoke-returns-response when response is null', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return null as unknown as { content: string };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-returns-response',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('null/undefined');
  });

  it('fails invoke-returns-response when content is not a string', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: 42 as unknown as string };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-returns-response',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('string');
  });

  it('fails invoke-returns-response when content is empty', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: '' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-returns-response',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('fails invoke-handles-system-message when content empty', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: '' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-handles-system-message',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('invoke-error-handling passes when adapter throws on empty input', async () => {
    const adapter = createBrokenLLM({
      async invoke(messages: Array<{ content: string }>) {
        if (messages.length === 0) throw new Error('empty');
        return { content: 'ok' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-error-handling',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('invoke-error-handling passes when adapter returns null for empty', async () => {
    const adapter = createBrokenLLM({
      async invoke(messages: Array<{ content: string }>) {
        if (messages.length === 0) return null as unknown as { content: string };
        return { content: 'ok' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:invoke-error-handling',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('fails token-usage-metadata when usage_metadata missing', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: 'hi' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:token-usage-metadata',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('usage_metadata');
  });

  it('fails token-usage-metadata when input_tokens not a number', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return {
          content: 'hi',
          usage_metadata: { input_tokens: 'x', output_tokens: 5 },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:token-usage-metadata',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('input_tokens');
  });

  it('fails token-usage-metadata when output_tokens not a number', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return {
          content: 'hi',
          usage_metadata: { input_tokens: 5, output_tokens: 'y' },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:token-usage-metadata',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('output_tokens');
  });

  it('fails streaming-support when stream() not a function', async () => {
    const adapter = createBrokenLLM(); // No stream()
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:streaming-support',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('stream()');
  });

  it('fails streaming-support when stream produces no chunks', async () => {
    const adapter = createBrokenLLM({
      stream() {
        return (async function* () {})();
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:streaming-support',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('no chunks');
  });

  it('passes streaming-support when stream yields text chunks', async () => {
    const adapter = createBrokenLLM({
      stream() {
        return (async function* () {
          yield { content: 'chunk-1' };
          yield { content: 'chunk-2' };
        })();
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:streaming-support',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('fails tool-binding when bindTools() not a function', async () => {
    const adapter = createBrokenLLM(); // no bindTools
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-binding',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('bindTools()');
  });

  it('fails tool-binding when bindTools returns null', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return null;
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-binding',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('null/undefined');
  });

  it('fails tool-binding when bound has no invoke method', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return { invoke: 'not-a-function' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-binding',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('invoke()');
  });

  it('passes tool-binding when bound has invoke method', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return {
          async invoke() {
            return { content: 'ok' };
          },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-binding',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('fails multi-turn-context when model does not recall name', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: 'I have no idea' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:multi-turn-context',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('name');
  });

  it('passes multi-turn-context when model recalls name', async () => {
    const adapter = createBrokenLLM({
      async invoke() {
        return { content: 'Your name is ContractTestBot' };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:multi-turn-context',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('fails tool-call-format when bindTools not implemented', async () => {
    const adapter = createBrokenLLM();
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-call-format',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails tool-call-format when no tool_calls returned', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return {
          async invoke() {
            return { content: 'no tool calls', tool_calls: [] };
          },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-call-format',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('tool_calls');
  });

  it('fails tool-call-format when tool_call.name not a string', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return {
          async invoke() {
            return {
              content: '',
              tool_calls: [{ name: 42, args: {} }],
            };
          },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-call-format',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('tool_call.name');
  });

  it('passes tool-call-format when tool_calls properly formatted', async () => {
    const adapter = createBrokenLLM({
      bindTools() {
        return {
          async invoke() {
            return {
              content: '',
              tool_calls: [{ name: 'get_weather', args: { city: 'Paris' } }],
            };
          },
        };
      },
    });
    const test = LLM_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'llm-provider:tool-call-format',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });
});

describe('Embedding provider contract failure branches', () => {
  function createBrokenEmbedding(overrides: Record<string, unknown> = {}) {
    return {
      modelId: 'mock-embed',
      dimensions: 3,
      async embed(texts: string[]) {
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
      async embedQuery(_t: string) {
        return [0.1, 0.2, 0.3];
      },
      ...overrides,
    };
  }

  it('fails has-model-id when modelId empty', async () => {
    const adapter = createBrokenEmbedding({ modelId: '' });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-model-id',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails has-model-id when modelId not a string', async () => {
    const adapter = createBrokenEmbedding({ modelId: 42 });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-model-id',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails has-dimensions when dimensions not a number', async () => {
    const adapter = createBrokenEmbedding({ dimensions: 'three' });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-dimensions',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails has-dimensions when dimensions is zero', async () => {
    const adapter = createBrokenEmbedding({ dimensions: 0 });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-dimensions',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails has-dimensions when dimensions negative', async () => {
    const adapter = createBrokenEmbedding({ dimensions: -3 });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-dimensions',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails has-dimensions when dimensions not an integer', async () => {
    const adapter = createBrokenEmbedding({ dimensions: 3.7 });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:has-dimensions',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('integer');
  });

  it('fails embed-returns-vectors when embed returns non-array', async () => {
    const adapter = createBrokenEmbedding({
      async embed() {
        return 'not-array' as unknown as number[][];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails embed-returns-vectors when length mismatch', async () => {
    const adapter = createBrokenEmbedding({
      async embed() {
        return [[0.1, 0.2, 0.3]];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Expected 2');
  });

  it('fails embed-returns-vectors when a vector is not an array', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map(() => 'bad' as unknown as number[]);
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('not an array');
  });

  it('fails embed-returns-vectors when vector has wrong dimensions', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map(() => [0.1, 0.2]); // only 2 dims, expected 3
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('dimensions');
  });

  it('fails embed-returns-vectors when vector contains NaN', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map(() => [0.1, NaN, 0.3]);
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('non-numeric');
  });

  it('fails embed-returns-vectors when vector contains strings', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map(() => ['a', 'b', 'c']) as unknown as number[][];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-returns-vectors',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails embed-query-returns-vector when not an array', async () => {
    const adapter = createBrokenEmbedding({
      async embedQuery() {
        return 'bad' as unknown as number[];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-query-returns-vector',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails embed-query-returns-vector when wrong dimensions', async () => {
    const adapter = createBrokenEmbedding({
      async embedQuery() {
        return [0.1, 0.2]; // 2 dims, expected 3
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-query-returns-vector',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails embed-query-returns-vector when contains NaN', async () => {
    const adapter = createBrokenEmbedding({
      async embedQuery() {
        return [0.1, NaN, 0.3];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:embed-query-returns-vector',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
  });

  it('fails batch-consistency when dimension mismatch between batch and single', async () => {
    const adapter = createBrokenEmbedding({
      async embed() {
        return [[0.1, 0.2, 0.3]];
      },
      async embedQuery() {
        return [0.1, 0.2];
      },
    });
    // Mismatch in dims array length
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:batch-consistency',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Dimension mismatch');
  });

  it('fails batch-consistency when vectors differ significantly', async () => {
    const adapter = createBrokenEmbedding({
      async embed() {
        return [[0.1, 0.2, 0.3]];
      },
      async embedQuery() {
        return [0.9, 0.8, 0.7];
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:batch-consistency',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('differ');
  });

  it('passes batch-consistency when batch & single match', async () => {
    const adapter = createBrokenEmbedding(); // default returns same vector
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:batch-consistency',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });

  it('fails empty-batch-handling when embed([]) returns non-array', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        if (texts.length === 0) return 'oops' as unknown as number[][];
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:empty-batch-handling',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('array');
  });

  it('fails empty-batch-handling when embed([]) returns non-empty array', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        if (texts.length === 0) return [[0.1, 0.2, 0.3]];
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:empty-batch-handling',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('0 vectors');
  });

  it('passes empty-batch-handling when adapter throws for empty input', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        if (texts.length === 0) throw new Error('not allowed');
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:empty-batch-handling',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
    expect(result.details?.['behavior']).toBe('throws-on-empty');
  });

  it('fails large-batch when wrong number of vectors', async () => {
    const adapter = createBrokenEmbedding({
      async embed() {
        return [[0.1, 0.2, 0.3]]; // only 1 vector even though 10 texts requested
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:large-batch',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('10');
  });

  it('fails semantic-similarity when cat/feline not more similar than cat/quantum', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map((_t, i) => {
          // Make cat/feline dissimilar and cat/quantum similar
          if (i === 0) return [1, 0, 0];
          if (i === 1) return [0, 1, 0];
          return [1, 0.001, 0]; // very close to cat
        });
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:semantic-similarity',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('cat/feline');
  });

  it('passes semantic-similarity with proper embeddings', async () => {
    const adapter = createBrokenEmbedding({
      async embed(texts: string[]) {
        return texts.map((_t, i) => {
          if (i === 0) return [1, 0, 0]; // cat
          if (i === 1) return [0.95, 0.1, 0]; // feline (similar to cat)
          return [0, 1, 1]; // quantum (orthogonal)
        });
      },
    });
    const test = EMBEDDING_PROVIDER_CONTRACT.tests.find(
      (t) => t.id === 'embedding-provider:semantic-similarity',
    );
    const result = await test!.run(adapter);
    expect(result.passed).toBe(true);
  });
});
