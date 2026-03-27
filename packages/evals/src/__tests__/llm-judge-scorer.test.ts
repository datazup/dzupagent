import { describe, it, expect, vi } from 'vitest';
import { LlmJudgeScorer, judgeResponseSchema } from '../scorers/llm-judge-scorer.js';
import type { JudgeDimension, JudgeScorerResult, JudgeTokenUsage } from '../scorers/llm-judge-scorer.js';
import type { EvalInput } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a valid 5-dimension JSON response string.
 * Scores are 0-10 (the new Zod-validated scale); the scorer normalizes to 0-1.
 */
function makeJudgeResponse(overrides?: Partial<Record<JudgeDimension | 'reasoning', unknown>>): string {
  return JSON.stringify({
    correctness: 9,
    completeness: 8,
    coherence: 8.5,
    relevance: 9.5,
    safety: 10,
    reasoning: 'Good quality output',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmJudgeScorer', () => {
  // -----------------------------------------------------------------------
  // Zod schema validation
  // -----------------------------------------------------------------------
  describe('Zod schema validation', () => {
    it('should accept a valid judge response', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: 9,
        completeness: 8,
        coherence: 8.5,
        relevance: 9.5,
        safety: 10,
        reasoning: 'Good',
      });
      expect(result.success).toBe(true);
    });

    it('should reject scores above 10', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: 11,
        completeness: 8,
        coherence: 8.5,
        relevance: 9.5,
        safety: 10,
        reasoning: 'ok',
      });
      expect(result.success).toBe(false);
    });

    it('should reject scores below 0', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: -1,
        completeness: 8,
        coherence: 8.5,
        relevance: 9.5,
        safety: 10,
        reasoning: 'ok',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-number dimension values', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: 'high',
        completeness: 8,
        coherence: 8.5,
        relevance: 9.5,
        safety: 10,
        reasoning: 'ok',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing reasoning field', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: 9,
        completeness: 8,
        coherence: 8.5,
        relevance: 9.5,
        safety: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing dimension fields', () => {
      const result = judgeResponseSchema.safeParse({
        correctness: 9,
        completeness: 8,
        reasoning: 'partial',
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Valid JSON response
  // -----------------------------------------------------------------------
  describe('valid JSON response', () => {
    it('should return correct overall score with equal weights', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('What is 2+2?', '4');

      // Scores normalized from 0-10 to 0-1: 0.9, 0.8, 0.85, 0.95, 1.0
      // Equal weights: (0.9 + 0.8 + 0.85 + 0.95 + 1.0) / 5 = 4.5 / 5 = 0.9
      expect(result.overall).toBeCloseTo(0.9, 4);
      expect(result.dimensions.correctness).toBeCloseTo(0.9, 4);
      expect(result.dimensions.completeness).toBeCloseTo(0.8, 4);
      expect(result.dimensions.coherence).toBeCloseTo(0.85, 4);
      expect(result.dimensions.relevance).toBeCloseTo(0.95, 4);
      expect(result.dimensions.safety).toBeCloseTo(1.0, 4);
      expect(result.reasoning).toBe('Good quality output');
      expect(llm).toHaveBeenCalledOnce();
    });

    it('should pass input and output to the LLM prompt', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('What is the capital of France?', 'Paris');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('What is the capital of France?');
      expect(prompt).toContain('Paris');
    });

    it('should include all 5 dimension descriptions in the prompt', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('input', 'output');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('correctness');
      expect(prompt).toContain('completeness');
      expect(prompt).toContain('coherence');
      expect(prompt).toContain('relevance');
      expect(prompt).toContain('safety');
    });

    it('should include scoring rubric in the prompt', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('input', 'output');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('0-10');
      expect(prompt).toContain('Scoring rubric');
    });
  });

  // -----------------------------------------------------------------------
  // Dimension weights
  // -----------------------------------------------------------------------
  describe('dimension weights', () => {
    it('should apply custom weights to overall calculation', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 10,
          completeness: 0,
          coherence: 0,
          relevance: 0,
          safety: 0,
        }),
      );

      const scorer = new LlmJudgeScorer({
        llm,
        weights: {
          correctness: 4.0,
          completeness: 1.0,
          coherence: 1.0,
          relevance: 1.0,
          safety: 1.0,
        },
      });

      const result = await scorer.score('input', 'output');

      // weighted = (1.0*4 + 0*1 + 0*1 + 0*1 + 0*1) / (4+1+1+1+1) = 4/8 = 0.5
      expect(result.overall).toBeCloseTo(0.5, 4);
    });

    it('should use equal weights by default', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 10,
          completeness: 5,
          coherence: 5,
          relevance: 5,
          safety: 5,
        }),
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      // (1.0 + 0.5 + 0.5 + 0.5 + 0.5) / 5 = 3.0 / 5 = 0.6
      expect(result.overall).toBeCloseTo(0.6, 4);
    });

    it('should allow partial weight overrides', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 10,
          completeness: 0,
          coherence: 0,
          relevance: 0,
          safety: 0,
        }),
      );

      // Only override correctness weight; rest default to 1.0
      const scorer = new LlmJudgeScorer({
        llm,
        weights: { correctness: 6.0 },
      });

      const result = await scorer.score('input', 'output');

      // weighted = (1.0*6 + 0*1 + 0*1 + 0*1 + 0*1) / (6+1+1+1+1) = 6/10 = 0.6
      expect(result.overall).toBeCloseTo(0.6, 4);
    });
  });

  // -----------------------------------------------------------------------
  // Retry on parse failure
  // -----------------------------------------------------------------------
  describe('retry behavior', () => {
    it('should retry on invalid JSON and succeed on valid response', async () => {
      const llm = vi
        .fn()
        .mockResolvedValueOnce('not json at all')
        .mockResolvedValueOnce('still not json')
        .mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 2 });
      const result = await scorer.score('input', 'output');

      // 1 initial + 2 retries = 3 calls
      expect(llm).toHaveBeenCalledTimes(3);
      expect(result.overall).toBeCloseTo(0.9, 4);
    });

    it('should retry on LLM throw and succeed on valid response', async () => {
      const llm = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 2 });
      const result = await scorer.score('input', 'output');

      expect(llm).toHaveBeenCalledTimes(2);
      expect(result.overall).toBeCloseTo(0.9, 4);
    });

    it('should respect maxRetries=0 (no retries)', async () => {
      const llm = vi.fn().mockResolvedValue('garbage');

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      expect(llm).toHaveBeenCalledTimes(1);
      expect(result.overall).toBe(0.5); // fallback
    });
  });

  // -----------------------------------------------------------------------
  // All retries exhausted — fallback
  // -----------------------------------------------------------------------
  describe('total failure fallback', () => {
    it('should return 0.5 fallback score when all retries fail', async () => {
      const llm = vi.fn().mockResolvedValue('totally invalid');

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 2 });
      const result = await scorer.score('input', 'output');

      // 1 initial + 2 retries = 3 calls
      expect(llm).toHaveBeenCalledTimes(3);
      expect(result.overall).toBe(0.5);
      expect(result.dimensions.correctness).toBe(0.5);
      expect(result.dimensions.completeness).toBe(0.5);
      expect(result.dimensions.coherence).toBe(0.5);
      expect(result.dimensions.relevance).toBe(0.5);
      expect(result.dimensions.safety).toBe(0.5);
      expect(result.reasoning).toContain('Failed');
    });

    it('should return 0.5 fallback when LLM always throws', async () => {
      const llm = vi.fn().mockRejectedValue(new Error('service down'));

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 1 });
      const result = await scorer.score('input', 'output');

      // 1 initial + 1 retry = 2 calls
      expect(llm).toHaveBeenCalledTimes(2);
      expect(result.overall).toBe(0.5);
    });

    it('should return 0.5 fallback when response has missing dimensions', async () => {
      // Only 2 of 5 dimensions present — Zod validation will reject this
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          correctness: 9,
          completeness: 8,
          reasoning: 'partial',
        }),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // Missing coherence, relevance, safety => Zod rejects => fallback
      expect(result.overall).toBe(0.5);
    });

    it('should return 0.5 fallback when scores exceed Zod bounds (>10)', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          correctness: 15,
          completeness: 8,
          coherence: 8.5,
          relevance: 9.5,
          safety: 10,
          reasoning: 'ok',
        }),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // correctness: 15 fails Zod .max(10) => parse fails => fallback
      expect(result.overall).toBe(0.5);
    });
  });

  // -----------------------------------------------------------------------
  // Anchor examples
  // -----------------------------------------------------------------------
  describe('anchor examples', () => {
    it('should include anchor examples in the prompt', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({
        llm,
        anchors: [
          {
            input: 'What is 1+1?',
            output: '2',
            expectedScore: 0.95,
            explanation: 'Correct and concise',
          },
          {
            input: 'Explain quantum physics',
            output: 'It is complicated',
            expectedScore: 0.2,
            explanation: 'Too vague',
          },
        ],
      });

      await scorer.score('test input', 'test output');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('Calibration examples');
      expect(prompt).toContain('What is 1+1?');
      expect(prompt).toContain('0.95');
      expect(prompt).toContain('Correct and concise');
      expect(prompt).toContain('Explain quantum physics');
      expect(prompt).toContain('Too vague');
    });

    it('should not include calibration section when no anchors provided', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('input', 'output');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).not.toContain('Calibration examples');
    });
  });

  // -----------------------------------------------------------------------
  // Reference answer
  // -----------------------------------------------------------------------
  describe('reference answer', () => {
    it('should include reference answer in prompt when provided', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('What is 2+2?', '4', 'The answer is 4');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('Reference answer: The answer is 4');
    });

    it('should not include reference line when no reference provided', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('What is 2+2?', '4');

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).not.toContain('Reference answer');
    });

    it('should work correctly without reference', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.overall).toBeCloseTo(0.9, 4);
      expect(result.reasoning).toBe('Good quality output');
    });
  });

  // -----------------------------------------------------------------------
  // Score normalization (0-10 -> 0-1)
  // -----------------------------------------------------------------------
  describe('score normalization', () => {
    it('should normalize 0-10 scores to 0-1 range', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 10,
          completeness: 5,
          coherence: 0,
          relevance: 7.5,
          safety: 2.5,
        }),
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.dimensions.correctness).toBeCloseTo(1.0, 4);
      expect(result.dimensions.completeness).toBeCloseTo(0.5, 4);
      expect(result.dimensions.coherence).toBeCloseTo(0.0, 4);
      expect(result.dimensions.relevance).toBeCloseTo(0.75, 4);
      expect(result.dimensions.safety).toBeCloseTo(0.25, 4);
    });
  });

  // -----------------------------------------------------------------------
  // Token usage tracking
  // -----------------------------------------------------------------------
  describe('token usage tracking', () => {
    it('should include token usage in the result', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.promptTokens).toBeGreaterThan(0);
      expect(result.tokenUsage!.completionTokens).toBeGreaterThan(0);
      expect(result.tokenUsage!.totalTokens).toBe(
        result.tokenUsage!.promptTokens + result.tokenUsage!.completionTokens,
      );
    });

    it('should accumulate total token usage across multiple calls', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('input1', 'output1');
      await scorer.score('input2', 'output2');

      const total = scorer.totalTokenUsage;
      expect(total.totalTokens).toBeGreaterThan(0);
      // Two calls should produce more tokens than one
      expect(total.promptTokens).toBeGreaterThan(0);
    });

    it('should invoke onTokenUsage callback after each call', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const usages: JudgeTokenUsage[] = [];

      const scorer = new LlmJudgeScorer({
        llm,
        onTokenUsage: (u) => usages.push(u),
      });

      await scorer.score('input', 'output');
      await scorer.score('input2', 'output2');

      expect(usages).toHaveLength(2);
      expect(usages[0]!.totalTokens).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Scorer<EvalInput> interface
  // -----------------------------------------------------------------------
  describe('Scorer<EvalInput> interface', () => {
    it('should implement config property correctly', () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const scorer = new LlmJudgeScorer({ llm, id: 'my-judge' });

      expect(scorer.config.id).toBe('my-judge');
      expect(scorer.config.type).toBe('llm-judge');
      expect(scorer.config.name).toBe('llm-judge-5dim');
    });

    it('should return ScorerResult when called with EvalInput', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const scorer = new LlmJudgeScorer({ llm });

      const evalInput: EvalInput = {
        input: 'What is 2+2?',
        output: '4',
        reference: 'The answer is 4',
      };

      const result = await scorer.score(evalInput);

      // ScorerResult shape
      expect(result.scorerId).toBeDefined();
      expect(result.scores).toBeInstanceOf(Array);
      expect(result.aggregateScore).toBeCloseTo(0.9, 1);
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.durationMs).toBe('number');
    });

    it('should include per-dimension scores in ScorerResult', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const scorer = new LlmJudgeScorer({ llm });

      const result = await scorer.score({
        input: 'input',
        output: 'output',
      });

      const dimensionNames = result.scores
        .map((s) => s.criterion)
        .filter((c) => c !== 'overall-reasoning');

      expect(dimensionNames).toContain('correctness');
      expect(dimensionNames).toContain('completeness');
      expect(dimensionNames).toContain('coherence');
      expect(dimensionNames).toContain('relevance');
      expect(dimensionNames).toContain('safety');
    });

    it('should include cost estimate in ScorerResult', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
      const scorer = new LlmJudgeScorer({ llm });

      const result = await scorer.score({
        input: 'input',
        output: 'output',
      });

      expect(result.costCents).toBeDefined();
      expect(typeof result.costCents).toBe('number');
    });

    it('should respect passThreshold config', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 6,
          completeness: 6,
          coherence: 6,
          relevance: 6,
          safety: 6,
        }),
      );

      // Score will be 0.6, threshold is 0.7 => should fail
      const scorer = new LlmJudgeScorer({ llm, passThreshold: 0.7 });
      const result = await scorer.score({ input: 'in', output: 'out' });

      expect(result.aggregateScore).toBeCloseTo(0.6, 4);
      expect(result.passed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases for JSON parsing
  // -----------------------------------------------------------------------
  describe('JSON parsing edge cases', () => {
    it('should extract JSON from surrounding text', async () => {
      const llm = vi.fn().mockResolvedValue(
        'Here is my evaluation:\n' +
          makeJudgeResponse() +
          '\nI hope this helps!',
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.overall).toBeCloseTo(0.9, 4);
    });

    it('should handle empty reasoning string', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({ reasoning: '' }),
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.reasoning).toBe('');
      expect(result.overall).toBeCloseTo(0.9, 4);
    });

    it('should reject response where dimension is not a number', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          correctness: 'high',
          completeness: 8,
          coherence: 8.5,
          relevance: 9.5,
          safety: 10,
          reasoning: 'ok',
        }),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // Should fail Zod validation => fallback
      expect(result.overall).toBe(0.5);
    });

    it('should reject array response (not an object)', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify([{ correctness: 9 }]),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      expect(result.overall).toBe(0.5);
    });
  });

  // -----------------------------------------------------------------------
  // Default maxRetries
  // -----------------------------------------------------------------------
  describe('default configuration', () => {
    it('should default maxRetries to 2', async () => {
      const llm = vi.fn().mockResolvedValue('invalid');

      const scorer = new LlmJudgeScorer({ llm });
      await scorer.score('input', 'output');

      // 1 initial + 2 retries = 3
      expect(llm).toHaveBeenCalledTimes(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: benchmark-runner uses LlmJudgeScorer
// ---------------------------------------------------------------------------

describe('benchmark-runner LlmJudgeScorer integration', () => {
  it('should use LlmJudgeScorer when llm provided without judgeCriteria', async () => {
    const { runBenchmark } = await import('../benchmarks/benchmark-runner.js');

    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

    const suite = {
      id: 'test',
      name: 'Test',
      description: 'Test',
      category: 'qa' as const,
      dataset: [{ id: 'e1', input: 'Q', expectedOutput: 'A' }],
      scorers: [{ id: 'judge', name: 'llm-judge', type: 'llm-judge' as const }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(
      suite,
      async (_input: string) => 'answer',
      { llm },
    );

    // LlmJudgeScorer produces the 5-dimension prompt
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('correctness');
    expect(prompt).toContain('completeness');
    expect(prompt).toContain('coherence');
    expect(prompt).toContain('relevance');
    expect(prompt).toContain('safety');

    // Overall score from makeJudgeResponse = 0.9
    expect(result.scores['judge']).toBeCloseTo(0.9, 1);
  });

  it('should use heuristic fallback (0.5) when no llm and output is non-empty', async () => {
    const { runBenchmark } = await import('../benchmarks/benchmark-runner.js');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const suite = {
      id: 'test',
      name: 'Test',
      description: 'Test',
      category: 'qa' as const,
      dataset: [{ id: 'e1', input: 'Q', expectedOutput: 'A' }],
      scorers: [{ id: 'judge', name: 'llm-judge', type: 'llm-judge' as const }],
      baselineThresholds: {},
    };

    const result = await runBenchmark(
      suite,
      async (_input: string) => 'some output',
    );

    // Downgraded from 1.0 to 0.5
    expect(result.scores['judge']).toBe(0.5);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
