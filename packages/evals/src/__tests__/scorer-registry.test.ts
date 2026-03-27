import { describe, it, expect, vi } from 'vitest';
import { ScorerRegistry, defaultScorerRegistry } from '../scorers/scorer-registry.js';
import type { ScorerFactoryDeps } from '../scorers/scorer-registry.js';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJudgeResponse(): string {
  return JSON.stringify({
    correctness: 9,
    completeness: 8,
    coherence: 8.5,
    relevance: 9.5,
    safety: 10,
    reasoning: 'Good quality output',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScorerRegistry', () => {
  // -----------------------------------------------------------------------
  // Built-in scorers
  // -----------------------------------------------------------------------
  describe('built-in scorers', () => {
    it('should have exact-match, contains, and llm-judge registered', () => {
      const registry = new ScorerRegistry();
      expect(registry.has('exact-match')).toBe(true);
      expect(registry.has('contains')).toBe(true);
      expect(registry.has('llm-judge')).toBe(true);
    });

    it('should list all registered scorers', () => {
      const registry = new ScorerRegistry();
      const list = registry.list();

      expect(list.length).toBeGreaterThanOrEqual(3);
      const types = list.map((e) => e.type);
      expect(types).toContain('exact-match');
      expect(types).toContain('contains');
      expect(types).toContain('llm-judge');
    });
  });

  // -----------------------------------------------------------------------
  // exact-match scorer
  // -----------------------------------------------------------------------
  describe('exact-match scorer', () => {
    it('should score 1.0 when output matches reference exactly', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('exact-match');

      const result = await scorer.score({
        input: 'question',
        output: 'answer',
        reference: 'answer',
      });

      expect(result.aggregateScore).toBe(1.0);
      expect(result.passed).toBe(true);
    });

    it('should score 0.0 when output does not match reference', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('exact-match');

      const result = await scorer.score({
        input: 'question',
        output: 'wrong answer',
        reference: 'answer',
      });

      expect(result.aggregateScore).toBe(0.0);
      expect(result.passed).toBe(false);
    });

    it('should score 0.0 when no reference provided', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('exact-match');

      const result = await scorer.score({
        input: 'question',
        output: 'answer',
      });

      expect(result.aggregateScore).toBe(0.0);
    });
  });

  // -----------------------------------------------------------------------
  // contains scorer
  // -----------------------------------------------------------------------
  describe('contains scorer', () => {
    it('should score 1.0 when output contains reference', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('contains');

      const result = await scorer.score({
        input: 'question',
        output: 'The answer is 42',
        reference: '42',
      });

      expect(result.aggregateScore).toBe(1.0);
      expect(result.passed).toBe(true);
    });

    it('should score 0.0 when output does not contain reference', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('contains');

      const result = await scorer.score({
        input: 'question',
        output: 'no match here',
        reference: '42',
      });

      expect(result.aggregateScore).toBe(0.0);
    });
  });

  // -----------------------------------------------------------------------
  // llm-judge scorer
  // -----------------------------------------------------------------------
  describe('llm-judge scorer', () => {
    it('should use the LlmJudgeScorer when llm is provided', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const registry = new ScorerRegistry();
      const scorer = registry.create('llm-judge', { llm });

      const result = await scorer.score({
        input: 'What is 2+2?',
        output: '4',
      });

      expect(result.aggregateScore).toBeCloseTo(0.9, 1);
      expect(llm).toHaveBeenCalledOnce();
    });

    it('should return 0 score when no llm provided', async () => {
      const registry = new ScorerRegistry();
      const scorer = registry.create('llm-judge');

      const result = await scorer.score({
        input: 'input',
        output: 'output',
      });

      expect(result.aggregateScore).toBe(0);
      expect(result.passed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Custom scorer registration
  // -----------------------------------------------------------------------
  describe('custom scorer registration', () => {
    it('should allow registering a custom scorer', async () => {
      const registry = new ScorerRegistry();

      registry.register('word-count', 'Scores based on word count', (_deps: ScorerFactoryDeps): Scorer<EvalInput> => {
        const config: ScorerConfig = {
          id: 'word-count',
          name: 'word-count',
          description: 'Word count scorer',
          type: 'custom',
        };

        return {
          config,
          async score(input: EvalInput): Promise<ScorerResult> {
            const words = input.output.split(/\s+/).filter((w) => w.length > 0).length;
            const score = Math.min(1, words / 10);
            return {
              scorerId: config.id,
              scores: [{ criterion: 'word-count', score, reasoning: `${words} words` }],
              aggregateScore: score,
              passed: score >= 0.5,
              durationMs: 0,
            };
          },
        };
      });

      expect(registry.has('word-count')).toBe(true);

      const scorer = registry.create('word-count');
      const result = await scorer.score({
        input: 'q',
        output: 'one two three four five',
      });

      expect(result.aggregateScore).toBe(0.5);
    });

    it('should overwrite existing scorer when re-registering', () => {
      const registry = new ScorerRegistry();
      const oldList = registry.list();
      const oldExactDesc = oldList.find((e) => e.type === 'exact-match')?.description;

      registry.register('exact-match', 'Custom exact match', (_deps) => {
        const config: ScorerConfig = { id: 'exact-match', name: 'exact-match', type: 'deterministic' };
        return {
          config,
          async score(): Promise<ScorerResult> {
            return { scorerId: 'exact-match', scores: [], aggregateScore: 0, passed: false, durationMs: 0 };
          },
        };
      });

      const newDesc = registry.list().find((e) => e.type === 'exact-match')?.description;
      expect(newDesc).toBe('Custom exact match');
      expect(newDesc).not.toBe(oldExactDesc);
    });
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------
  describe('error cases', () => {
    it('should throw on unknown scorer type', () => {
      const registry = new ScorerRegistry();

      expect(() => registry.create('nonexistent')).toThrowError(
        /Unknown scorer type "nonexistent"/,
      );
    });

    it('should list available types in error message', () => {
      const registry = new ScorerRegistry();

      expect(() => registry.create('bad-type')).toThrowError(
        /exact-match/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------
  describe('unregister', () => {
    it('should remove a registered scorer', () => {
      const registry = new ScorerRegistry();
      expect(registry.has('exact-match')).toBe(true);

      const removed = registry.unregister('exact-match');
      expect(removed).toBe(true);
      expect(registry.has('exact-match')).toBe(false);
    });

    it('should return false when unregistering non-existent type', () => {
      const registry = new ScorerRegistry();
      const removed = registry.unregister('nonexistent');
      expect(removed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Default singleton
  // -----------------------------------------------------------------------
  describe('defaultScorerRegistry', () => {
    it('should be a shared instance with built-in scorers', () => {
      expect(defaultScorerRegistry.has('exact-match')).toBe(true);
      expect(defaultScorerRegistry.has('contains')).toBe(true);
      expect(defaultScorerRegistry.has('llm-judge')).toBe(true);
    });
  });
});
