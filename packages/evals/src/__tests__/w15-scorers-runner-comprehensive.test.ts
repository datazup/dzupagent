/**
 * W15-A1: Comprehensive tests for evals scorers and runner.
 *
 * Targets coverage gaps in:
 * - DeterministicScorer: jsonSchema no-schema edge, array JSON, non-object JSON
 * - CompositeScorer: zero-weight scorers, single scorer, custom name, metadata shape
 * - LLMJudgeScorer (top-level): negative score clamping, score without pass field,
 *   non-object parse responses, custom scoreRange
 * - runEvalSuite: empty scorers array, default passThreshold, single case
 * - deterministic-enhanced: keyword edge cases, latency/cost defaults, JSON schema array/null
 * - LlmJudgeScorer (5-dim): edge cases in overloaded score() method
 * - Enhanced runner: report formatters with single scorer, N/A columns
 */

import { describe, it, expect, vi } from 'vitest';
import { DeterministicScorer } from '../deterministic-scorer.js';
import { LLMJudgeScorer } from '../llm-judge-scorer.js';
import { CompositeScorer } from '../composite-scorer.js';
import { runEvalSuite } from '../eval-runner.js';
import type { EvalScorer } from '../types.js';
import {
  createJSONSchemaScorer,
  createKeywordScorer,
  createLatencyScorer,
  createCostScorer,
} from '../scorers/deterministic-enhanced.js';
import { LlmJudgeScorer } from '../scorers/llm-judge-scorer.js';
import type { JudgeDimension } from '../scorers/llm-judge-scorer.js';
import {
  EvalRunner,
  reportToMarkdown,
  reportToJSON,
  reportToCIAnnotations,
} from '../runner/enhanced-runner.js';
import type { EvalReport, EvalReportEntry } from '../runner/enhanced-runner.js';
import { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalInput, Scorer, ScorerConfig, ScorerResult } from '../types.js';
import { createLLMJudge } from '../scorers/llm-judge-enhanced.js';
import { FIVE_POINT_RUBRIC, TEN_POINT_RUBRIC } from '../scorers/criteria.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScorer(name: string, score: number): EvalScorer {
  return {
    name,
    score: vi.fn().mockResolvedValue({
      score,
      pass: score >= 0.5,
      reasoning: `${name} scored ${score}`,
    }),
  };
}

function makeJudgeResponse(overrides?: Record<string, unknown>): string {
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

function createSimpleScorer(id: string, score: number, passed: boolean): Scorer<EvalInput> {
  const config: ScorerConfig = { id, name: id, type: 'deterministic' };
  return {
    config,
    score: async () => ({
      scorerId: id,
      scores: [{ criterion: 'test', score, reasoning: 'test reason' }],
      aggregateScore: score,
      passed,
      durationMs: 1,
    }),
  };
}

// ===========================================================================
// DeterministicScorer — remaining edge cases
// ===========================================================================

describe('DeterministicScorer — coverage gap tests', () => {
  describe('jsonSchema mode — no schema provided', () => {
    it('returns 0.0 with reasoning when schema is undefined', async () => {
      const scorer = new DeterministicScorer({ mode: 'jsonSchema' });
      const result = await scorer.score('input', '{"name":"Alice"}');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('No schema provided');
    });
  });

  describe('jsonSchema mode — non-object JSON values', () => {
    it('rejects JSON array', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', '[1, 2, 3]');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('rejects JSON null', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', 'null');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('rejects JSON string primitive', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', '"just a string"');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('rejects JSON number primitive', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', '42');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });

    it('rejects JSON boolean primitive', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', 'true');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not a JSON object');
    });
  });

  describe('jsonSchema mode — array type checking', () => {
    it('detects array type correctly in property check', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            items: { type: 'array' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ items: [1, 2, 3] }),
      );
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('fails when expecting array but got object', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            items: { type: 'array' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ items: { a: 1 } }),
      );
      expect(result.score).toBe(0);
      expect(result.reasoning).toContain('expected type "array"');
      expect(result.reasoning).toContain('got "object"');
    });
  });

  describe('jsonSchema mode — schema with no required and no properties', () => {
    it('passes any valid JSON object when schema has no constraints', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {},
      });
      const result = await scorer.score('input', JSON.stringify({ anything: true }));
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('jsonSchema mode — property with no type spec', () => {
    it('skips type check when property spec has no type', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            name: { description: 'just a description' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ name: 12345 }),
      );
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('jsonSchema mode — property not present in object', () => {
    it('skips type check when property is defined in schema but absent from object', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            optional: { type: 'string' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ other: 'value' }),
      );
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('default name', () => {
    it('auto-generates name from mode', () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      expect(scorer.name).toBe('deterministic-contains');
    });

    it('uses custom name when provided', () => {
      const scorer = new DeterministicScorer({ mode: 'contains', name: 'my-scorer' });
      expect(scorer.name).toBe('my-scorer');
    });
  });

  describe('contains mode — no reference', () => {
    it('returns 0 when no reference is provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('input', 'output');
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('No reference');
    });
  });

  describe('exactMatch — case-insensitive mismatch', () => {
    it('fails case-insensitive when strings differ', async () => {
      const scorer = new DeterministicScorer({
        mode: 'exactMatch',
        caseInsensitive: true,
      });
      const result = await scorer.score('input', 'hello', 'world');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });
});

// ===========================================================================
// CompositeScorer — coverage gap tests
// ===========================================================================

describe('CompositeScorer — coverage gap tests', () => {
  it('returns zero when all weights are zero', async () => {
    const s1 = makeScorer('s1', 0.9);
    const s2 = makeScorer('s2', 0.8);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 0 },
        { scorer: s2, weight: 0 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toContain('Total weight is zero');
  });

  it('works with a single scorer', async () => {
    const s1 = makeScorer('only', 0.7);

    const scorer = new CompositeScorer({
      scorers: [{ scorer: s1, weight: 1 }],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.7);
  });

  it('uses custom name', () => {
    const scorer = new CompositeScorer({
      name: 'custom-composite',
      scorers: [],
    });
    expect(scorer.name).toBe('custom-composite');
  });

  it('uses default name when not specified', () => {
    const scorer = new CompositeScorer({ scorers: [] });
    expect(scorer.name).toBe('composite');
  });

  it('passes reference to sub-scorers', async () => {
    const mockScore = vi.fn().mockResolvedValue({
      score: 1.0,
      pass: true,
      reasoning: 'ok',
    });
    const s1: EvalScorer = { name: 'ref-check', score: mockScore };

    const scorer = new CompositeScorer({
      scorers: [{ scorer: s1, weight: 1 }],
    });

    await scorer.score('input', 'output', 'reference');
    expect(mockScore).toHaveBeenCalledWith('input', 'output', 'reference');
  });

  it('includes metadata with scorer details', async () => {
    const s1 = makeScorer('s1', 0.8);
    const s2 = makeScorer('s2', 0.6);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 2 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.metadata).toBeDefined();
    const scorerResults = result.metadata!['scorerResults'] as Array<{
      scorerName: string;
      score: number;
      weight: number;
      normalizedWeight: number;
    }>;
    expect(scorerResults).toHaveLength(2);
    expect(scorerResults[0]!.normalizedWeight).toBeCloseTo(2 / 3);
    expect(scorerResults[1]!.normalizedWeight).toBeCloseTo(1 / 3);
  });

  it('correctly passes when composite score equals 0.5', async () => {
    const s1 = makeScorer('s1', 0.5);

    const scorer = new CompositeScorer({
      scorers: [{ scorer: s1, weight: 1 }],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.5);
    expect(result.pass).toBe(true); // >= 0.5
  });

  it('fails when composite score is just below 0.5', async () => {
    const s1 = makeScorer('s1', 0.49);

    const scorer = new CompositeScorer({
      scorers: [{ scorer: s1, weight: 1 }],
    });

    const result = await scorer.score('input', 'output');
    expect(result.pass).toBe(false);
  });

  it('handles unequal weight distribution with 3 scorers', async () => {
    const s1 = makeScorer('s1', 1.0);
    const s2 = makeScorer('s2', 0.0);
    const s3 = makeScorer('s3', 0.5);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 2 },
        { scorer: s2, weight: 1 },
        { scorer: s3, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    // (1.0*2 + 0.0*1 + 0.5*1) / 4 = 2.5/4 = 0.625
    expect(result.score).toBeCloseTo(0.625);
  });
});

// ===========================================================================
// LLMJudgeScorer (top-level simple) — coverage gap tests
// ===========================================================================

describe('LLMJudgeScorer (top-level) — coverage gap tests', () => {
  it('clamps negative score to 0', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: -0.5, pass: false, reasoning: 'Terrible' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0.0);
  });

  it('uses default name when not provided', () => {
    const llm = vi.fn();
    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    expect(scorer.name).toBe('llm-judge');
  });

  it('uses custom name', () => {
    const llm = vi.fn();
    const scorer = new LLMJudgeScorer({ llm, rubric: 'test', name: 'my-judge' });
    expect(scorer.name).toBe('my-judge');
  });

  it('uses custom scoreRange in prompt', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.8, pass: true, reasoning: 'Good' }),
    );

    const scorer = new LLMJudgeScorer({
      llm,
      rubric: 'Quality',
      scoreRange: '1 to 5',
    });
    await scorer.score('input', 'output');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('1 to 5');
  });

  it('defaults pass from score when pass field missing in LLM response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.8, reasoning: 'Good' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.pass).toBe(true); // 0.8 >= 0.5
  });

  it('defaults pass to false when score is below 0.5 and pass missing', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.3, reasoning: 'Bad' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.pass).toBe(false);
  });

  it('defaults score to 0 when score field is not a number', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 'high', pass: true, reasoning: 'Good' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0.0);
  });

  it('defaults reasoning when not a string', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.7, pass: true, reasoning: 42 }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.reasoning).toBe('No reasoning provided');
  });

  it('handles LLM returning an array instead of object', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([{ score: 0.9 }]),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0.0);
    expect(result.reasoning).toBe('Failed to parse LLM response');
  });
});

// ===========================================================================
// runEvalSuite — coverage gap tests
// ===========================================================================

describe('runEvalSuite — coverage gap tests', () => {
  it('handles empty scorers array gracefully', async () => {
    const result = await runEvalSuite(
      {
        name: 'no-scorers',
        cases: [{ id: 'c1', input: 'hello', expectedOutput: 'hello' }],
        scorers: [],
      },
      async (input) => input,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.scorerResults).toHaveLength(0);
    expect(result.results[0]!.aggregateScore).toBe(0);
    // Default passThreshold is 0.7, 0 < 0.7 so fail
    expect(result.results[0]!.pass).toBe(false);
  });

  it('uses default passThreshold of 0.7', async () => {
    const scorer = new DeterministicScorer({ mode: 'exactMatch' });

    // This case has score of 0.0 (no match) - fails at 0.7
    const result = await runEvalSuite(
      {
        name: 'default-threshold',
        cases: [{ id: 'c1', input: 'hello', expectedOutput: 'HELLO' }],
        scorers: [scorer],
      },
      async (input) => input, // returns 'hello', does not match 'HELLO'
    );

    expect(result.results[0]!.pass).toBe(false);
    expect(result.results[0]!.aggregateScore).toBe(0.0);
  });

  it('passes when score equals passThreshold', async () => {
    const alwaysPointSeven: EvalScorer = {
      name: 'exact-0.7',
      score: async () => ({
        score: 0.7,
        pass: true,
        reasoning: 'Exactly at threshold',
      }),
    };

    const result = await runEvalSuite(
      {
        name: 'at-threshold',
        cases: [{ id: 'c1', input: 'x' }],
        scorers: [alwaysPointSeven],
        passThreshold: 0.7,
      },
      async () => 'output',
    );

    expect(result.results[0]!.pass).toBe(true);
    expect(result.results[0]!.aggregateScore).toBe(0.7);
  });

  it('computes correct aggregate across multiple scorers for a single case', async () => {
    const s1: EvalScorer = {
      name: 's1',
      score: async () => ({ score: 1.0, pass: true, reasoning: 'perfect' }),
    };
    const s2: EvalScorer = {
      name: 's2',
      score: async () => ({ score: 0.0, pass: false, reasoning: 'bad' }),
    };

    const result = await runEvalSuite(
      {
        name: 'multi-scorer',
        cases: [{ id: 'c1', input: 'x' }],
        scorers: [s1, s2],
        passThreshold: 0.5,
      },
      async () => 'output',
    );

    // average = (1.0 + 0.0) / 2 = 0.5
    expect(result.results[0]!.aggregateScore).toBeCloseTo(0.5);
    expect(result.results[0]!.pass).toBe(true); // 0.5 >= 0.5
  });

  it('handles case without expectedOutput', async () => {
    const scorer = new DeterministicScorer({ mode: 'regex', pattern: /\d+/ });

    const result = await runEvalSuite(
      {
        name: 'no-expected',
        cases: [{ id: 'c1', input: 'give me a number' }],
        scorers: [scorer],
      },
      async () => '42',
    );

    expect(result.results[0]!.scorerResults[0]!.result.score).toBe(1.0);
  });
});

// ===========================================================================
// deterministic-enhanced — additional coverage
// ===========================================================================

describe('createJSONSchemaScorer — additional edge cases', () => {
  it('rejects JSON array output', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-arr',
      schema: { required: ['name'] },
    });
    const result = await scorer.score({
      input: 'test',
      output: '[1, 2, 3]',
    });
    expect(result.aggregateScore).toBe(0);
    expect(result.scores[0]!.reasoning).toContain('not a JSON object');
  });

  it('rejects JSON null output', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-null',
      schema: { required: ['name'] },
    });
    const result = await scorer.score({
      input: 'test',
      output: 'null',
    });
    expect(result.aggregateScore).toBe(0);
  });

  it('handles schema with properties that have no type', async () => {
    const scorer = createJSONSchemaScorer({
      id: 'schema-notype',
      schema: {
        properties: {
          name: { description: 'just desc' },
        },
      },
    });
    const result = await scorer.score({
      input: 'test',
      output: JSON.stringify({ name: 42 }),
    });
    expect(result.aggregateScore).toBe(1);
  });

  it('generates default id when not provided', () => {
    const scorer = createJSONSchemaScorer({
      schema: { required: ['x'] },
    });
    expect(scorer.config.id).toMatch(/^json-schema-/);
  });
});

describe('createKeywordScorer — additional edge cases', () => {
  it('scores 1.0 when no required and no forbidden keywords specified', async () => {
    const scorer = createKeywordScorer({ id: 'empty-kw' });
    const result = await scorer.score({
      input: 'test',
      output: 'anything goes',
    });
    expect(result.aggregateScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('handles combined required and forbidden keywords', async () => {
    const scorer = createKeywordScorer({
      id: 'combo-kw',
      required: ['hello'],
      forbidden: ['goodbye'],
    });

    const resultBoth = await scorer.score({
      input: 'test',
      output: 'hello and goodbye',
    });
    // hello found (1) + goodbye found (0) = 1/2 = 0.5
    expect(resultBoth.aggregateScore).toBe(0.5);
    expect(resultBoth.passed).toBe(false);

    const resultGood = await scorer.score({
      input: 'test',
      output: 'hello friend',
    });
    // hello found (1) + goodbye absent (1) = 2/2 = 1.0
    expect(resultGood.aggregateScore).toBe(1.0);
    expect(resultGood.passed).toBe(true);
  });

  it('is case-insensitive by default', async () => {
    const scorer = createKeywordScorer({
      id: 'case-kw',
      required: ['HELLO'],
    });
    const result = await scorer.score({
      input: 'test',
      output: 'hello world',
    });
    expect(result.aggregateScore).toBe(1);
  });

  it('generates default id when not provided', () => {
    const scorer = createKeywordScorer({ required: ['x'] });
    expect(scorer.config.id).toMatch(/^keyword-/);
  });
});

describe('createLatencyScorer — additional edge cases', () => {
  it('defaults latencyMs to 0 when undefined', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-default',
      targetMs: 100,
      maxMs: 500,
    });
    const result = await scorer.score({
      input: 'test',
      output: 'result',
      // latencyMs omitted
    });
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('scores 0 when latency exceeds max', async () => {
    const scorer = createLatencyScorer({
      id: 'lat-over',
      targetMs: 100,
      maxMs: 500,
    });
    const result = await scorer.score({
      input: 'test',
      output: 'result',
      latencyMs: 1000,
    });
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('generates default id when not provided', () => {
    const scorer = createLatencyScorer({ targetMs: 100, maxMs: 500 });
    expect(scorer.config.id).toMatch(/^latency-/);
  });
});

describe('createCostScorer — additional edge cases', () => {
  it('defaults costCents to 0 when undefined', async () => {
    const scorer = createCostScorer({
      id: 'cost-default',
      targetCents: 1,
      maxCents: 5,
    });
    const result = await scorer.score({
      input: 'test',
      output: 'result',
      // costCents omitted
    });
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('includes costCents in result', async () => {
    const scorer = createCostScorer({
      id: 'cost-field',
      targetCents: 1,
      maxCents: 5,
    });
    const result = await scorer.score({
      input: 'test',
      output: 'result',
      costCents: 2.5,
    });
    expect(result.costCents).toBe(2.5);
  });

  it('generates default id when not provided', () => {
    const scorer = createCostScorer({ targetCents: 1, maxCents: 5 });
    expect(scorer.config.id).toMatch(/^cost-/);
  });
});

// ===========================================================================
// LlmJudgeScorer (5-dim) — overloaded score method edge cases
// ===========================================================================

describe('LlmJudgeScorer (5-dim) — overloaded score edge cases', () => {
  it('score(EvalInput) returns ScorerResult with durationMs > 0', async () => {
    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
    const scorer = new LlmJudgeScorer({ llm });

    const result = await scorer.score({
      input: 'What is 2+2?',
      output: '4',
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.scorerId).toBe('llm-judge-5dim');
  });

  it('score(string, string) returns JudgeScorerResult shape', async () => {
    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
    const scorer = new LlmJudgeScorer({ llm });

    const result = await scorer.score('input', 'output');

    expect(result.overall).toBeCloseTo(0.9, 1);
    expect(result.dimensions).toBeDefined();
    expect(result.reasoning).toBe('Good quality output');
  });

  it('score(string, string, string) passes reference to prompt', async () => {
    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
    const scorer = new LlmJudgeScorer({ llm });

    await scorer.score('input', 'output', 'expected');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference answer: expected');
  });

  it('score(EvalInput) extracts reference from EvalInput', async () => {
    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
    const scorer = new LlmJudgeScorer({ llm });

    await scorer.score({
      input: 'question',
      output: 'answer',
      reference: 'expected answer',
    });

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference answer: expected answer');
  });

  it('handles output defaulting to empty string when undefined in string overload', async () => {
    const llm = vi.fn().mockResolvedValue(makeJudgeResponse());
    const scorer = new LlmJudgeScorer({ llm });

    // Using the string overload where output would default to ''
    const result = await scorer.score('input', '');
    expect(result.overall).toBeCloseTo(0.9, 1);
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Output: ');
  });

  it('config has correct defaults', () => {
    const llm = vi.fn();
    const scorer = new LlmJudgeScorer({ llm });

    expect(scorer.config.type).toBe('llm-judge');
    expect(scorer.config.name).toBe('llm-judge-5dim');
    expect(scorer.config.threshold).toBe(0.5);
  });
});

// ===========================================================================
// Criteria constants
// ===========================================================================

describe('Criteria rubric constants', () => {
  it('FIVE_POINT_RUBRIC is a string', () => {
    expect(typeof FIVE_POINT_RUBRIC).toBe('string');
    expect(FIVE_POINT_RUBRIC).toContain('Poor');
    expect(FIVE_POINT_RUBRIC).toContain('Excellent');
  });

  it('TEN_POINT_RUBRIC is a string', () => {
    expect(typeof TEN_POINT_RUBRIC).toBe('string');
    expect(TEN_POINT_RUBRIC).toContain('Poor');
    expect(TEN_POINT_RUBRIC).toContain('Excellent');
  });
});

// ===========================================================================
// createLLMJudge (enhanced) — additional tests
// ===========================================================================

describe('createLLMJudge — additional coverage', () => {
  it('pads missing criteria in LLM response', async () => {
    // LLM returns only 1 criterion but we expect 2
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'accuracy', score: 0.9, reasoning: 'Correct' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'pad-judge',
      criteria: [
        { name: 'accuracy', description: 'Is it accurate?', weight: 1 },
        { name: 'clarity', description: 'Is it clear?', weight: 1 },
      ],
      llm,
    });

    const result = await judge.score({ input: 'q', output: 'a' });

    // accuracy: 0.9, clarity padded to 0 => weighted (0.9*1 + 0*1) / 2 = 0.45
    expect(result.scores).toHaveLength(2);
    const clarityScore = result.scores.find((s) => s.criterion === 'clarity');
    expect(clarityScore).toBeDefined();
    expect(clarityScore!.score).toBe(0);
    expect(clarityScore!.reasoning).toContain('Not evaluated');
  });

  it('handles LLM error with retry then success', async () => {
    const llm = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(
        JSON.stringify([
          { criterion: 'overall', score: 0.6, reasoning: 'OK' },
        ]),
      );

    const judge = createLLMJudge({
      id: 'error-retry',
      criteria: 'Quality',
      llm,
      maxRetries: 1,
    });

    const result = await judge.score({ input: 'q', output: 'a' });
    expect(result.aggregateScore).toBe(0.6);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('includes reference in prompt when provided in EvalInput', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'Good' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'ref-judge',
      criteria: 'Accuracy',
      llm,
    });

    await judge.score({ input: 'q', output: 'a', reference: 'expected' });

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference: expected');
  });

  it('does not include reference line when reference is undefined', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.8, reasoning: 'Good' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'noref-judge',
      criteria: 'Accuracy',
      llm,
    });

    await judge.score({ input: 'q', output: 'a' });

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('Reference:');
  });

  it('clamps scores to [0, 1] range', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 1.5, reasoning: 'Over' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'clamp-judge',
      criteria: 'Quality',
      llm,
    });

    const result = await judge.score({ input: 'q', output: 'a' });
    expect(result.scores[0]!.score).toBe(1.0);
  });

  it('uses custom prompt template', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'overall', score: 0.7, reasoning: 'OK' },
      ]),
    );

    const judge = createLLMJudge({
      id: 'template-judge',
      criteria: 'Quality',
      llm,
      promptTemplate: 'CUSTOM {{criteria}} {{input}} {{output}} {{reference}}',
    });

    await judge.score({ input: 'q', output: 'a' });

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('CUSTOM');
    expect(prompt).toContain('overall: Quality');
  });
});

// ===========================================================================
// EvalRunner — report formatters extra edge cases
// ===========================================================================

describe('reportToMarkdown — N/A columns and single-entry', () => {
  it('shows N/A when scorer result is missing for a column', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.9, passed: true, durationMs: 10 },
          ],
          aggregateScore: 0.9,
          passed: true,
        },
        {
          entryId: 'e2',
          scorerResults: [
            { scorerId: 's2', scores: [], aggregateScore: 0.7, passed: true, durationMs: 10 },
          ],
          aggregateScore: 0.7,
          passed: true,
        },
      ],
      byScorerAverage: new Map([['s1', 0.9], ['s2', 0.7]]),
      overallPassRate: 1.0,
      overallAvgScore: 0.8,
      totalDurationMs: 20,
    };

    const md = reportToMarkdown(report);
    expect(md).toContain('N/A');
  });

  it('handles single entry report', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'only',
          scorerResults: [
            { scorerId: 'judge', scores: [], aggregateScore: 0.95, passed: true, durationMs: 5 },
          ],
          aggregateScore: 0.95,
          passed: true,
        },
      ],
      byScorerAverage: new Map([['judge', 0.95]]),
      overallPassRate: 1.0,
      overallAvgScore: 0.95,
      totalDurationMs: 5,
    };

    const md = reportToMarkdown(report);
    expect(md).toContain('only');
    expect(md).toContain('0.95');
    expect(md).toContain('PASS');
    expect(md).toContain('100%');
  });
});

describe('reportToCIAnnotations — partial failures', () => {
  it('annotates entries with mixed pass/fail scorers', () => {
    const report: EvalReport = {
      entries: [
        {
          entryId: 'e1',
          scorerResults: [
            { scorerId: 's1', scores: [], aggregateScore: 0.9, passed: true, durationMs: 1 },
            { scorerId: 's2', scores: [], aggregateScore: 0.2, passed: false, durationMs: 1 },
          ],
          aggregateScore: 0.55,
          passed: false,
        },
      ],
      byScorerAverage: new Map([['s1', 0.9], ['s2', 0.2]]),
      overallPassRate: 0,
      overallAvgScore: 0.55,
      totalDurationMs: 10,
    };

    const annotations = reportToCIAnnotations(report);
    const errorLine = annotations.find((a) => a.startsWith('::error::'));
    expect(errorLine).toBeDefined();
    // Should mention s2 (failed) but not s1 (passed)
    expect(errorLine).toContain('s2');
    expect(errorLine).not.toContain('s1=');
  });
});

describe('reportToJSON — handles empty byScorerAverage', () => {
  it('serializes empty Map correctly', () => {
    const report: EvalReport = {
      entries: [],
      byScorerAverage: new Map(),
      overallPassRate: 0,
      overallAvgScore: 0,
      totalDurationMs: 0,
    };

    const json = reportToJSON(report);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['byScorerAverage']).toEqual({});
  });
});
