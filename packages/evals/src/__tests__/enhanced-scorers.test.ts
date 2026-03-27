import { describe, it, expect, vi } from 'vitest';
import type { EvalInput } from '../types.js';
import { createLLMJudge } from '../scorers/llm-judge-enhanced.js';
import {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from '../scorers/deterministic-enhanced.js';
import { STANDARD_CRITERIA, CODE_CRITERIA } from '../scorers/criteria.js';

// --- EvalInput type tests ---

describe('EvalInput type', () => {
  it('includes tags, latencyMs, and costCents fields', () => {
    const input: EvalInput = {
      input: 'test',
      output: 'result',
      tags: ['unit', 'fast'],
      latencyMs: 150,
      costCents: 0.5,
      metadata: { model: 'gpt-4' },
    };

    expect(input.tags).toEqual(['unit', 'fast']);
    expect(input.latencyMs).toBe(150);
    expect(input.costCents).toBe(0.5);
  });
});

// --- createLLMJudge tests ---

describe('createLLMJudge', () => {
  it('scores with a single criterion (mock LLM)', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'Good response' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'test-judge',
      criteria: 'Is the response helpful?',
      llm,
    });

    const result = await judge.score({
      input: 'What is 2+2?',
      output: '4',
    });

    expect(result.scorerId).toBe('test-judge');
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]!.criterion).toBe('overall');
    expect(result.scores[0]!.score).toBe(0.8);
    expect(result.aggregateScore).toBe(0.8);
    expect(result.passed).toBe(true);
    expect(llm).toHaveBeenCalledOnce();
  });

  it('scores with multi-criteria and weights', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'accuracy', score: 1.0, reasoning: 'Correct' },
        { criterion: 'clarity', score: 0.5, reasoning: 'Could be clearer' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'multi-judge',
      criteria: [
        { name: 'accuracy', description: 'Is it accurate?', weight: 0.7 },
        { name: 'clarity', description: 'Is it clear?', weight: 0.3 },
      ],
      llm,
    });

    const result = await judge.score({
      input: 'question',
      output: 'answer',
    });

    expect(result.scores).toHaveLength(2);
    // Weighted: (1.0 * 0.7 + 0.5 * 0.3) / (0.7 + 0.3) = 0.85
    expect(result.aggregateScore).toBeCloseTo(0.85);
    expect(result.passed).toBe(true);
  });

  it('retries on parse failure', async () => {
    const llm = vi
      .fn()
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce('still not json')
      .mockResolvedValue(
        JSON.stringify([
          { criterion: 'overall', score: 0.7, reasoning: 'OK' },
        ]),
      );

    const judge = createLLMJudge({
      id: 'retry-judge',
      criteria: 'Quality check',
      llm,
      maxRetries: 2,
    });

    const result = await judge.score({
      input: 'test',
      output: 'output',
    });

    // First call fails, second fails, third succeeds (attempt 0, retry 1, retry 2)
    expect(llm).toHaveBeenCalledTimes(3);
    expect(result.aggregateScore).toBe(0.7);
    expect(result.passed).toBe(true);
  });

  it('returns zero score on total failure', async () => {
    const llm = vi.fn().mockResolvedValue('garbage');

    const judge = createLLMJudge({
      id: 'fail-judge',
      criteria: 'Quality check',
      llm,
      maxRetries: 1,
    });

    const result = await judge.score({
      input: 'test',
      output: 'output',
    });

    // 1 initial + 1 retry = 2 calls
    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.score).toBe(0);
  });
});

// --- createJSONSchemaScorer tests ---

describe('createJSONSchemaScorer', () => {
  it('scores 1.0 for valid JSON matching schema', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-1',
      schema: {
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      },
    });

    const result = await scorer.score({
      input: 'test',
      output: JSON.stringify({ name: 'Alice', age: 30 }),
    });

    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('scores 0.0 for invalid JSON', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-2',
      schema: { required: ['name'] },
    });

    const result = await scorer.score({
      input: 'test',
      output: 'not json at all',
    });

    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain('not valid JSON');
  });

  it('scores 0.0 when required field is missing', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-3',
      schema: { required: ['name', 'age'] },
    });

    const result = await scorer.score({
      input: 'test',
      output: JSON.stringify({ name: 'Alice' }),
    });

    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain('age');
  });
});

// --- createKeywordScorer tests ---

describe('createKeywordScorer', () => {
  it('scores 1.0 when all required keywords are present', async () => {
    const scorer = createKeywordScorer({
      id: 'kw-1',
      required: ['hello', 'world'],
    });

    const result = await scorer.score({
      input: 'test',
      output: 'hello beautiful world',
    });

    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('scores less than 1.0 when required keyword is absent', async () => {
    const scorer = createKeywordScorer({
      id: 'kw-2',
      required: ['hello', 'world'],
    });

    const result = await scorer.score({
      input: 'test',
      output: 'hello there',
    });

    expect(result.aggregateScore).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('detects forbidden keywords', async () => {
    const scorer = createKeywordScorer({
      id: 'kw-3',
      forbidden: ['password', 'secret'],
    });

    const result = await scorer.score({
      input: 'test',
      output: 'Your password is exposed',
    });

    expect(result.aggregateScore).toBe(0.5);
    expect(result.passed).toBe(false);
    const forbiddenScore = result.scores.find((s) => s.criterion === 'forbidden:password');
    expect(forbiddenScore?.score).toBe(0);
    expect(forbiddenScore?.reasoning).toContain('detected');
  });

  it('respects caseSensitive option', async () => {
    const scorer = createKeywordScorer({
      id: 'kw-4',
      required: ['Hello'],
      caseSensitive: true,
    });

    const resultLower = await scorer.score({
      input: 'test',
      output: 'hello world',
    });
    expect(resultLower.aggregateScore).toBe(0);

    const resultMatch = await scorer.score({
      input: 'test',
      output: 'Hello world',
    });
    expect(resultMatch.aggregateScore).toBe(1);
  });
});

// --- createLatencyScorer tests ---

describe('createLatencyScorer', () => {
  it('scores 1.0 when latency is at target', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-1',
      targetMs: 100,
      maxMs: 500,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      latencyMs: 100,
    });

    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('scores 1.0 when latency is below target', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-1b',
      targetMs: 100,
      maxMs: 500,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      latencyMs: 50,
    });

    expect(result.aggregateScore).toBe(1.0);
  });

  it('scores 0.0 when latency is at max', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-2',
      targetMs: 100,
      maxMs: 500,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      latencyMs: 500,
    });

    expect(result.aggregateScore).toBe(0.0);
  });

  it('scores linearly between target and max', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-3',
      targetMs: 100,
      maxMs: 500,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      latencyMs: 300,
    });

    // score = 1 - (300 - 100) / (500 - 100) = 1 - 200/400 = 0.5
    expect(result.aggregateScore).toBeCloseTo(0.5);
  });
});

// --- createCostScorer tests ---

describe('createCostScorer', () => {
  it('scores 1.0 when cost is at target', async () => {
    const scorer = createCostScorer({
      id: 'cost-1',
      targetCents: 1,
      maxCents: 5,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      costCents: 1,
    });

    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('scores 1.0 when cost is below target', async () => {
    const scorer = createCostScorer({
      id: 'cost-1b',
      targetCents: 1,
      maxCents: 5,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      costCents: 0.5,
    });

    expect(result.aggregateScore).toBe(1.0);
  });

  it('scores 0.0 when cost exceeds max', async () => {
    const scorer = createCostScorer({
      id: 'cost-2',
      targetCents: 1,
      maxCents: 5,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      costCents: 6,
    });

    expect(result.aggregateScore).toBe(0.0);
  });

  it('scores linearly between target and max', async () => {
    const scorer = createCostScorer({
      id: 'cost-3',
      targetCents: 1,
      maxCents: 5,
    });

    const result = await scorer.score({
      input: 'test',
      output: 'result',
      costCents: 3,
    });

    // score = 1 - (3 - 1) / (5 - 1) = 1 - 2/4 = 0.5
    expect(result.aggregateScore).toBeCloseTo(0.5);
  });
});

// --- Criteria constants tests ---

describe('Criteria constants', () => {
  it('STANDARD_CRITERIA has 3 criteria', () => {
    expect(STANDARD_CRITERIA).toHaveLength(3);
    const names = STANDARD_CRITERIA.map((c) => c.name);
    expect(names).toContain('relevance');
    expect(names).toContain('accuracy');
    expect(names).toContain('completeness');
  });

  it('CODE_CRITERIA has 4 criteria', () => {
    expect(CODE_CRITERIA).toHaveLength(4);
    const names = CODE_CRITERIA.map((c) => c.name);
    expect(names).toContain('correctness');
    expect(names).toContain('readability');
    expect(names).toContain('efficiency');
    expect(names).toContain('best-practices');
  });
});
