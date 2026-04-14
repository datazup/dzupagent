import { describe, it, expect, vi } from 'vitest';
import {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from '../scorers/deterministic-enhanced.js';
import { createLLMJudge } from '../scorers/llm-judge-enhanced.js';
import type { EvalInput } from '../types.js';
import { STANDARD_CRITERIA, CODE_CRITERIA, FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC } from '../scorers/criteria.js';

// ---------------------------------------------------------------------------
// JSON Schema Scorer
// ---------------------------------------------------------------------------

describe('createJSONSchemaScorer', () => {
  const makeInput = (output: string): EvalInput => ({
    input: 'test input',
    output,
  });

  it('scores 1.0 for valid JSON matching schema', async () => {
    const scorer = createJSONSchemaScorer({
      schema: {
        required: ['name', 'age'],
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      },
    });

    const result = await scorer.score(makeInput(JSON.stringify({ name: 'Alice', age: 30 })));
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.scores[0]!.reasoning).toContain('matches');
  });

  it('scores 0.0 for invalid JSON', async () => {
    const scorer = createJSONSchemaScorer({
      schema: { required: ['name'] },
    });

    const result = await scorer.score(makeInput('not json'));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain('not valid JSON');
  });

  it('scores 0.0 for JSON array (not object)', async () => {
    const scorer = createJSONSchemaScorer({
      schema: { required: ['name'] },
    });

    const result = await scorer.score(makeInput('[1, 2, 3]'));
    expect(result.aggregateScore).toBe(0);
    expect(result.scores[0]!.reasoning).toContain('not a JSON object');
  });

  it('scores 0.0 for null JSON value', async () => {
    const scorer = createJSONSchemaScorer({
      schema: { required: ['name'] },
    });

    const result = await scorer.score(makeInput('null'));
    expect(result.aggregateScore).toBe(0);
  });

  it('scores 0.0 when required field is missing', async () => {
    const scorer = createJSONSchemaScorer({
      schema: { required: ['name', 'email'] },
    });

    const result = await scorer.score(makeInput(JSON.stringify({ name: 'Alice' })));
    expect(result.aggregateScore).toBe(0);
    expect(result.scores[0]!.reasoning).toContain('Missing required field');
    expect(result.scores[0]!.reasoning).toContain('email');
  });

  it('scores 0.0 when property type is wrong', async () => {
    const scorer = createJSONSchemaScorer({
      schema: {
        properties: {
          age: { type: 'number' },
        },
      },
    });

    const result = await scorer.score(makeInput(JSON.stringify({ age: 'thirty' })));
    expect(result.aggregateScore).toBe(0);
    expect(result.scores[0]!.reasoning).toContain('expected type');
  });

  it('detects array type mismatch correctly', async () => {
    const scorer = createJSONSchemaScorer({
      schema: {
        properties: {
          items: { type: 'array' },
        },
      },
    });

    // Pass a string instead of array
    const result = await scorer.score(makeInput(JSON.stringify({ items: 'not-array' })));
    expect(result.aggregateScore).toBe(0);
    expect(result.scores[0]!.reasoning).toContain('"array"');
  });

  it('passes when array type matches', async () => {
    const scorer = createJSONSchemaScorer({
      schema: {
        properties: {
          items: { type: 'array' },
        },
      },
    });

    const result = await scorer.score(makeInput(JSON.stringify({ items: [1, 2] })));
    expect(result.aggregateScore).toBe(1);
  });

  it('passes with no required fields and no properties', async () => {
    const scorer = createJSONSchemaScorer({ schema: {} });
    const result = await scorer.score(makeInput(JSON.stringify({ anything: true })));
    expect(result.aggregateScore).toBe(1);
  });

  it('uses custom id when provided', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'my-custom-id',
      schema: {},
    });
    expect(scorer.config.id).toBe('my-custom-id');
  });

  it('auto-generates id when not provided', async () => {
    const scorer = createJSONSchemaScorer({ schema: {} });
    expect(scorer.config.id).toMatch(/^json-schema-/);
  });

  it('ignores extra properties not in schema', async () => {
    const scorer = createJSONSchemaScorer({
      schema: {
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    });

    const result = await scorer.score(
      makeInput(JSON.stringify({ name: 'Alice', extra: 123, bonus: true })),
    );
    expect(result.aggregateScore).toBe(1);
  });

  it('reports durationMs', async () => {
    const scorer = createJSONSchemaScorer({ schema: {} });
    const result = await scorer.score(makeInput('{}'));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Keyword Scorer
// ---------------------------------------------------------------------------

describe('createKeywordScorer', () => {
  const makeInput = (output: string): EvalInput => ({
    input: 'test',
    output,
  });

  it('scores 1.0 when all required keywords are present', async () => {
    const scorer = createKeywordScorer({
      required: ['hello', 'world'],
    });

    const result = await scorer.score(makeInput('hello beautiful world'));
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('scores 0.0 when all required keywords are missing', async () => {
    const scorer = createKeywordScorer({
      required: ['foo', 'bar'],
    });

    const result = await scorer.score(makeInput('nothing here'));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('scores 0.5 when half the required keywords are present', async () => {
    const scorer = createKeywordScorer({
      required: ['hello', 'missing'],
    });

    const result = await scorer.score(makeInput('hello there'));
    expect(result.aggregateScore).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('scores 1.0 when no forbidden keywords are present', async () => {
    const scorer = createKeywordScorer({
      forbidden: ['error', 'fail'],
    });

    const result = await scorer.score(makeInput('success'));
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('scores 0.0 when all forbidden keywords are present', async () => {
    const scorer = createKeywordScorer({
      forbidden: ['error', 'fail'],
    });

    const result = await scorer.score(makeInput('error and fail'));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('combines required and forbidden scoring', async () => {
    const scorer = createKeywordScorer({
      required: ['good'],
      forbidden: ['bad'],
    });

    // good present (1), bad absent (1) -> 1.0
    const result1 = await scorer.score(makeInput('good output'));
    expect(result1.aggregateScore).toBe(1);

    // good present (1), bad present (0) -> 0.5
    const result2 = await scorer.score(makeInput('good but bad'));
    expect(result2.aggregateScore).toBe(0.5);

    // good missing (0), bad present (0) -> 0.0
    const result3 = await scorer.score(makeInput('bad output'));
    expect(result3.aggregateScore).toBe(0);
  });

  it('is case insensitive by default', async () => {
    const scorer = createKeywordScorer({
      required: ['Hello'],
    });

    const result = await scorer.score(makeInput('HELLO WORLD'));
    expect(result.aggregateScore).toBe(1);
  });

  it('respects caseSensitive option', async () => {
    const scorer = createKeywordScorer({
      required: ['Hello'],
      caseSensitive: true,
    });

    const result1 = await scorer.score(makeInput('Hello World'));
    expect(result1.aggregateScore).toBe(1);

    const result2 = await scorer.score(makeInput('hello world'));
    expect(result2.aggregateScore).toBe(0);
  });

  it('scores 1.0 when no keywords configured', async () => {
    const scorer = createKeywordScorer({});
    const result = await scorer.score(makeInput('anything'));
    expect(result.aggregateScore).toBe(1);
  });

  it('includes per-criterion breakdown in scores', async () => {
    const scorer = createKeywordScorer({
      required: ['yes'],
      forbidden: ['no'],
    });

    const result = await scorer.score(makeInput('yes and no'));
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]!.criterion).toBe('required:yes');
    expect(result.scores[0]!.score).toBe(1);
    expect(result.scores[1]!.criterion).toBe('forbidden:no');
    expect(result.scores[1]!.score).toBe(0);
  });

  it('uses custom id', async () => {
    const scorer = createKeywordScorer({ id: 'kw-test' });
    expect(scorer.config.id).toBe('kw-test');
  });
});

// ---------------------------------------------------------------------------
// Latency Scorer
// ---------------------------------------------------------------------------

describe('createLatencyScorer', () => {
  const makeInput = (latencyMs: number): EvalInput => ({
    input: 'test',
    output: 'response',
    latencyMs,
  });

  it('scores 1.0 when latency is at target', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput(100));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('scores 1.0 when latency is below target', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput(50));
    expect(result.aggregateScore).toBe(1.0);
  });

  it('scores 0.0 when latency exceeds max', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput(500));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('scores 0.0 when latency far exceeds max', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput(1000));
    expect(result.aggregateScore).toBe(0.0);
  });

  it('linearly interpolates between target and max', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score(makeInput(300));
    // 1 - (300 - 100) / (500 - 100) = 1 - 200/400 = 0.5
    expect(result.aggregateScore).toBe(0.5);
  });

  it('gives correct score at 75% of range', async () => {
    const scorer = createLatencyScorer({ targetMs: 0, maxMs: 1000 });
    const result = await scorer.score(makeInput(250));
    // 1 - 250/1000 = 0.75
    expect(result.aggregateScore).toBe(0.75);
  });

  it('defaults to 0 latency when not provided', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    const result = await scorer.score({ input: 'test', output: 'response' });
    expect(result.aggregateScore).toBe(1.0);
  });

  it('has correct scorer config', async () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    expect(scorer.config.name).toBe('latency');
    expect(scorer.config.type).toBe('deterministic');
    expect(scorer.config.description).toContain('100');
    expect(scorer.config.description).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// Cost Scorer
// ---------------------------------------------------------------------------

describe('createCostScorer', () => {
  const makeInput = (costCents: number): EvalInput => ({
    input: 'test',
    output: 'response',
    costCents,
  });

  it('scores 1.0 when cost is at target', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    const result = await scorer.score(makeInput(5));
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('scores 1.0 when cost is below target', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    const result = await scorer.score(makeInput(2));
    expect(result.aggregateScore).toBe(1.0);
  });

  it('scores 0.0 when cost exceeds max', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    const result = await scorer.score(makeInput(20));
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('linearly interpolates between target and max', async () => {
    const scorer = createCostScorer({ targetCents: 0, maxCents: 10 });
    const result = await scorer.score(makeInput(5));
    expect(result.aggregateScore).toBe(0.5);
  });

  it('defaults to 0 cost when not provided', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    const result = await scorer.score({ input: 'test', output: 'response' });
    expect(result.aggregateScore).toBe(1.0);
  });

  it('includes costCents in result', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    const result = await scorer.score(makeInput(3));
    expect(result.costCents).toBe(3);
  });

  it('has correct scorer config', async () => {
    const scorer = createCostScorer({ targetCents: 5, maxCents: 20 });
    expect(scorer.config.name).toBe('cost');
    expect(scorer.config.type).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// LLM Judge Enhanced
// ---------------------------------------------------------------------------

describe('createLLMJudge', () => {
  const makeInput = (output: string, reference?: string): EvalInput => ({
    input: 'What is 2+2?',
    output,
    reference,
  });

  it('scores using single string criteria', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'Good answer' },
      ]),
    );

    const judge = createLLMJudge({
      criteria: 'Is the answer correct?',
      llm,
    });

    const result = await judge.score(makeInput('4'));
    expect(result.aggregateScore).toBe(0.8);
    expect(result.passed).toBe(true);
    expect(result.scores).toHaveLength(1);
    expect(llm).toHaveBeenCalledOnce();
  });

  it('scores using multiple criteria with weights', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'relevance', score: 1.0, reasoning: 'On topic' },
        { criterion: 'accuracy', score: 0.5, reasoning: 'Partially correct' },
      ]),
    );

    const judge = createLLMJudge({
      criteria: [
        { name: 'relevance', description: 'Is it relevant?', weight: 1 },
        { name: 'accuracy', description: 'Is it accurate?', weight: 3 },
      ],
      llm,
    });

    const result = await judge.score(makeInput('4'));
    // Weighted: (1.0 * 1 + 0.5 * 3) / (1 + 3) = 2.5 / 4 = 0.625
    expect(result.aggregateScore).toBe(0.625);
  });

  it('clamps scores to [0, 1]', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 1.5, reasoning: 'Over max' },
      ]),
    );

    const judge = createLLMJudge({
      criteria: 'test',
      llm,
    });

    const result = await judge.score(makeInput('answer'));
    expect(result.scores[0]!.score).toBe(1.0);
  });

  it('clamps negative scores to 0', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: -0.5, reasoning: 'Under min' },
      ]),
    );

    const judge = createLLMJudge({ criteria: 'test', llm });
    const result = await judge.score(makeInput('answer'));
    expect(result.scores[0]!.score).toBe(0);
  });

  it('retries on parse failure', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce('garbage response')
      .mockResolvedValue(
        JSON.stringify([
          { criterion: 'overall', score: 0.7, reasoning: 'OK' },
        ]),
      );

    const judge = createLLMJudge({
      criteria: 'test',
      llm,
      maxRetries: 2,
    });

    const result = await judge.score(makeInput('answer'));
    expect(result.aggregateScore).toBe(0.7);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('returns zero scores after all retries fail', async () => {
    const llm = vi.fn().mockResolvedValue('not json at all');

    const judge = createLLMJudge({
      criteria: [
        { name: 'quality', description: 'test', weight: 1 },
      ],
      llm,
      maxRetries: 1,
    });

    const result = await judge.score(makeInput('answer'));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain('Failed');
  });

  it('handles LLM call errors and retries', async () => {
    const llm = vi.fn()
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValue(
        JSON.stringify([
          { criterion: 'overall', score: 0.9, reasoning: 'Great' },
        ]),
      );

    const judge = createLLMJudge({ criteria: 'test', llm, maxRetries: 2 });
    const result = await judge.score(makeInput('answer'));
    expect(result.aggregateScore).toBe(0.9);
  });

  it('handles total LLM failure', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('API down'));

    const judge = createLLMJudge({ criteria: 'test', llm, maxRetries: 0 });
    const result = await judge.score(makeInput('answer'));
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('includes reference in prompt when provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'OK' },
      ]),
    );

    const judge = createLLMJudge({ criteria: 'test', llm });
    await judge.score(makeInput('4', 'The answer is 4'));

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference: The answer is 4');
  });

  it('does not include reference when not provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'OK' },
      ]),
    );

    const judge = createLLMJudge({ criteria: 'test', llm });
    await judge.score(makeInput('4'));

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('Reference:');
  });

  it('uses custom prompt template', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.5, reasoning: 'OK' },
      ]),
    );

    const judge = createLLMJudge({
      criteria: 'custom check',
      llm,
      promptTemplate: 'CUSTOM: {{criteria}} | IN: {{input}} | OUT: {{output}}{{reference}}',
    });

    await judge.score(makeInput('answer'));
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('CUSTOM:');
    expect(prompt).toContain('IN: What is 2+2?');
    expect(prompt).toContain('OUT: answer');
  });

  it('pads missing criteria in response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'relevance', score: 0.9, reasoning: 'Good' },
        // 'accuracy' missing from response
      ]),
    );

    const judge = createLLMJudge({
      criteria: [
        { name: 'relevance', description: 'test', weight: 1 },
        { name: 'accuracy', description: 'test', weight: 1 },
      ],
      llm,
    });

    const result = await judge.score(makeInput('answer'));
    expect(result.scores).toHaveLength(2);
    // Missing criterion should be padded with score 0
    const accuracyScore = result.scores.find((s) => s.criterion === 'accuracy');
    expect(accuracyScore).toBeDefined();
    expect(accuracyScore!.score).toBe(0);
  });

  it('uses default threshold of 0.5 for pass', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.4, reasoning: 'Below threshold' },
      ]),
    );

    const judge = createLLMJudge({ criteria: 'test', llm });
    const result = await judge.score(makeInput('answer'));
    expect(result.passed).toBe(false);
  });

  it('extracts JSON from surrounding text', async () => {
    const llm = vi.fn().mockResolvedValue(
      'Here is my evaluation:\n' +
      JSON.stringify([{ criterion: 'overall', score: 0.75, reasoning: 'Decent' }]) +
      '\nThank you!',
    );

    const judge = createLLMJudge({ criteria: 'test', llm });
    const result = await judge.score(makeInput('answer'));
    expect(result.aggregateScore).toBe(0.75);
  });

  it('has correct scorer config type', () => {
    const judge = createLLMJudge({
      criteria: 'test',
      llm: async () => '[]',
    });
    expect(judge.config.type).toBe('llm-judge');
    expect(judge.config.name).toBe('llm-judge-enhanced');
  });
});

// ---------------------------------------------------------------------------
// Criteria constants
// ---------------------------------------------------------------------------

describe('criteria constants', () => {
  it('STANDARD_CRITERIA has expected structure', () => {
    expect(STANDARD_CRITERIA).toHaveLength(3);
    expect(STANDARD_CRITERIA.map((c) => c.name)).toEqual(['relevance', 'accuracy', 'completeness']);
    const totalWeight = STANDARD_CRITERIA.reduce((s, c) => s + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it('CODE_CRITERIA has expected structure', () => {
    expect(CODE_CRITERIA).toHaveLength(4);
    expect(CODE_CRITERIA.map((c) => c.name)).toEqual([
      'correctness', 'readability', 'efficiency', 'best-practices',
    ]);
    const totalWeight = CODE_CRITERIA.reduce((s, c) => s + (c.weight ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0);
  });

  it('rubric constants are strings', () => {
    expect(typeof FIVE_POINT_RUBRIC).toBe('string');
    expect(FIVE_POINT_RUBRIC).toContain('Excellent');
    expect(typeof TEN_POINT_RUBRIC).toBe('string');
    expect(TEN_POINT_RUBRIC).toContain('Excellent');
  });
});
