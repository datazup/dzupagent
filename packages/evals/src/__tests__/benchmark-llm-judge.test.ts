import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBenchmark, createBenchmarkWithJudge } from '../benchmarks/benchmark-runner.js';
import type { BenchmarkSuite } from '../benchmarks/benchmark-types.js';
import type { BenchmarkConfig } from '../benchmarks/benchmark-runner.js';
import { CODE_CRITERIA } from '../scorers/criteria.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuite(overrides?: Partial<BenchmarkSuite>): BenchmarkSuite {
  return {
    id: 'test-suite',
    name: 'Test Suite',
    description: 'Test',
    category: 'qa',
    dataset: [
      { id: 'e1', input: 'What is 2+2?', expectedOutput: 'The answer is 4' },
    ],
    scorers: [
      { id: 'judge', name: 'llm-judge', type: 'llm-judge' },
    ],
    baselineThresholds: {},
    ...overrides,
  };
}

/**
 * Create a mock LLM function that returns a structured JSON response
 * matching what the enhanced judge parser expects.
 */
function mockLlm(scores: Array<{ criterion: string; score: number; reasoning: string }>) {
  return vi.fn(async (_prompt: string): Promise<string> => {
    return JSON.stringify(scores);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Benchmark LLM Judge Integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // -----------------------------------------------------------------------
  // 1. No LLM provided — fallback to heuristic
  // -----------------------------------------------------------------------
  describe('no LLM provided', () => {
    it('should fall back to heuristic (non-empty = 1.0) and log a warning', async () => {
      const suite = makeSuite();
      const target = async (_input: string) => 'some non-empty output';

      const result = await runBenchmark(suite, target);

      expect(result.scores['judge']).toBe(1.0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('llm-judge scorer used without providing an llm function'),
      );
    });

    it('should return 0.0 for empty output with heuristic fallback', async () => {
      const suite = makeSuite();
      const target = async (_input: string) => '';

      const result = await runBenchmark(suite, target);

      expect(result.scores['judge']).toBe(0.0);
    });

    it('should return 0.0 for whitespace-only output with heuristic fallback', async () => {
      const suite = makeSuite();
      const target = async (_input: string) => '   \n\t  ';

      const result = await runBenchmark(suite, target);

      expect(result.scores['judge']).toBe(0.0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. LLM provided — real judge scoring
  // -----------------------------------------------------------------------
  describe('LLM provided', () => {
    it('should use the enhanced LLM judge and return actual scores', async () => {
      const suite = makeSuite();
      const llm = mockLlm([
        { criterion: 'relevance', score: 0.9, reasoning: 'Very relevant' },
        { criterion: 'accuracy', score: 0.8, reasoning: 'Mostly accurate' },
        { criterion: 'completeness', score: 0.7, reasoning: 'Fairly complete' },
      ]);

      const config: BenchmarkConfig = { llm };
      const target = async (_input: string) => 'The answer is 4';
      const result = await runBenchmark(suite, target, config);

      // STANDARD_CRITERIA weights: relevance=0.3, accuracy=0.4, completeness=0.3
      // weighted = (0.9*0.3 + 0.8*0.4 + 0.7*0.3) / (0.3+0.4+0.3) = (0.27+0.32+0.21)/1.0 = 0.80
      expect(result.scores['judge']).toBeCloseTo(0.8, 1);
      expect(llm).toHaveBeenCalledOnce();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should pass the input and output to the LLM prompt', async () => {
      const suite = makeSuite();
      const llm = mockLlm([
        { criterion: 'relevance', score: 1.0, reasoning: 'ok' },
        { criterion: 'accuracy', score: 1.0, reasoning: 'ok' },
        { criterion: 'completeness', score: 1.0, reasoning: 'ok' },
      ]);

      const config: BenchmarkConfig = { llm };
      const target = async (_input: string) => 'The answer is 4';
      await runBenchmark(suite, target, config);

      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('What is 2+2?');
      expect(prompt).toContain('The answer is 4');
    });

    it('should score multiple dataset entries and average', async () => {
      const suite = makeSuite({
        dataset: [
          { id: 'e1', input: 'Q1', expectedOutput: 'A1' },
          { id: 'e2', input: 'Q2', expectedOutput: 'A2' },
        ],
      });

      let callCount = 0;
      const llm = vi.fn(async (_prompt: string): Promise<string> => {
        callCount++;
        // First call scores 0.6, second scores 1.0
        const s = callCount === 1 ? 0.6 : 1.0;
        return JSON.stringify([
          { criterion: 'relevance', score: s, reasoning: 'ok' },
          { criterion: 'accuracy', score: s, reasoning: 'ok' },
          { criterion: 'completeness', score: s, reasoning: 'ok' },
        ]);
      });

      const config: BenchmarkConfig = { llm };
      const target = async (_input: string) => 'answer';
      const result = await runBenchmark(suite, target, config);

      // Average of 0.6 and 1.0 = 0.8
      expect(result.scores['judge']).toBeCloseTo(0.8, 1);
      expect(llm).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // 3. LLM fails — returns 0.0
  // -----------------------------------------------------------------------
  describe('LLM failure', () => {
    it('should return 0.0 when the LLM throws', async () => {
      const suite = makeSuite();
      const llm = vi.fn(async (): Promise<string> => {
        throw new Error('LLM service unavailable');
      });

      const config: BenchmarkConfig = { llm };
      const target = async (_input: string) => 'some output';
      const result = await runBenchmark(suite, target, config);

      // createLLMJudge retries once (maxRetries=1), all fail => aggregateScore=0
      expect(result.scores['judge']).toBe(0.0);
    });

    it('should return 0.0 when LLM returns unparseable response', async () => {
      const suite = makeSuite();
      const llm = vi.fn(async (): Promise<string> => 'not valid json at all');

      const config: BenchmarkConfig = { llm };
      const target = async (_input: string) => 'some output';
      const result = await runBenchmark(suite, target, config);

      expect(result.scores['judge']).toBe(0.0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Custom criteria — verifies criteria are passed through
  // -----------------------------------------------------------------------
  describe('custom criteria', () => {
    it('should use custom criteria when provided in config', async () => {
      const suite = makeSuite();
      const llm = mockLlm([
        { criterion: 'correctness', score: 0.9, reasoning: 'Works' },
        { criterion: 'readability', score: 0.8, reasoning: 'Readable' },
        { criterion: 'efficiency', score: 0.7, reasoning: 'Efficient' },
        { criterion: 'best-practices', score: 0.6, reasoning: 'Decent' },
      ]);

      const config: BenchmarkConfig = {
        llm,
        judgeCriteria: CODE_CRITERIA,
      };
      const target = async (_input: string) => 'function add(a, b) { return a + b; }';
      const result = await runBenchmark(suite, target, config);

      // CODE_CRITERIA weights: correctness=0.4, readability=0.2, efficiency=0.2, best-practices=0.2
      // weighted = (0.9*0.4 + 0.8*0.2 + 0.7*0.2 + 0.6*0.2) / 1.0 = 0.36+0.16+0.14+0.12 = 0.78
      expect(result.scores['judge']).toBeCloseTo(0.78, 1);

      // Verify the prompt contains the custom criteria names
      const prompt = llm.mock.calls[0]![0] as string;
      expect(prompt).toContain('correctness');
      expect(prompt).toContain('readability');
      expect(prompt).toContain('efficiency');
      expect(prompt).toContain('best-practices');
    });
  });

  // -----------------------------------------------------------------------
  // 5. Mixed scorers — deterministic + llm-judge in same suite
  // -----------------------------------------------------------------------
  describe('mixed scorers', () => {
    it('should handle both deterministic and llm-judge scorers in the same suite', async () => {
      const suite = makeSuite({
        scorers: [
          { id: 'det', name: 'deterministic', type: 'deterministic' },
          { id: 'judge', name: 'llm-judge', type: 'llm-judge' },
        ],
        baselineThresholds: { det: 0.5, judge: 0.5 },
      });

      const llm = mockLlm([
        { criterion: 'relevance', score: 0.8, reasoning: 'ok' },
        { criterion: 'accuracy', score: 0.9, reasoning: 'ok' },
        { criterion: 'completeness', score: 0.7, reasoning: 'ok' },
      ]);

      const config: BenchmarkConfig = { llm };
      // Target output overlaps with expectedOutput "The answer is 4"
      const target = async (_input: string) => 'The answer is 4';
      const result = await runBenchmark(suite, target, config);

      // Deterministic score should be > 0 (keyword overlap with reference)
      expect(result.scores['det']).toBeGreaterThan(0);
      // LLM judge score should reflect weighted average
      expect(result.scores['judge']).toBeGreaterThan(0);
      // Both present
      expect(Object.keys(result.scores)).toEqual(expect.arrayContaining(['det', 'judge']));
    });

    it('should not warn for deterministic scorers even without llm config', async () => {
      const suite = makeSuite({
        scorers: [
          { id: 'det', name: 'deterministic', type: 'deterministic' },
        ],
      });

      const target = async (_input: string) => 'The answer is 4';
      await runBenchmark(suite, target);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // createBenchmarkWithJudge helper
  // -----------------------------------------------------------------------
  describe('createBenchmarkWithJudge', () => {
    it('should create config with llm and default STANDARD_CRITERIA', () => {
      const llm = async (_prompt: string) => 'response';
      const config = createBenchmarkWithJudge({ llm });

      expect(config.llm).toBe(llm);
      expect(config.judgeCriteria).toHaveLength(3); // STANDARD_CRITERIA
      expect(config.judgeCriteria![0]!.name).toBe('relevance');
    });

    it('should use custom criteria when provided', () => {
      const llm = async (_prompt: string) => 'response';
      const config = createBenchmarkWithJudge({ llm, criteria: CODE_CRITERIA });

      expect(config.judgeCriteria).toHaveLength(4); // CODE_CRITERIA
      expect(config.judgeCriteria![0]!.name).toBe('correctness');
    });
  });
});
