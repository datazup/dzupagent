import { describe, it, expect, vi } from 'vitest';
import { LlmJudgeScorer } from '../scorers/llm-judge-scorer.js';
import type { JudgeDimension, JudgeScorerResult } from '../scorers/llm-judge-scorer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a valid 5-dimension JSON response string. */
function makeJudgeResponse(overrides?: Partial<Record<JudgeDimension | 'reasoning', unknown>>): string {
  return JSON.stringify({
    correctness: 0.9,
    completeness: 0.8,
    coherence: 0.85,
    relevance: 0.95,
    safety: 1.0,
    reasoning: 'Good quality output',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmJudgeScorer', () => {
  // -----------------------------------------------------------------------
  // Valid JSON response
  // -----------------------------------------------------------------------
  describe('valid JSON response', () => {
    it('should return correct overall score with equal weights', async () => {
      const llm = vi.fn().mockResolvedValue(makeJudgeResponse());

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('What is 2+2?', '4');

      // Equal weights: (0.9 + 0.8 + 0.85 + 0.95 + 1.0) / 5 = 4.5 / 5 = 0.9
      expect(result.overall).toBeCloseTo(0.9, 4);
      expect(result.dimensions.correctness).toBe(0.9);
      expect(result.dimensions.completeness).toBe(0.8);
      expect(result.dimensions.coherence).toBe(0.85);
      expect(result.dimensions.relevance).toBe(0.95);
      expect(result.dimensions.safety).toBe(1.0);
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
  });

  // -----------------------------------------------------------------------
  // Dimension weights
  // -----------------------------------------------------------------------
  describe('dimension weights', () => {
    it('should apply custom weights to overall calculation', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 1.0,
          completeness: 0.0,
          coherence: 0.0,
          relevance: 0.0,
          safety: 0.0,
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
          correctness: 1.0,
          completeness: 0.5,
          coherence: 0.5,
          relevance: 0.5,
          safety: 0.5,
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
          correctness: 1.0,
          completeness: 0.0,
          coherence: 0.0,
          relevance: 0.0,
          safety: 0.0,
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
      // Only 3 of 5 dimensions present
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          correctness: 0.9,
          completeness: 0.8,
          reasoning: 'partial',
        }),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // Missing coherence, relevance, safety => parse fails => fallback
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
  // Score clamping
  // -----------------------------------------------------------------------
  describe('score clamping', () => {
    it('should clamp dimension scores above 1.0 to 1.0', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: 1.5,
          completeness: 2.0,
          coherence: 100,
          relevance: 0.8,
          safety: 0.9,
        }),
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.dimensions.correctness).toBe(1.0);
      expect(result.dimensions.completeness).toBe(1.0);
      expect(result.dimensions.coherence).toBe(1.0);
      expect(result.dimensions.relevance).toBe(0.8);
      expect(result.dimensions.safety).toBe(0.9);
    });

    it('should clamp dimension scores below 0.0 to 0.0', async () => {
      const llm = vi.fn().mockResolvedValue(
        makeJudgeResponse({
          correctness: -0.5,
          completeness: -1.0,
          coherence: 0.0,
          relevance: 0.5,
          safety: 0.5,
        }),
      );

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.dimensions.correctness).toBe(0.0);
      expect(result.dimensions.completeness).toBe(0.0);
      expect(result.dimensions.coherence).toBe(0.0);
      expect(result.dimensions.relevance).toBe(0.5);
      expect(result.dimensions.safety).toBe(0.5);
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

    it('should handle missing reasoning field as empty string', async () => {
      const response = {
        correctness: 0.9,
        completeness: 0.8,
        coherence: 0.85,
        relevance: 0.95,
        safety: 1.0,
      };
      const llm = vi.fn().mockResolvedValue(JSON.stringify(response));

      const scorer = new LlmJudgeScorer({ llm });
      const result = await scorer.score('input', 'output');

      expect(result.reasoning).toBe('');
      expect(result.overall).toBeCloseTo(0.9, 4);
    });

    it('should reject response where dimension is not a number', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify({
          correctness: 'high',
          completeness: 0.8,
          coherence: 0.85,
          relevance: 0.95,
          safety: 1.0,
          reasoning: 'ok',
        }),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // Should fail to parse => fallback
      expect(result.overall).toBe(0.5);
    });

    it('should reject array response (not an object)', async () => {
      const llm = vi.fn().mockResolvedValue(
        JSON.stringify([{ correctness: 0.9 }]),
      );

      const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });
      const result = await scorer.score('input', 'output');

      // Array doesn't match the object regex /\{[\s\S]*\}/
      // Actually it does contain the inner object. Let me check the parse logic.
      // The regex matches the inner { correctness: 0.9 }, but it won't have all dimensions
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
  // These tests verify the updated computeScore 'llm-judge' path

  it('should use LlmJudgeScorer when llm provided without judgeCriteria', async () => {
    // This is an indirect test: when no judgeCriteria, benchmark-runner
    // now routes to LlmJudgeScorer. We verify by checking the prompt
    // contains 5-dimension language.
    const { runBenchmark } = await import('../benchmarks/benchmark-runner.js');
    const { BenchmarkSuite } = await import('../benchmarks/benchmark-types.js') as Record<string, unknown>;

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
