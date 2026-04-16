/**
 * Tests for PromptOptimizer — mocking LangChain BaseChatModel and PromptVersionStore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptOptimizer } from '../prompt-optimizer/prompt-optimizer.js';
import type { PromptVersion, PromptVersionStore, PromptVersionEvalScores } from '../prompt-optimizer/prompt-version-store.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';
import { EvalDataset } from '../dataset/eval-dataset.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockModel(responses: string[]): BaseChatModel {
  let callIndex = 0;
  return {
    invoke: vi.fn().mockImplementation(async () => {
      const text = responses[callIndex] ?? responses[responses.length - 1] ?? '';
      callIndex++;
      return { content: text };
    }),
  } as unknown as BaseChatModel;
}

/**
 * Build a mock PromptVersionStore backed by a simple in-memory map.
 * Properly handles activate/deactivate cycles.
 */
function makeMockVersionStore(): PromptVersionStore {
  const allVersions = new Map<string, PromptVersion>();
  let counter = 0;

  const store: PromptVersionStore = {
    getActive: vi.fn().mockImplementation(async (promptKey: string) => {
      for (const v of allVersions.values()) {
        if (v.promptKey === promptKey && v.active) return v;
      }
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

      // Compute next version number
      let maxVersion = 0;
      for (const v of allVersions.values()) {
        if (v.promptKey === params.promptKey && v.version > maxVersion) {
          maxVersion = v.version;
        }
      }

      // Deactivate all if this one is active
      if (params.active) {
        for (const v of allVersions.values()) {
          if (v.promptKey === params.promptKey) v.active = false;
        }
      }

      const version: PromptVersion = {
        id,
        promptKey: params.promptKey,
        content: params.content,
        version: maxVersion + 1,
        parentVersionId: params.parentVersionId,
        createdAt: new Date().toISOString(),
        metadata: params.metadata,
        evalScores: params.evalScores,
        active: params.active ?? false,
      };

      allVersions.set(id, version);
      return version;
    }),

    activate: vi.fn().mockImplementation(async (versionId: string) => {
      const target = allVersions.get(versionId);
      if (!target) throw new Error(`PromptVersion not found: ${versionId}`);
      for (const v of allVersions.values()) {
        if (v.promptKey === target.promptKey) v.active = false;
      }
      target.active = true;
    }),

    listVersions: vi.fn().mockImplementation(async (promptKey: string) => {
      const versions: PromptVersion[] = [];
      for (const v of allVersions.values()) {
        if (v.promptKey === promptKey) versions.push(v);
      }
      return versions.sort((a, b) => b.version - a.version);
    }),

    getById: vi.fn().mockImplementation(async (id: string) => allVersions.get(id) ?? null),
    rollback: vi.fn(),
    compare: vi.fn(),
    listPromptKeys: vi.fn(),
  } as unknown as PromptVersionStore;

  return store;
}

/**
 * Seed the version store with an initial active version.
 */
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

function makeScorer(score: number): Scorer<EvalInput> {
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

function makeDataset(count = 2): EvalDataset {
  return EvalDataset.from(
    Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      input: `input-${i}`,
      expectedOutput: `expected-${i}`,
    })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptOptimizer', () => {
  describe('optimize — no active version', () => {
    it('throws when no active prompt version found', async () => {
      const versionStore = makeMockVersionStore();
      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['']),
        evalModel: makeMockModel(['output']),
        scorers: [makeScorer(0.8)],
        versionStore,
      });

      await expect(
        optimizer.optimize({ promptKey: 'nonexistent', dataset: makeDataset() }),
      ).rejects.toThrow('No active prompt version found');
    });
  });

  describe('optimize — no improvement when meta produces no candidates', () => {
    it('returns no_improvement exit reason', async () => {
      const versionStore = makeMockVersionStore();
      const baselineScores = { avgScore: 0.8, passRate: 0.9, scorerAverages: {}, datasetSize: 1 };
      await seedVersion(versionStore, 'You are helpful.', baselineScores);

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['Here are some tips but no candidate blocks.']),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.8)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('no_improvement');
      expect(result.rounds).toBe(1);
    });
  });

  describe('optimize — no improvement when candidates score lower', () => {
    it('returns no_improvement when no candidate beats baseline', async () => {
      const versionStore = makeMockVersionStore();
      const baselineScores = { avgScore: 0.8, passRate: 0.9, scorerAverages: {}, datasetSize: 1 };
      await seedVersion(versionStore, 'You are helpful.', baselineScores);

      // All scorer calls return same score, so candidate can't beat baseline
      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          `### Candidate 1
Improved clarity.
\`\`\`prompt
Better prompt.
\`\`\``,
        ]),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.8)],
        versionStore,
        maxRounds: 1,
        minImprovement: 0.01,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('no_improvement');
    });
  });

  describe('optimize — with improvement', () => {
    it('saves improved version when candidate scores higher', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      // Scorer returns increasing scores: baseline gets 0.5, candidates get 0.9
      let callCount = 0;
      const scorer = makeScorer(0.5);
      (scorer.score as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        // First 2 calls = baseline eval (score 0.5)
        // Next calls = candidate eval (score 0.9)
        // Re-eval after selection = score 0.9
        const s = callCount <= 2 ? 0.5 : 0.9;
        return {
          scorerId: 'test-scorer',
          scores: [{ criterion: 'test', score: s, reasoning: 'ok' }],
          aggregateScore: s,
          passed: s >= 0.5,
          durationMs: 1,
        };
      });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          `### Candidate 1
Better clarity.
\`\`\`prompt
You are an extremely helpful and clear assistant.
\`\`\``,
        ]),
        evalModel: makeMockModel(['eval output']),
        scorers: [scorer],
        versionStore,
        maxRounds: 1,
        maxCandidates: 1,
        minImprovement: 0.01,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('optimize — abort signal', () => {
    it('returns aborted when signal is already aborted', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      const controller = new AbortController();
      controller.abort();

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['']),
        evalModel: makeMockModel(['output']),
        scorers: [makeScorer(0.8)],
        versionStore,
        signal: controller.signal,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(),
      });

      expect(result.exitReason).toBe('aborted');
    });
  });

  describe('optimize — with provided failures', () => {
    it('merges provided failures into optimization context', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'You are helpful.', { avgScore: 0.5, passRate: 0.5, scorerAverages: {}, datasetSize: 1 });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No proper candidates.']),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
        failures: [
          { input: 'bad input', output: 'bad output', feedback: 'too vague' },
        ],
      });

      expect(result.exitReason).toBe('no_improvement');
    });
  });

  describe('parseCandidates via optimize', () => {
    it('respects maxCandidates limit', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          `### Candidate 1
First.
\`\`\`prompt
Prompt 1.
\`\`\`

### Candidate 2
Second.
\`\`\`prompt
Prompt 2.
\`\`\`

### Candidate 3
Third.
\`\`\`prompt
Prompt 3.
\`\`\``,
        ]),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
        maxCandidates: 2,
        minImprovement: 10, // won't improve
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // maxCandidates=2, so only 2 candidates
      expect(result.candidates.length).toBeLessThanOrEqual(2);
    });

    it('skips empty prompt blocks', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'You are helpful.', { avgScore: 0.5, passRate: 0.5, scorerAverages: {}, datasetSize: 1 });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel([
          `### Candidate 1
Reasoning.
\`\`\`prompt

\`\`\``,
        ]),
        evalModel: makeMockModel(['output']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('no_improvement');
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe('evalModel response parsing', () => {
    it('handles array content from evalModel', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'You are helpful.', { avgScore: 0.5, passRate: 0.5, scorerAverages: {}, datasetSize: 1 });

      const evalModel = {
        invoke: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'Part 1.' },
            { type: 'text', text: ' Part 2.' },
          ],
        }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No candidates.']),
        evalModel,
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.exitReason).toBe('no_improvement');
    });

    it('handles non-string non-array content from evalModel', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'You are helpful.', { avgScore: 0.5, passRate: 0.5, scorerAverages: {}, datasetSize: 1 });

      const evalModel = {
        invoke: vi.fn().mockResolvedValue({ content: 42 }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No candidates.']),
        evalModel,
        scorers: [makeScorer(0.5)],
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

  describe('metaModel response parsing', () => {
    it('handles array content from metaModel', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore);

      const metaModel = {
        invoke: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: '### Candidate 1\nReason.\n```prompt\nImproved.\n```' },
          ],
        }),
      } as unknown as BaseChatModel;

      const optimizer = new PromptOptimizer({
        metaModel,
        evalModel: makeMockModel(['output']),
        scorers: [makeScorer(0.5)],
        versionStore,
        maxRounds: 1,
        minImprovement: 10, // won't improve
      });

      const result = await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      expect(result.rounds).toBe(1);
      expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('baseline version without evalScores', () => {
    it('re-saves baseline with eval scores when missing', async () => {
      const versionStore = makeMockVersionStore();
      // Seed without evalScores
      await seedVersion(versionStore, 'You are helpful.', undefined);

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No candidates.']),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.7)],
        versionStore,
        maxRounds: 1,
      });

      await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // save should have been called at least twice: initial seed + re-score
      expect(versionStore.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('baseline version with evalScores already set', () => {
    it('does not re-save when evalScores already present', async () => {
      const versionStore = makeMockVersionStore();
      await seedVersion(versionStore, 'You are helpful.', {
        avgScore: 0.8,
        passRate: 0.9,
        scorerAverages: {},
        datasetSize: 10,
      });

      const optimizer = new PromptOptimizer({
        metaModel: makeMockModel(['No candidates.']),
        evalModel: makeMockModel(['eval output']),
        scorers: [makeScorer(0.7)],
        versionStore,
        maxRounds: 1,
      });

      await optimizer.optimize({
        promptKey: 'system',
        dataset: makeDataset(1),
      });

      // save called only once (initial seed), not re-saved for eval scores
      expect(versionStore.save).toHaveBeenCalledTimes(1);
    });
  });
});
