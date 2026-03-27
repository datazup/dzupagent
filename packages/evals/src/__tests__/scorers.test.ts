import { describe, it, expect, vi } from 'vitest';
import { DeterministicScorer } from '../deterministic-scorer.js';
import { LLMJudgeScorer } from '../llm-judge-scorer.js';
import { CompositeScorer } from '../composite-scorer.js';
import { runEvalSuite } from '../eval-runner.js';
import type { EvalScorer } from '../types.js';

describe('DeterministicScorer', () => {
  describe('exactMatch mode', () => {
    it('scores 1.0 for identical strings', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello world', 'hello world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 for different strings', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello', 'world');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('supports caseInsensitive matching', async () => {
      const scorer = new DeterministicScorer({
        mode: 'exactMatch',
        caseInsensitive: true,
      });
      const result = await scorer.score('input', 'Hello World', 'hello world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('returns 0.0 when no reference is provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'exactMatch' });
      const result = await scorer.score('input', 'hello');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });

  describe('contains mode', () => {
    it('scores 1.0 when substring is found', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('input', 'hello world foo', 'world');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when substring is not found', async () => {
      const scorer = new DeterministicScorer({ mode: 'contains' });
      const result = await scorer.score('input', 'hello world', 'xyz');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('supports caseInsensitive contains', async () => {
      const scorer = new DeterministicScorer({
        mode: 'contains',
        caseInsensitive: true,
      });
      const result = await scorer.score('input', 'Hello World', 'hello');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });
  });

  describe('regex mode', () => {
    it('scores 1.0 when pattern matches', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^\d{3}-\d{4}$/,
      });
      const result = await scorer.score('input', '123-4567');
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when pattern does not match', async () => {
      const scorer = new DeterministicScorer({
        mode: 'regex',
        pattern: /^\d{3}-\d{4}$/,
      });
      const result = await scorer.score('input', 'abc-defg');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });

    it('returns 0.0 when no pattern is provided', async () => {
      const scorer = new DeterministicScorer({ mode: 'regex' });
      const result = await scorer.score('input', 'anything');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });

  describe('jsonSchema mode', () => {
    it('scores 1.0 when JSON matches schema with required fields', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ name: 'Alice', age: 30 }),
      );
      expect(result.score).toBe(1.0);
      expect(result.pass).toBe(true);
    });

    it('scores 0.0 when required field is missing', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          required: ['name', 'age'],
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ name: 'Alice' }),
      );
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('age');
    });

    it('scores 0.0 for invalid JSON', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: { required: ['name'] },
      });
      const result = await scorer.score('input', 'not json at all');
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
      expect(result.reasoning).toContain('not valid JSON');
    });

    it('scores 0.0 when field type is wrong', async () => {
      const scorer = new DeterministicScorer({
        mode: 'jsonSchema',
        schema: {
          properties: {
            age: { type: 'number' },
          },
        },
      });
      const result = await scorer.score(
        'input',
        JSON.stringify({ age: 'thirty' }),
      );
      expect(result.score).toBe(0.0);
      expect(result.pass).toBe(false);
    });
  });
});

describe('LLMJudgeScorer', () => {
  it('calls LLM with formatted prompt and parses response', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.85, pass: true, reasoning: 'Well structured' }),
    );

    const scorer = new LLMJudgeScorer({
      llm,
      rubric: 'Check for clarity',
    });

    const result = await scorer.score('What is 2+2?', '4');
    expect(result.score).toBe(0.85);
    expect(result.pass).toBe(true);
    expect(result.reasoning).toBe('Well structured');

    expect(llm).toHaveBeenCalledOnce();
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Check for clarity');
    expect(prompt).toContain('What is 2+2?');
    expect(prompt).toContain('4');
  });

  it('includes reference in prompt when provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.9, pass: true, reasoning: 'Good' }),
    );

    const scorer = new LLMJudgeScorer({
      llm,
      rubric: 'Accuracy',
    });

    await scorer.score('question', 'answer', 'expected answer');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference: expected answer');
  });

  it('does not include reference line when reference is not provided', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 0.5, pass: true, reasoning: 'OK' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    await scorer.score('input', 'output');

    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('Reference:');
  });

  it('handles LLM parse failure gracefully with score 0.0', async () => {
    const llm = vi.fn().mockResolvedValue('not valid json at all');

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(0.0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toBe('Failed to parse LLM response');
  });

  it('handles LLM call failure gracefully', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('API error'));

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(0.0);
    expect(result.pass).toBe(false);
    expect(result.reasoning).toBe('Failed to call LLM');
  });

  it('clamps score to [0, 1] range', async () => {
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({ score: 1.5, pass: true, reasoning: 'Over' }),
    );

    const scorer = new LLMJudgeScorer({ llm, rubric: 'test' });
    const result = await scorer.score('input', 'output');

    expect(result.score).toBe(1.0);
  });
});

describe('CompositeScorer', () => {
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

  it('computes weighted average of two scorers', async () => {
    const s1 = makeScorer('s1', 1.0);
    const s2 = makeScorer('s2', 0.0);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.5);
  });

  it('normalizes weights', async () => {
    const s1 = makeScorer('s1', 1.0);
    const s2 = makeScorer('s2', 0.0);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 3 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    // (1.0 * 3 + 0.0 * 1) / 4 = 0.75
    expect(result.score).toBeCloseTo(0.75);
  });

  it('runs scorers in parallel', async () => {
    const slowScorer: EvalScorer = {
      name: 'slow',
      score: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { score: 1.0, pass: true, reasoning: 'slow done' };
      },
    };
    const fastScorer: EvalScorer = {
      name: 'fast',
      score: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { score: 0.8, pass: true, reasoning: 'fast done' };
      },
    };

    const composite = new CompositeScorer({
      scorers: [
        { scorer: slowScorer, weight: 1 },
        { scorer: fastScorer, weight: 1 },
      ],
    });

    const start = Date.now();
    await composite.score('input', 'output');
    const elapsed = Date.now() - start;

    // If run in parallel, total time should be ~50ms, not ~100ms
    expect(elapsed).toBeLessThan(120);
  });

  it('combines reasoning from all scorers', async () => {
    const s1 = makeScorer('accuracy', 0.9);
    const s2 = makeScorer('clarity', 0.7);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.reasoning).toContain('accuracy');
    expect(result.reasoning).toContain('clarity');
  });

  it('pass is based on 0.5 threshold', async () => {
    const s1 = makeScorer('s1', 0.3);
    const s2 = makeScorer('s2', 0.2);

    const scorer = new CompositeScorer({
      scorers: [
        { scorer: s1, weight: 1 },
        { scorer: s2, weight: 1 },
      ],
    });

    const result = await scorer.score('input', 'output');
    expect(result.score).toBeCloseTo(0.25);
    expect(result.pass).toBe(false);
  });

  it('handles empty scorers array', async () => {
    const scorer = new CompositeScorer({ scorers: [] });
    const result = await scorer.score('input', 'output');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });
});

describe('runEvalSuite', () => {
  it('runs a suite and computes aggregate results', async () => {
    const scorer = new DeterministicScorer({ mode: 'exactMatch' });

    const result = await runEvalSuite(
      {
        name: 'test-suite',
        cases: [
          { id: 'c1', input: 'hello', expectedOutput: 'HELLO' },
          { id: 'c2', input: 'world', expectedOutput: 'WORLD' },
        ],
        scorers: [scorer],
        passThreshold: 0.5,
      },
      async (input: string) => input.toUpperCase(),
    );

    expect(result.suiteId).toBe('test-suite');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.pass).toBe(true);
    expect(result.results[1]!.pass).toBe(true);
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passRate).toBe(1.0);
  });

  it('handles partial pass rate', async () => {
    const scorer = new DeterministicScorer({ mode: 'exactMatch' });

    const result = await runEvalSuite(
      {
        name: 'partial-suite',
        cases: [
          { id: 'c1', input: 'hello', expectedOutput: 'hello' },
          { id: 'c2', input: 'world', expectedOutput: 'WRONG' },
        ],
        scorers: [scorer],
        passThreshold: 0.5,
      },
      async (input: string) => input,
    );

    expect(result.passRate).toBe(0.5);
    expect(result.aggregateScore).toBe(0.5);
  });
});
