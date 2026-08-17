import { describe, it, expect, vi } from 'vitest';
import { createSafetyScorer } from '../scorers/safety-scorer/combined.js';
import { DomainScorer } from '../scorers/domain-scorer.js';
import type { EvalInput } from '../types.js';

const makeInput = (output: string): EvalInput => ({
  input: 'a question',
  output,
});

describe('a scorer that inspected nothing must not report a clean pass', () => {
  describe('createSafetyScorer with no dimensions wired', () => {
    it('reports measured: false', async () => {
      const scorer = createSafetyScorer({});
      const result = await scorer.score(makeInput('Some content.'));
      expect(result.measured).toBe(false);
    });

    it('does not pass, despite scoring 1.0', async () => {
      // The 1.0 is retained for backward compatibility, so `passed` is the
      // only thing standing between an unconfigured safety scorer and a green
      // release gate.
      const scorer = createSafetyScorer({});
      const result = await scorer.score(makeInput('Some content.'));

      expect(result.aggregateScore).toBe(1.0);
      expect(result.passed).toBe(false);
    });

    it('inspected no dimensions at all', async () => {
      const scorer = createSafetyScorer({});
      const result = await scorer.score(makeInput('Some content.'));
      expect(result.scores).toEqual([]);
    });
  });

  describe('createSafetyScorer with a dimension wired — the converse', () => {
    it('reports measured: true and can still pass', async () => {
      // Proves the guard rejects only the vacuous configuration rather than
      // breaking safety scoring outright.
      const scorer = createSafetyScorer({ harmfulContent: {} });
      const result = await scorer.score(makeInput('The sky is blue.'));

      expect(result.measured).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('still fails genuinely unsafe content', async () => {
      const scorer = createSafetyScorer({
        policyCompliance: {
          rules: [
            {
              id: 'no-secrets',
              category: 'data_privacy' as const,
              description: 'must not leak credentials',
              violationPatterns: [/api[_-]?key/i],
            },
          ],
        },
      });
      const result = await scorer.score(makeInput('here is my api_key=sk-123'));

      expect(result.measured).toBe(true);
      expect(result.passed).toBe(false);
    });
  });

  describe('DomainScorer when the judge cannot be reached', () => {
    /** A model whose every invocation fails, exhausting all retries. */
    const failingModel = () => ({
      invoke: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });

    it('marks unreachable-judge criteria as unscored', async () => {
      const scorer = new DomainScorer({
        domain: 'sql',
        model: failingModel() as never,
        maxRetries: 0,
      });
      const result = await scorer.score({
        input: 'q',
        output: 'SELECT 1',
      });

      const judgeOnly = result.criterionResults.filter(
        (c) => c.method === 'llm-judge',
      );
      const combined = result.criterionResults.filter(
        (c) => c.method === 'combined',
      );
      expect(judgeOnly.length + combined.length).toBeGreaterThan(0);

      // A judge-only criterion has no fallback, so it is wholly unmeasured.
      for (const c of judgeOnly) {
        expect(c.scored).toBe(false);
      }
      // A combined criterion still measured its deterministic half, so it
      // stays scored - but must not carry the judge placeholder in its score.
      for (const c of combined) {
        expect(c.scored).not.toBe(false);
        expect(c.reasoning).toContain('LLM unavailable');
      }
    });

    it('does not fold the 0.5 placeholder into the aggregate', async () => {
      // The placeholder is mid-range, so folding it in is indistinguishable
      // from a genuine mid-range judgement by a judge that actually ran.
      const scorer = new DomainScorer({
        domain: 'sql',
        model: failingModel() as never,
        maxRetries: 0,
      });
      const result = await scorer.score({
        input: 'q',
        output: 'SELECT 1',
      });

      const scoredCriteria = result.criterionResults.filter(
        (c) => c.scored !== false,
      );
      if (scoredCriteria.length === 0) {
        // Nothing at all could be judged: the scorer must say so rather than
        // report a score.
        expect(result.measured).toBe(false);
        expect(result.passed).toBe(false);
      } else {
        // Deterministic criteria still count; the placeholder must not.
        expect(result.measured).toBe(true);
      }
    });

    it('a reachable judge still produces a scored, measured result', async () => {
      // The converse: proves `scored: false` tracks judge reachability rather
      // than being set unconditionally.
      const workingModel = {
        invoke: vi.fn().mockResolvedValue({
          content: JSON.stringify({ score: 9, reasoning: 'looks correct' }),
        }),
      };
      const scorer = new DomainScorer({
        domain: 'sql',
        model: workingModel as never,
        maxRetries: 0,
      });
      const result = await scorer.score({
        input: 'q',
        output: 'SELECT 1',
      });

      const judged = result.criterionResults.filter(
        (c) => c.method === 'llm-judge' || c.method === 'combined',
      );
      for (const c of judged) {
        expect(c.scored).not.toBe(false);
      }
      expect(result.measured).toBe(true);
    });
  });
});
